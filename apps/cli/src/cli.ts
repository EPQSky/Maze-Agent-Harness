#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  redactionSensitiveValues,
  RuntimeBackupManager,
  sensitiveEnvironmentValues,
  type SensitiveEnvironmentValueSet,
} from "@maze-arena/backup";
import {
  createMatchProfileConfiguration,
  MATCH_OUTPUT_LIMIT_BYTES,
  type MatchPluginRole,
  type MatchProtocolRequest,
  type MatchProtocolResponse,
  type ModelProfileInput,
  type RealDshCanaryReport,
  type RealDshCanaryRequest,
  REAL_DSH_CANARY_MAX_COST,
  REAL_DSH_CANARY_MAX_TOKENS,
} from "@maze-arena/contracts";
import {
  createHarnessNetworkSeccompProgram,
  credentialEnvironmentNameFromReference,
  credentialEnvironmentNameIssue,
  hashHarnessRuntimePayload,
  parseHarnessModelCatalog,
  runIsolatedHarnessCommand,
} from "@maze-arena/dsh-integration";

const requirements = {
  node: { minimum: "22.12.0", maximumExclusive: "23.0.0" },
  pnpm: { exact: "10.15.0" },
  git: { minimum: "2.39.0" },
  docker: { minimum: "24.0.0" },
} as const;

interface RuntimePaths {
  configRoot: string;
  environmentFile: string;
  dataRoot: string;
  stateRoot: string;
  manifest: string;
  protectedDirectories: string[];
  runtime: string;
  logs: string;
  processState: string;
  processLock: string;
  harnessRuntimes: string;
  backups: string;
  canaryReports: string;
}

interface ProcessState {
  schemaVersion: 1;
  pid: number;
  procStartTime: string;
  instanceId: string;
  port: number;
  startedAt: string;
  databasePath: string;
  harnessPackage: string;
  harnessPackageVersion: string;
  harnessVersion: string;
  harnessExecutablePath: string;
  harnessExecutableSha256: string;
  harnessRuntimeRoot: string;
  harnessRuntimePayloadSha256: string;
  harnessAdapterPath: string;
  harnessAdapterSha256: string;
  modelCatalogRelease: string;
  modelReleaseRoot: string;
  modelReleaseSha256: string;
  modelCatalogPath: string;
  modelExportPath: string;
  modelSettingsPath: string;
  imageDigest: string;
  logPath: string;
}

interface StartupHandshake {
  schemaVersion: 1;
  phase: "ready";
  instanceId: string;
  pid: number;
  port: number;
}

interface StartupConfirmation {
  schemaVersion: 1;
  phase: "commit" | "committed";
  instanceId: string;
  pid: number;
  port: number;
}

interface InstallManifest {
  schemaVersion: 1;
  requirements: typeof requirements;
  directories: {
    config: string;
    data: string;
    state: string;
  };
  harness: {
    packageName: "@deepseek-ai/dsh";
    packageVersion: string;
    executable: {
      path: string;
      runtimeRoot: string;
      payloadSha256: string;
      sha256: string;
      version: string;
    };
    adapter: {
      path: string;
      sha256: string;
      protocolVersion: 1;
    };
  };
  isolation: {
    bubblewrap: { path: string; version: string };
  };
  matchProfile?: {
    imageId: string;
    imageReference: string;
    projectArtifactSha256: string;
    harnessPackage: string;
    harnessPackageVersion: string;
    harnessRuntimePayloadSha256: string;
    dshExecutableSha256: string;
    resourcePolicy: typeof matchProfilePolicy;
  };
}

interface HarnessRuntimePackage {
  name: string;
  root: string;
  executable: string;
}

interface ValidatedDoctorContext {
  manifest: InstallManifest;
  catalog: ReturnType<typeof validateModelCatalog>;
  build: ReturnType<typeof validateProductionBuild>;
  runtimeEnvironment: NodeJS.ProcessEnv;
  sensitiveValues: SensitiveEnvironmentValueSet;
}

const matchProfilePolicy = {
  network: "none",
  readOnlyRootFilesystem: true,
  user: "65532:65532",
  memory: "128m",
  memorySwap: "128m",
  cpus: "1",
  cpuUlimit: "2:2",
  pidsLimit: 64,
  noNewPrivileges: true,
  capabilities: "ALL",
} as const;

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const imageNameSegmentPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const registrySegmentPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/;
const unshareExecutable = "/usr/bin/unshare";
const bubblewrapExecutable = "/usr/bin/bwrap";

class CliError extends Error {}

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));

function canonicalizeFuturePath(path: string): string {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missingSegments);
}

function isInsideRepository(path: string): boolean {
  const relation = relative(repositoryRoot, path);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function runtimePaths(environment: NodeJS.ProcessEnv): RuntimePaths {
  const xdgNames = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;
  for (const name of xdgNames) {
    const value = environment[name];
    if (value && !isAbsolute(value)) throw new CliError(`${name} 必须是绝对路径：${value}`);
  }
  const home = environment.HOME || homedir();
  if (xdgNames.some((name) => !environment[name])) {
    if (!home) throw new CliError("无法确定用户主目录");
    if (!isAbsolute(home)) throw new CliError(`HOME 必须是绝对路径：${home}`);
  }
  const configRoot = join(environment.XDG_CONFIG_HOME || join(home, ".config"), "maze-arena");
  const dataRoot = join(environment.XDG_DATA_HOME || join(home, ".local/share"), "maze-arena");
  const stateRoot = join(environment.XDG_STATE_HOME || join(home, ".local/state"), "maze-arena");
  const runtime = join(stateRoot, "run");
  const logs = join(stateRoot, "logs");
  for (const [label, path] of [["配置", configRoot], ["数据", dataRoot], ["状态", stateRoot]] as const) {
    const canonical = canonicalizeFuturePath(path);
    if (isInsideRepository(canonical)) throw new CliError(`${label}目录不得位于 Maze Arena 源码仓库内：${path}`);
  }
  return {
    configRoot,
    environmentFile: join(configRoot, "env"),
    dataRoot,
    stateRoot,
    manifest: join(configRoot, "install-manifest.json"),
    protectedDirectories: [
      configRoot,
      dataRoot,
      join(dataRoot, "harness"),
      join(dataRoot, "harness-runtimes"),
      join(dataRoot, "models"),
      join(dataRoot, "lineages"),
      join(dataRoot, "lineages/generator"),
      join(dataRoot, "lineages/solver"),
      join(dataRoot, "backups"),
      stateRoot,
      logs,
      runtime,
    ],
    runtime,
    logs,
    processState: join(runtime, "server.json"),
    processLock: join(runtime, "server.lock"),
    harnessRuntimes: join(dataRoot, "harness-runtimes"),
    backups: join(dataRoot, "backups"),
    canaryReports: join(dataRoot, "canary-reports"),
  };
}

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const environmentFileTemplate = [
  "# Maze Arena 用户级凭据。格式为 NAME=value，不执行 shell 展开。",
  "# 名称需与 settings.yaml 中 provider 的 apiKeyEnv 完全一致。",
  "",
].join("\n");

function validateEnvironmentFileStat(path: string, stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new CliError(`凭据环境文件必须是普通文件且不得为符号链接：${path}`);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new CliError(`凭据环境文件权限必须为 0600：${path} 当前为 ${mode.toString(8).padStart(4, "0")}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CliError(`凭据环境文件必须由当前用户拥有：${path}`);
  }
  if (stat.size > 64 * 1024) throw new CliError(`凭据环境文件不得超过 64 KiB：${path}`);
}

function assertSecureEnvironmentFile(path: string): void {
  validateEnvironmentFileStat(path, lstatSync(path));
}

function parseEnvironmentFile(path: string): Map<string, string> {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    try { validateEnvironmentFileStat(path, lstatSync(path)); } catch (error) {
      if (error instanceof CliError) throw error;
    }
    throw new CliError(`凭据环境文件无法作为非符号链接普通文件打开：${path}`);
  }
  let serialized: string;
  try {
    validateEnvironmentFileStat(path, fstatSync(descriptor));
    serialized = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (serialized.includes("\0") || serialized.includes("\r")) {
    throw new CliError(`凭据环境文件格式无效：${path}`);
  }
  const values = new Map<string, string>();
  for (const [index, line] of serialized.split("\n").entries()) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const separator = line.indexOf("=");
    const name = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 1) : "";
    if (!environmentNamePattern.test(name) || values.has(name)
      || value.includes("$(") || value.includes("`") || value.endsWith("\\")) {
      throw new CliError(`凭据环境文件第 ${index + 1} 行格式无效：仅允许唯一的 POSIX_NAME=value 字面量`);
    }
    values.set(name, value);
  }
  return values;
}

function validateCredentialName(name: string): string {
  const issue = credentialEnvironmentNameIssue(name);
  if (issue) throw new CliError(`模型目录${issue}：${name}`);
  return name;
}

function credentialNamesFromReferences(references: readonly string[]): string[] {
  return references.map((reference) => {
    try { return credentialEnvironmentNameFromReference(reference); }
    catch (error) {
      const message = error instanceof Error ? error.message : "包含非法凭据引用";
      throw new CliError(`模型目录${message}`);
    }
  });
}

function loadUserEnvironment(
  paths: RuntimePaths,
  environment: NodeJS.ProcessEnv,
  allowedCredentialNames: readonly string[],
): NodeJS.ProcessEnv {
  if (!existsSync(paths.environmentFile)) return { ...environment };
  const allowed = new Set(allowedCredentialNames.map(validateCredentialName));
  const merged = { ...environment };
  for (const [name, value] of parseEnvironmentFile(paths.environmentFile)) {
    validateCredentialName(name);
    if (!allowed.has(name)) throw new CliError(`凭据环境文件包含冻结模型目录未登记的名称：${name}`);
    if (environment[name] === undefined) merged[name] = value;
  }
  return merged;
}

function ensureEnvironmentFile(paths: RuntimePaths): void {
  if (!existsSync(paths.environmentFile)) {
    try {
      writeFileSync(paths.environmentFile, environmentFileTemplate, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertSecureEnvironmentFile(paths.environmentFile);
}

function run(command: string, args: string[], timeout = 10_000): string {
  return runWithInput(command, args, undefined, timeout);
}

function runWithInput(command: string, args: string[], input: string | undefined, timeout: number): string {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout, input });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new CliError(`缺少必需工具 ${command}`);
  }
  if (result.error) throw new CliError(`无法执行 ${command}：${result.error.message}`);
  if (result.status !== 0) {
    throw new CliError(`${command} 检查失败（退出码 ${result.status ?? "未知"}）`);
  }
  return result.stdout.trim();
}

function parseDigest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!digestPattern.test(normalized)) throw new CliError(`${label}格式无效，预期 sha256 后跟 64 位小写十六进制字符`);
  return normalized;
}

function validateImmutableImageReference(value: string, label = "Match Profile 镜像引用"): string {
  const normalized = value.trim();
  const named = normalized.match(/^(.+)@(sha256:[0-9a-f]{64})$/);
  const namedSegments = named?.[1]!.split("/") ?? [];
  const validNamedReference = namedSegments.length > 0 && namedSegments.every((segment, index) =>
    (index === 0 && namedSegments.length > 1 ? registrySegmentPattern : imageNameSegmentPattern).test(segment));
  if (!digestPattern.test(normalized) && !validNamedReference) {
    throw new CliError(`${label}必须使用完整 SHA-256 摘要，禁止 latest 或普通版本标签：${value}`);
  }
  return normalized;
}

function parseVersion(label: string, output: string): [number, number, number] {
  const match = output.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new CliError(`无法解析 ${label} 版本，预期包含 major.minor.patch`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: [number, number, number], rightText: string): number {
  const right = rightText.split(".").map(Number) as [number, number, number];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateTools(): { diagnostics: string[]; bubblewrapVersion: string } {
  const nodeOutput = run("node", ["--version"]);
  const nodeVersion = parseVersion("Node.js", process.version);
  if (compareVersion(nodeVersion, requirements.node.minimum) < 0
    || compareVersion(nodeVersion, requirements.node.maximumExclusive) >= 0) {
    throw new CliError(`Node.js 版本不受支持：${process.version}，要求 >=${requirements.node.minimum} <${requirements.node.maximumExclusive}`);
  }
  if (nodeOutput !== process.version) {
    throw new CliError("Node.js 执行身份不一致：PATH 中版本与当前进程版本不同");
  }

  const pnpmOutput = run("pnpm", ["--version"]);
  if (pnpmOutput !== requirements.pnpm.exact) {
    throw new CliError(`pnpm 版本不受支持，要求 ${requirements.pnpm.exact}`);
  }

  const gitOutput = run("git", ["--version"]);
  if (compareVersion(parseVersion("Git", gitOutput), requirements.git.minimum) < 0) {
    throw new CliError(`Git 版本不受支持，要求 >=${requirements.git.minimum}`);
  }

  const dockerOutput = run("docker", ["--version"]);
  if (compareVersion(parseVersion("Docker", dockerOutput), requirements.docker.minimum) < 0) {
    throw new CliError(`Docker 版本不受支持，要求 >=${requirements.docker.minimum}`);
  }
  const dockerDaemon = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (compareVersion(parseVersion("Docker daemon", dockerDaemon), requirements.docker.minimum) < 0) {
    throw new CliError(`Docker daemon 版本不受支持，要求 >=${requirements.docker.minimum}`);
  }

  run(unshareExecutable, [
    "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc",
    "/bin/sh", "-c", "test \"$$\" -eq 1",
  ]);
  const bubblewrapOutput = run(bubblewrapExecutable, ["--version"]);
  if (compareVersion(parseVersion("bubblewrap", bubblewrapOutput), "0.8.0") < 0) {
    throw new CliError("bubblewrap 版本不受支持，要求 >=0.8.0");
  }
  const probeRoot = mkdtempSync(join(tmpdir(), "maze-bwrap-probe-"));
  const globalHome = join(probeRoot, "global-home");
  const sessionHome = join(probeRoot, "session-home");
  const workspace = join(probeRoot, "workspace");
  for (const path of [globalHome, sessionHome, workspace]) mkdirSync(path);
  writeFileSync(join(globalHome, "locked"), "locked");
  try {
    const abstractSocket = `\0maze-doctor-${randomUUID()}`;
    const networkProbe = `
const net = require("node:net");
let settled = false;
const finish = (code) => { if (settled) return; settled = true; process.exitCode = code; };
const unix = net.createConnection({ path: ${JSON.stringify(abstractSocket)} });
unix.once("connect", () => { unix.destroy(); finish(31); });
unix.once("error", (error) => {
  if (error.code !== "EAFNOSUPPORT") return finish(32);
  const server = net.createServer((socket) => socket.end());
  server.once("error", () => finish(33));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return finish(34);
    const client = net.createConnection({ host: "127.0.0.1", port: address.port });
    client.once("connect", () => { client.end(); server.close(() => finish(0)); });
    client.once("error", () => { server.close(); finish(35); });
  });
});
setTimeout(() => finish(36), 2000).unref();
`;
    const networkRuntime = minimalBubblewrapRuntime();
    if (process.execPath !== "/usr" && !process.execPath.startsWith(`/usr${sep}`)) {
      networkRuntime.push("--ro-bind", process.execPath, process.execPath);
    }
    runWithHarnessNetworkSeccomp(unshareExecutable, [
      "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc",
      bubblewrapExecutable, ...networkRuntime, "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp",
      "--ro-bind", globalHome, globalHome, "--bind", sessionHome, sessionHome,
      "--bind", workspace, workspace, "--chdir", workspace,
      "--remount-ro", "/run", "--remount-ro", "/tmp", "--remount-ro", "/var/tmp", "--seccomp", "3", "--", "/bin/sh", "-c",
      "test ! -e /home; test ! -e /mnt; ! printf x > /run/unscoped 2>/dev/null; ! printf x > /tmp/unscoped 2>/dev/null; if printf x >> \"$1/locked\" 2>/dev/null; then exit 31; fi; printf x > \"$2/session\"; printf x > workspace",
      "maze-bwrap-probe", globalHome, sessionHome,
    ]);
    runWithHarnessNetworkSeccomp(unshareExecutable, [
      "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc",
      bubblewrapExecutable, ...networkRuntime, "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp",
      "--remount-ro", "/run", "--remount-ro", "/tmp", "--remount-ro", "/var/tmp", "--seccomp", "3",
      "--", process.execPath, "-e", networkProbe,
    ], 10_000, { ...process.env, NODE_OPTIONS: "" });
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }

  return { bubblewrapVersion: bubblewrapOutput, diagnostics: [
    `检查通过：Node.js ${nodeOutput}`,
    `检查通过：pnpm ${pnpmOutput}`,
    `检查通过：${gitOutput}`,
    `检查通过：Docker ${dockerOutput}`,
    `检查通过：Docker daemon ${dockerDaemon}`,
    "检查通过：Harness PID namespace 隔离可用",
    `检查通过：${bubblewrapOutput} 文件系统隔离可用`,
    "检查通过：Harness Unix socket 外部连接已隔离且 TCP 回环可用",
  ] };
}

function runWithHarnessNetworkSeccomp(
  command: string,
  args: string[],
  timeout = 10_000,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const directory = mkdtempSync(join(tmpdir(), "maze-harness-seccomp-"));
  const path = join(directory, "network.bpf");
  let descriptor: number | undefined;
  try {
    writeFileSync(path, createHarnessNetworkSeccompProgram(), { mode: 0o600 });
    descriptor = openSync(path, "r");
    rmSync(directory, { recursive: true, force: true });
    const result = spawnSync(command, args, {
      encoding: "utf8",
      shell: false,
      timeout,
      env: environment,
      stdio: ["pipe", "pipe", "pipe", descriptor],
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`缺少必需工具 ${command}`);
    }
    if (result.error) throw new CliError(`无法执行 ${command}：${result.error.message}`);
    if (result.status !== 0) throw new CliError(`${command} 检查失败（退出码 ${result.status ?? "未知"}）`);
    return result.stdout.trim();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
}

function minimalBubblewrapRuntime(): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-ipc", "--ro-bind", "/usr", "/usr"];
  for (const [target, source] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"]] as const) {
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) args.push("--symlink", source, target);
  }
  for (const path of ["/etc/hosts", "/etc/nsswitch.conf", "/etc/resolv.conf", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/ssl/certs", "/etc/pki"]) {
    if (lstatSync(path, { throwIfNoEntry: false })) args.push("--ro-bind", realpathSync(path), path);
  }
  return args;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashPaths(paths: string[]): string {
  const digest = createHash("sha256");
  for (const root of paths.map((path) => resolve(path)).sort()) {
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!existsSync(current)) throw new CliError(`项目构建产物缺失：${current}，请先完成构建`);
      const relativePath = relative(repositoryRoot, current).split(sep).join("/");
      const stat = statSync(current);
      if (stat.isDirectory()) {
        pending.push(...readdirSync(current).map((entry) => join(current, entry)).sort().reverse());
      } else if (stat.isFile()) {
        digest.update(`${relativePath}\0${stat.mode & 0o777}\0`);
        digest.update(readFileSync(current));
        digest.update("\0");
      } else {
        throw new CliError(`项目构建产物包含不支持的文件类型：${current}`);
      }
    }
  }
  return digest.digest("hex");
}

function restoreCopiedModes(sourceRoot: string, targetRoot: string): void {
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const source = pending.pop()!;
    const local = relative(sourceRoot, source);
    const target = local ? join(targetRoot, local) : targetRoot;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) continue;
    chmodSync(target, stat.mode & 0o777);
    if (stat.isDirectory()) {
      pending.push(...readdirSync(source).map((entry) => join(source, entry)));
    }
  }
}

function resolveFile(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new CliError(`${label}不存在或不是文件：${absolute}`);
  return realpathSync(absolute);
}

function resolveDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new CliError(`${label}不存在或不是目录：${absolute}`);
  return realpathSync(absolute);
}

function resolveHarnessRuntimeRoot(executablePath: string): string {
  let directory = dirname(executablePath);
  while (true) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath) && statSync(manifestPath).isFile()) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: unknown };
        const declared = typeof manifest.bin === "string"
          ? manifest.bin
          : manifest.bin && typeof manifest.bin === "object"
            ? (manifest.bin as Record<string, unknown>).dsh
            : undefined;
        if (typeof declared === "string" && resolveFile(join(directory, declared), "Harness runtime dsh 入口") === executablePath) {
          return realpathSync(directory);
        }
      } catch (error) {
        if (error instanceof CliError) throw error;
        // 无关祖先 package.json 不参与运行载荷身份推断。
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return realpathSync(dirname(executablePath));
    directory = parent;
  }
}

async function validateSandboxedHarnessVersion(
  executablePath: string,
  runtimeRoot: string,
  expectedVersion: string,
  environment: NodeJS.ProcessEnv,
  mismatchMessage = "隔离运行中的 dsh 版本漂移",
  expectedRuntimePayloadSha256?: string,
): Promise<void> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "maze-harness-version-"));
  chmodSync(sessionRoot, 0o700);
  const sessionHome = join(sessionRoot, "home");
  const workspace = join(sessionRoot, "workspace");
  const xdgConfigHome = join(sessionHome, ".config");
  const xdgDataHome = join(sessionHome, ".local/share");
  const xdgStateHome = join(sessionHome, ".local/state");
  for (const path of [sessionHome, workspace, xdgConfigHome, xdgDataHome, xdgStateHome]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = environment[key] ?? process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  Object.assign(childEnvironment, {
    HOME: sessionHome,
    DSH_HOME: sessionHome,
    TMPDIR: sessionHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
  });
  try {
    const result = await runIsolatedHarnessCommand({
      command: executablePath,
      args: ["--version"],
      runtimeRoot,
      expectedRuntimePayloadSha256: expectedRuntimePayloadSha256 ?? hashHarnessRuntimePayload(runtimeRoot),
      environment: childEnvironment,
      timeoutMs: 10_000,
      cwd: workspace,
      writablePaths: [sessionHome, workspace],
      unshareCommand: unshareExecutable,
      bubblewrapCommand: bubblewrapExecutable,
    });
    const actualVersion = result.stdout.trim();
    if (actualVersion !== expectedVersion) throw new CliError(`${mismatchMessage}：期望 ${expectedVersion}`);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

function materializeHarnessRuntimeSnapshot(
  paths: RuntimePaths,
  inputRuntimeRoot: string,
  inputExecutable: string,
  payloadSha256: string,
  executableSha256: string,
  snapshotName = payloadSha256,
): { runtimeRoot: string; executablePath: string } {
  if (!/^(?:[0-9a-f]{64}|instance-[0-9a-f-]{36})$/.test(snapshotName)) {
    throw new CliError("Harness 私有 runtime 快照名称无效");
  }
  const executableLocalPath = relative(inputRuntimeRoot, inputExecutable);
  if (!executableLocalPath || executableLocalPath === ".." || executableLocalPath.startsWith(`..${sep}`) || isAbsolute(executableLocalPath)) {
    throw new CliError("dsh 可执行文件必须位于声明的来源运行根内");
  }
  const runtimeRoot = join(paths.harnessRuntimes, snapshotName);
  const staging = join(paths.harnessRuntimes, `.staging-${process.pid}-${randomUUID()}`);
  try {
    if (!existsSync(runtimeRoot)) {
      cpSync(inputRuntimeRoot, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      // cpSync 创建的每层目录会受 umask 影响；载荷摘要包含权限，必须逐层恢复。
      restoreCopiedModes(inputRuntimeRoot, staging);
      const copiedIdentity = hashHarnessRuntimePayload(staging);
      if (copiedIdentity !== payloadSha256) {
        throw new CliError("Harness runtime 来源在创建私有快照期间发生漂移");
      }
      renameSync(staging, runtimeRoot);
    }
    const frozenRoot = resolveDirectory(runtimeRoot, "Harness 私有 runtime 快照");
    if (hashHarnessRuntimePayload(frozenRoot) !== payloadSha256) {
      throw new CliError("Harness 私有 runtime 快照内容与登记身份不一致");
    }
    const executablePath = resolveFile(join(frozenRoot, executableLocalPath), "Harness 私有 runtime dsh 入口");
    if (sha256(executablePath) !== executableSha256) {
      throw new CliError("Harness 私有 runtime dsh 入口与来源身份不一致");
    }
    return { runtimeRoot: frozenRoot, executablePath };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function findHarnessRuntimePackage(runtimeRoot: string): HarnessRuntimePackage {
  const root = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh");
  const manifestPath = resolveFile(join(root, "package.json"), "npm DSH package.json");
  let manifest: { name?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CliError(`npm DSH package.json 无效：${(error as Error).message}`);
  }
  const executable = typeof manifest.bin === "string" ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object" ? (manifest.bin as Record<string, unknown>).dsh : undefined;
  if (manifest.name !== "@deepseek-ai/dsh" || typeof executable !== "string") {
    throw new CliError("npm 安装结果缺少有效的 @deepseek-ai/dsh 运行包");
  }
  const declaredExecutable = resolve(root, executable);
  const relation = relative(root, declaredExecutable);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new CliError("npm DSH 入口禁止越出所属运行包");
  }
  return { name: manifest.name, root, executable };
}

function ensureDirectories(paths: RuntimePaths): void {
  for (const path of paths.protectedDirectories) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

function atomicWriteManifest(path: string, manifest: InstallManifest): void {
  const temporary = join(dirname(path), `.install-manifest.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

async function runHarnessModelExport(
  adapter: string,
  runtimeRoot: string,
  payloadSha256: string,
  environment: NodeJS.ProcessEnv,
  harnessHome: string,
): Promise<string> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "maze-model-export-"));
  chmodSync(sessionRoot, 0o700);
  const sessionHome = join(sessionRoot, "home");
  const workspace = join(sessionRoot, "workspace");
  for (const path of [sessionHome, workspace]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = environment[key] ?? process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  Object.assign(childEnvironment, {
    HOME: sessionHome,
    TMPDIR: sessionHome,
    XDG_CONFIG_HOME: join(sessionHome, ".config"),
    XDG_DATA_HOME: join(sessionHome, ".local/share"),
    XDG_STATE_HOME: join(sessionHome, ".local/state"),
    DSH_HOME: sessionHome,
    DSH_MODEL_SETTINGS_PATH: join(harnessHome, "settings.yaml"),
  });
  try {
    const result = await runIsolatedHarnessCommand({
      command: adapter,
      args: ["catalog"],
      runtimeRoot,
      expectedRuntimePayloadSha256: payloadSha256,
      environment: childEnvironment,
      timeoutMs: 30_000,
      cwd: workspace,
      writablePaths: [sessionHome, workspace],
      readOnlyPaths: existsSync(join(harnessHome, "settings.yaml")) ? [join(harnessHome, "settings.yaml")] : [],
      unshareCommand: unshareExecutable,
      bubblewrapCommand: bubblewrapExecutable,
    });
    return result.stdout;
  } catch (error) {
    const exitCode = error && typeof error === "object" && "exitCode" in error ? (error as { exitCode?: unknown }).exitCode : undefined;
    if (typeof exitCode === "number") throw new CliError(`Harness 模型导出失败（退出码 ${exitCode}）`);
    throw new CliError(`Harness 模型导出无法执行：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

function validateExistingModelRelease(release: string, catalogSerialized: string, runtimeSerialized: string, settingsSerialized: string): void {
  try {
    const releaseStat = lstatSync(release);
    if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory() || (releaseStat.mode & 0o777) !== 0o500) {
      throw new Error("invalid release");
    }
    const catalogPath = join(release, "catalog.json");
    const catalogStat = lstatSync(catalogPath);
    if (catalogStat.isSymbolicLink() || !catalogStat.isFile() || (catalogStat.mode & 0o777) !== 0o400
      || readFileSync(catalogPath, "utf8") !== catalogSerialized) {
      throw new Error("invalid catalog");
    }
    const runtimePath = join(release, "model-export.json");
    const runtimeStat = lstatSync(runtimePath);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isFile() || (runtimeStat.mode & 0o777) !== 0o400
      || readFileSync(runtimePath, "utf8") !== runtimeSerialized) {
      throw new Error("invalid runtime export");
    }
    const settingsPath = join(release, "settings.yaml");
    const settingsStat = lstatSync(settingsPath);
    if (settingsStat.isSymbolicLink() || !settingsStat.isFile() || (settingsStat.mode & 0o777) !== 0o400
      || readFileSync(settingsPath, "utf8") !== settingsSerialized) throw new Error("invalid settings snapshot");
  } catch {
    throw new CliError("已存在的同摘要模型目录不满足不可变发布约束，拒绝发布");
  }
}

async function syncHarnessModels(environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  validateDirectoryPermissions(paths);
  const { executablePath: executable, runtimeRoot } = validateFrozenHarnessRuntime(manifest);
  await validateSandboxedHarnessVersion(
    executable,
    runtimeRoot,
    manifest.harness.executable.version,
    environment,
    "dsh 精确版本已漂移，拒绝同步模型目录",
    manifest.harness.executable.payloadSha256,
  );

  let raw: unknown;
  try {
    raw = JSON.parse(await runHarnessModelExport(
      manifest.harness.adapter.path,
      runtimeRoot,
      manifest.harness.executable.payloadSha256,
      environment,
      join(paths.dataRoot, "harness"),
    ));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Harness 模型导出不是有效 JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CliError("Harness 模型导出缺少运行声明");
  const { runtimeProviders: _runtimeProviders, ...publicCatalog } = raw as Record<string, unknown>;
  const catalog = parseHarnessModelCatalog(publicCatalog, manifest.harness.executable.version);
  credentialNamesFromReferences(catalog.credentialRefs);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const runtimeSerialized = `${JSON.stringify(raw, null, 2)}\n`;
  const settingsSerialized = readFileSync(join(paths.dataRoot, "harness/settings.yaml"), "utf8");
  const releaseId = createHash("sha256").update(serialized).update("\0").update(runtimeSerialized)
    .update("\0").update(settingsSerialized).digest("hex");
  const modelsRoot = join(paths.dataRoot, "models");
  const releasesRoot = join(modelsRoot, "releases");
  const release = join(releasesRoot, releaseId);
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  chmodSync(releasesRoot, 0o700);
  if (lstatSync(release, { throwIfNoEntry: false })) {
    validateExistingModelRelease(release, serialized, runtimeSerialized, settingsSerialized);
  } else {
    const staging = mkdtempSync(join(modelsRoot, ".sync-"));
    try {
      const catalogPath = join(staging, "catalog.json");
      writeFileSync(catalogPath, serialized, { mode: 0o400, flag: "wx" });
      chmodSync(catalogPath, 0o400);
      const runtimePath = join(staging, "model-export.json");
      writeFileSync(runtimePath, runtimeSerialized, { mode: 0o400, flag: "wx" });
      chmodSync(runtimePath, 0o400);
      const settingsPath = join(staging, "settings.yaml");
      cpSync(join(paths.dataRoot, "harness/settings.yaml"), settingsPath);
      chmodSync(settingsPath, 0o400);
      renameSync(staging, release);
      chmodSync(release, 0o500);
    } finally {
      if (existsSync(staging)) {
        chmodSync(staging, 0o700);
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  const nextLink = join(modelsRoot, `.current.${process.pid}`);
  try {
    symlinkSync(join("releases", releaseId), nextLink, "dir");
    renameSync(nextLink, join(modelsRoot, "current"));
  } finally {
    rmSync(nextLink, { force: true });
  }
  process.stdout.write(`模型目录已同步：${catalog.providers.length} 个提供方，${catalog.providers.reduce((sum, provider) => sum + provider.models.length, 0)} 个模型\n`);
  process.stdout.write(`只读目录：${join(modelsRoot, "current", "catalog.json")}\n`);
}

function parseInstallOptions(args: string[]): Record<string, string> {
  const allowed = new Set(["--dsh-version"]);
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--")) throw new CliError(`未知或缺少值的 install 参数：${key ?? "<空>"}`);
    options[key] = value;
  }
  for (const key of allowed) if (!options[key]) throw new CliError(`install 缺少必需参数 ${key}`);
  return options;
}

function validateExactNpmVersion(version: string): void {
  const exact = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!exact.test(version)) {
    throw new CliError("DSH npm 版本必须是精确 SemVer，禁止 latest、dist-tag、版本范围、file、git 或 URL 来源");
  }
}

async function install(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const options = parseInstallOptions(args);
  const { diagnostics, bubblewrapVersion } = validateTools();
  const expectedVersion = options["--dsh-version"]!;
  validateExactNpmVersion(expectedVersion);

  const paths = runtimePaths(environment);
  ensureDirectories(paths);
  ensureEnvironmentFile(paths);
  const installRoot = mkdtempSync(join(paths.stateRoot, ".harness-npm-install-"));
  try {
    writeFileSync(join(installRoot, "package.json"), `${JSON.stringify({
      name: "maze-arena-harness-install", private: true,
    }, null, 2)}\n`, { mode: 0o600 });
    run("npm", [
      "install", "--prefix", installRoot, "--no-audit", "--no-fund", "--package-lock=false", "--include=optional",
      "--save-exact", `@deepseek-ai/dsh@${expectedVersion}`, `pnpm@${requirements.pnpm.exact}`,
    ], 300_000);
    const runtimePackage = findHarnessRuntimePackage(installRoot);
    if (runtimePackage.name !== "@deepseek-ai/dsh") throw new CliError("npm 安装结果缺少 @deepseek-ai/dsh 运行包");
    const installedManifest = JSON.parse(readFileSync(join(runtimePackage.root, "package.json"), "utf8")) as { version?: unknown };
    if (installedManifest.version !== expectedVersion) throw new CliError(`npm 安装的 DSH 包版本漂移：期望 ${expectedVersion}`);
    validateFrozenPnpm(installRoot);
    const executablePath = resolveFile(join(runtimePackage.root, runtimePackage.executable), "npm DSH 可执行文件");
    await validateSandboxedHarnessVersion(executablePath, installRoot, expectedVersion, environment, "dsh --version 与 npm 包版本不一致");
    const adapterSource = resolveFile(join(repositoryRoot, "packages/dsh-integration/dist/dsh-sdk-adapter.js"), "Arena DSH SDK adapter 构建产物");
    const credentialPolicySource = resolveFile(
      join(repositoryRoot, "packages/dsh-integration/dist/credential-environment-policy.js"),
      "Arena 凭据环境策略构建产物",
    );
    const adapterDirectory = join(installRoot, "maze-arena");
    const adapterPath = join(adapterDirectory, "dsh-sdk-adapter.js");
    const credentialPolicyPath = join(adapterDirectory, "credential-environment-policy.js");
    mkdirSync(adapterDirectory, { recursive: true, mode: 0o700 });
    cpSync(adapterSource, adapterPath);
    cpSync(credentialPolicySource, credentialPolicyPath);
    const adapterContents = readFileSync(adapterPath, "utf8");
    writeFileSync(adapterPath, adapterContents.replace(/^#![^\n]*/, `#!${process.execPath}`), { mode: 0o500 });
    chmodSync(adapterPath, 0o500);
    chmodSync(credentialPolicyPath, 0o400);
    const adapterSha256 = sha256(adapterPath);
    const executableSha256 = sha256(executablePath);
    const payloadSha256 = hashHarnessRuntimePayload(installRoot);
    const snapshot = materializeHarnessRuntimeSnapshot(paths, installRoot, executablePath, payloadSha256, executableSha256);
    await validateSandboxedHarnessVersion(snapshot.executablePath, snapshot.runtimeRoot, expectedVersion, environment,
      "隔离运行中的 dsh 版本漂移", payloadSha256);
    atomicWriteManifest(paths.manifest, {
      schemaVersion: 1,
      requirements,
      directories: { config: paths.configRoot, data: paths.dataRoot, state: paths.stateRoot },
      harness: {
        packageName: "@deepseek-ai/dsh",
        packageVersion: expectedVersion,
        executable: {
          path: snapshot.executablePath,
          runtimeRoot: snapshot.runtimeRoot,
          payloadSha256,
          sha256: executableSha256,
          version: expectedVersion,
        },
        adapter: {
          path: join(snapshot.runtimeRoot, "maze-arena/dsh-sdk-adapter.js"),
          sha256: adapterSha256,
          protocolVersion: 1,
        },
      },
      isolation: { bubblewrap: { path: bubblewrapExecutable, version: bubblewrapVersion } },
    });
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
  for (const diagnostic of diagnostics) process.stdout.write(`${diagnostic}\n`);
  process.stdout.write(`正式运行目录已初始化：${paths.dataRoot}\n`);
  process.stdout.write(`安装清单已写入：${paths.manifest}\n`);
  process.stdout.write(`用户凭据环境文件：${paths.environmentFile}\n`);
}

function readManifest(paths: RuntimePaths): InstallManifest {
  if (!existsSync(paths.manifest)) throw new CliError(`安装清单不存在，请先运行 install：${paths.manifest}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(paths.manifest, "utf8"));
  } catch (error) {
    throw new CliError(`安装清单不是有效 JSON：${(error as Error).message}`);
  }
  const manifest = value as Partial<InstallManifest>;
  if (manifest.schemaVersion !== 1 || manifest.harness?.packageName !== "@deepseek-ai/dsh"
    || !manifest.harness.packageVersion || !manifest.harness.executable?.path || !manifest.harness.executable.runtimeRoot
    || !manifest.harness.executable.payloadSha256 || !manifest.harness.executable.sha256 || !manifest.harness.executable.version
    || !manifest.harness.adapter?.path || !manifest.harness.adapter.sha256 || manifest.harness.adapter.protocolVersion !== 1
    || manifest.isolation?.bubblewrap.path !== bubblewrapExecutable || !manifest.isolation.bubblewrap.version) {
    throw new CliError("安装清单结构无效");
  }
  validateExactNpmVersion(manifest.harness.packageVersion);
  if (manifest.harness.executable.version !== manifest.harness.packageVersion) throw new CliError("安装清单 DSH 包版本与入口版本不一致");
  return manifest as InstallManifest;
}

function validateFrozenHarnessRuntime(manifest: InstallManifest): { runtimeRoot: string; executablePath: string } {
  const runtimeRoot = resolveDirectory(manifest.harness.executable.runtimeRoot, "Harness 私有 runtime");
  const packageRoot = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh");
  const packageManifest = JSON.parse(readFileSync(resolveFile(join(packageRoot, "package.json"), "DSH npm package.json"), "utf8")) as {
    name?: unknown; version?: unknown; bin?: unknown;
  };
  const bin = typeof packageManifest.bin === "string" ? packageManifest.bin
    : packageManifest.bin && typeof packageManifest.bin === "object"
      ? (packageManifest.bin as Record<string, unknown>).dsh : undefined;
  if (packageManifest.name !== manifest.harness.packageName || packageManifest.version !== manifest.harness.packageVersion
    || typeof bin !== "string") throw new CliError("DSH npm 包身份与安装清单不一致");
  const executablePath = resolveFile(join(packageRoot, bin), "DSH npm 入口");
  if (executablePath !== resolveFile(manifest.harness.executable.path, "dsh 私有快照可执行文件")) {
    throw new CliError("DSH npm 包入口与安装清单路径不一致");
  }
  if (sha256(executablePath) !== manifest.harness.executable.sha256) throw new CliError("dsh 可执行文件内容已漂移");
  validateFrozenPnpm(runtimeRoot);
  const expectedAdapter = resolveFile(join(runtimeRoot, "maze-arena/dsh-sdk-adapter.js"), "Arena DSH SDK adapter");
  if (expectedAdapter !== resolveFile(manifest.harness.adapter.path, "安装清单 Arena DSH SDK adapter")
    || sha256(expectedAdapter) !== manifest.harness.adapter.sha256) {
    throw new CliError("Arena DSH SDK adapter 身份已漂移");
  }
  if (hashHarnessRuntimePayload(runtimeRoot) !== manifest.harness.executable.payloadSha256) throw new CliError("Harness 私有 runtime 载荷已漂移");
  return { runtimeRoot, executablePath };
}

function validateFrozenPnpm(runtimeRoot: string): string {
  const packageRoot = join(runtimeRoot, "node_modules/pnpm");
  const packageManifest = JSON.parse(readFileSync(resolveFile(join(packageRoot, "package.json"), "pnpm package.json"), "utf8")) as {
    name?: unknown; version?: unknown; bin?: unknown;
  };
  const bin = typeof packageManifest.bin === "string" ? packageManifest.bin
    : packageManifest.bin && typeof packageManifest.bin === "object"
      ? (packageManifest.bin as Record<string, unknown>).pnpm : undefined;
  if (packageManifest.name !== "pnpm" || packageManifest.version !== requirements.pnpm.exact || typeof bin !== "string") {
    throw new CliError(`冻结 pnpm 包身份不一致，要求 pnpm@${requirements.pnpm.exact}`);
  }
  const executablePath = resolveFile(join(packageRoot, bin), "冻结 pnpm 入口");
  const relation = relative(packageRoot, executablePath);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new CliError("冻结 pnpm 入口必须位于 pnpm 包内");
  }
  const commandDirectory = join(runtimeRoot, "node_modules/.bin");
  const commandPath = resolveFile(join(commandDirectory, "pnpm"), "冻结 pnpm 命令");
  if (commandPath !== executablePath) throw new CliError("冻结 pnpm 命令与包入口不一致");
  return commandDirectory;
}

function parseImageBuildOptions(args: string[]): { baseImage: string; imageName: string } {
  const allowed = new Set(["--base-image", "--image-name"]);
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--")) {
      throw new CliError(`未知或缺少值的 image build 参数：${key ?? "<空>"}`);
    }
    options[key] = value;
  }
  for (const key of allowed) if (!options[key]) throw new CliError(`image build 缺少必需参数 ${key}`);
  const imageName = options["--image-name"]!;
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?$/.test(imageName)) {
    throw new CliError(`镜像构建名称无效：${imageName}`);
  }
  return {
    baseImage: validateImmutableImageReference(options["--base-image"]!, "基础镜像引用"),
    imageName,
  };
}

const imageProjectPackages = [
  { name: "@maze-arena/contracts", directory: "contracts", files: ["package.json", "dist"] },
  { name: "@maze-arena/engine", directory: "engine", files: ["package.json", "dist"] },
  { name: "@maze-arena/match-profile", directory: "match-profile", files: ["package.json", "cordis.patch.yml", "dist"] },
  { name: "@maze-arena/generator-plugin", directory: "generator-plugin", files: ["package.json", "cordis.patch.yml", "dist"] },
  { name: "@maze-arena/solver-plugin", directory: "solver-plugin", files: ["package.json", "cordis.patch.yml", "dist"] },
] as const;

const projectArtifactPaths = imageProjectPackages.flatMap(({ directory, files }) =>
  files.map((file) => join(repositoryRoot, "packages", directory, file)));

function copyProjectArtifacts(target: string): void {
  for (const source of projectArtifactPaths) {
    const destination = join(target, relative(repositoryRoot, source));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
  }
}

function createSmokeProfile(target: string, role: "generator" | "solver"): void {
  const profile = join(target, `profiles/maze-match-${role}`);
  const modules = join(profile, "node_modules/@maze-arena");
  mkdirSync(modules, { recursive: true });
  const rolePackage = `${role}-plugin` as "generator-plugin" | "solver-plugin";
  const packages = ["match-profile", rolePackage] as const;
  for (const name of packages) {
    cpSync(join(repositoryRoot, "packages", name), join(modules, name), {
      recursive: true,
      dereference: true,
      filter: (source) => !relative(join(repositoryRoot, "packages", name), source).split(sep)
        .some((part) => part === "node_modules" || part === "src" || part === "test"),
    });
  }
  writeFileSync(join(profile, "package.json"), `${JSON.stringify({
    name: `dsh-profile-maze-match-${role}`,
    private: true,
    dependencies: {
      "@maze-arena/match-profile": "0.1.0",
      [`@maze-arena/${rolePackage}`]: "0.1.0",
    },
    dsh: {
      profile: createMatchProfileConfiguration(["@maze-arena/match-profile", `@maze-arena/${rolePackage}`]),
    },
  }, null, 2)}\n`);
  writeFileSync(join(profile, "cordis.yml"), "[]\n");
  writeFileSync(join(profile, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(profile, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "",
    "nodeLinker: hoisted",
    "autoInstallPeers: false",
    "",
  ].join("\n"));
}

function imageSmokeRequest(role: MatchPluginRole): MatchProtocolRequest {
  return {
    protocolVersion: 1,
    requestId: `image-smoke-${role}`,
    sequence: 1,
    role,
    payload: role === "generator"
      ? { type: "generator.start", seed: "image-smoke", rules: { size: 31, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } } }
      : { type: "solver.start", start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } },
  };
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validateImageSmokeResponse(value: unknown, requestValue: MatchProtocolRequest): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("Match Profile smoke 响应不是 JSON 对象");
  const response = value as Record<string, unknown>;
  if (!hasOnlyKeys(response, ["protocolVersion", "requestId", "sequence", "role", "payload"])
    || response.protocolVersion !== 1 || response.requestId !== requestValue.requestId
    || response.sequence !== requestValue.sequence || response.role !== requestValue.role
    || !response.payload || typeof response.payload !== "object" || Array.isArray(response.payload)) {
    throw new CliError(`${requestValue.role} Match Profile smoke 响应信封无效`);
  }
  const payload = response.payload as Record<string, unknown>;
  if (requestValue.role === "solver") {
    if (!hasOnlyKeys(payload, ["type"]) || payload.type !== "solver.ready") {
      throw new CliError("solver Match Profile smoke 未返回 solver.ready");
    }
    return;
  }
  const coordinate = (candidate: unknown): candidate is { x: number; y: number } => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const value = candidate as Record<string, unknown>;
    return hasOnlyKeys(value, ["x", "y"])
      && Number.isInteger(value.x) && Number.isInteger(value.y)
      && Number(value.x) >= 0 && Number(value.x) < 31 && Number(value.y) >= 0 && Number(value.y) < 31;
  };
  if (!hasOnlyKeys(payload, ["type", "from", "to"]) || payload.type !== "generator.carve"
    || !coordinate(payload.from) || !coordinate(payload.to)
    || Math.abs(payload.from.x - payload.to.x) + Math.abs(payload.from.y - payload.to.y) !== 1) {
    throw new CliError("generator Match Profile smoke 未返回合法相邻通道");
  }
}

interface BoundedDockerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBoundedDockerCommand(args: string[], timeoutMs = 2_000): Promise<BoundedDockerResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let terminalError: Error | undefined;
    const consume = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MATCH_OUTPUT_LIMIT_BYTES) {
        terminalError ??= new CliError(`docker ${args[0] ?? "命令"} 输出超限`);
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = consume(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = consume(stderr, chunk); });
    const timer = setTimeout(() => {
      terminalError ??= new CliError(`docker ${args[0] ?? "命令"} 超时`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new CliError(error.code === "ENOENT" ? "缺少必需工具 docker" : `无法执行 docker：${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (terminalError) reject(terminalError);
      else resolveCommand({ code, signal, stdout, stderr });
    });
  });
}

function dockerReportsAbsent(result: BoundedDockerResult): boolean {
  return result.code !== null && result.code !== 0 && result.signal === null
    && /no such (?:container|object)/i.test(`${result.stdout}\n${result.stderr}`);
}

function dockerKillReportsContainerAlreadyStopped(result: BoundedDockerResult): boolean {
  return result.code !== null && result.code !== 0 && result.signal === null
    && /no such container|is not running/i.test(`${result.stdout}\n${result.stderr}`);
}

async function cleanupImageSmokeContainer(role: MatchPluginRole, containerName: string): Promise<void> {
  const remove = async (): Promise<void> => {
    const result = await runBoundedDockerCommand(["rm", "-f", containerName]);
    if (result.code !== 0 && !dockerReportsAbsent(result)) {
      throw new CliError(`${role} Match Profile smoke 容器强制清理失败`);
    }
  };
  await remove();
  const deadline = Date.now() + 2_000;
  let stableAbsent = 0;
  while (Date.now() < deadline) {
    const result = await runBoundedDockerCommand(["inspect", containerName]);
    if (result.code === 0) {
      stableAbsent = 0;
      await remove();
    } else if (dockerReportsAbsent(result)) {
      stableAbsent += 1;
    } else {
      throw new CliError(`${role} Match Profile smoke 容器清理未确认`);
    }
    if (stableAbsent >= 2) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new CliError(`${role} Match Profile smoke 容器未在时限内稳定消失`);
}

async function runImageSmoke(args: string[], role: MatchPluginRole, containerName: string): Promise<void> {
  const requestValue = imageSmokeRequest(role);
  let terminalError: Error | undefined;
  let inputError: Error | undefined;
  let controlledShutdown = false;
  let terminationSucceeded = false;
  let terminationReportedAbsent = false;
  let terminationPromise: Promise<void> | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let stdout = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const frames: unknown[] = [];
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const fail = (error: Error): void => {
    terminalError ??= error;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  child.once("error", (error: NodeJS.ErrnoException) => fail(new CliError(error.code === "ENOENT" ? "缺少必需工具 docker" : `无法执行 docker：${error.message}`)));
  child.stdin.once("error", (error: NodeJS.ErrnoException) => {
    if (controlledShutdown && error.code === "EPIPE") return;
    inputError = new CliError(`Match Profile smoke 输入失败：${error.message}`);
    if (error.code !== "EPIPE") fail(inputError);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stdoutBytes + stderrBytes > MATCH_OUTPUT_LIMIT_BYTES) fail(new CliError(`${role} Match Profile smoke 输出超限`));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes + stderrBytes > MATCH_OUTPUT_LIMIT_BYTES) return fail(new CliError(`${role} Match Profile smoke 输出超限`));
    stdout += chunk.toString("utf8");
    while (stdout.includes("\n")) {
      const boundary = stdout.indexOf("\n");
      const line = stdout.slice(0, boundary);
      stdout = stdout.slice(boundary + 1);
      try {
        const frame = JSON.parse(line) as unknown;
        frames.push(frame);
        if (frames.length === 1) {
          if (!frame || typeof frame !== "object" || Array.isArray(frame)
            || !hasOnlyKeys(frame as Record<string, unknown>, ["type", "protocolVersion", "role"])
            || (frame as Record<string, unknown>).type !== "match-profile.ready"
            || (frame as Record<string, unknown>).protocolVersion !== 1
            || (frame as Record<string, unknown>).role !== role) throw new CliError(`${role} Match Profile ready 握手字段无效`);
          child.stdin.write(`${JSON.stringify(requestValue)}\n`);
        } else if (frames.length === 2) {
          validateImageSmokeResponse(frame, requestValue);
          controlledShutdown = true;
          child.stdin.end();
          terminationPromise = runBoundedDockerCommand(["kill", "--signal=TERM", containerName])
            .then((termination) => {
              // DSH 在 EOF 后可能先自然退出并因 --rm 被删除，此时 kill 的
              // "No such container" 只说明受控关闭已完成，不能误判为失败。
              if (termination.signal || termination.code !== 0 && !dockerKillReportsContainerAlreadyStopped(termination)) {
                throw new CliError(`${role} Match Profile smoke 无法向容器发送 SIGTERM`);
              }
              if (termination.code === 0) terminationSucceeded = true;
              else terminationReportedAbsent = true;
              shutdownTimer = setTimeout(
                () => fail(new CliError(`${role} Match Profile smoke 受控关闭超时`)),
                2_000,
              );
            })
            .catch((error) => fail(error instanceof Error ? error : new CliError(`${role} Match Profile smoke SIGTERM 失败`)));
        } else throw new CliError(`${role} Match Profile smoke 产生额外输出帧`);
      } catch (error) { fail(error instanceof Error ? error : new CliError(`${role} Match Profile smoke 输出无效`)); }
    }
  });
  const timer = setTimeout(() => fail(new CliError(`${role} Match Profile smoke 超时`)), 60_000);
  try {
    await new Promise<void>((resolvePromise) => child.once("close", (code, signal) => { void (async () => {
      if (terminationPromise) await terminationPromise;
      const expectedControlledExit = controlledShutdown && (terminationSucceeded || terminationReportedAbsent)
        && (code === 0 || code === 143) && signal === null;
      if (!terminalError && !expectedControlledExit) {
        terminalError = new CliError(`${role} Match Profile smoke 异常退出（code=${code ?? "null"}，signal=${signal ?? "null"}）`);
      }
      if (!terminalError && inputError) terminalError = inputError;
      if (!terminalError && (stdout.length !== 0 || frames.length !== 2)) terminalError = new CliError(`${role} Match Profile smoke 未完成请求响应与 EOF 退出`);
      resolvePromise();
    })(); }));
  } finally {
    clearTimeout(timer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    try { await cleanupImageSmokeContainer(role, containerName); }
    catch (error) {
      const cleanupError = error instanceof Error ? error : new CliError(`${role} Match Profile smoke 容器清理失败`);
      terminalError = terminalError ? new CliError(`${terminalError.message}；${cleanupError.message}`) : cleanupError;
    }
  }
  if (terminalError) throw terminalError;
}

async function buildMatchProfileImage(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const options = parseImageBuildOptions(args);
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  validateDirectoryPermissions(paths);
  const executablePath = resolveFile(manifest.harness.executable.path, "dsh 可执行文件");
  if (sha256(executablePath) !== manifest.harness.executable.sha256) throw new CliError("dsh 可执行文件内容已漂移，拒绝构建镜像");
  const frozenRuntimeRoot = resolveDirectory(manifest.harness.executable.runtimeRoot, "Harness 私有 runtime");
  if (hashHarnessRuntimePayload(frozenRuntimeRoot) !== manifest.harness.executable.payloadSha256) {
    throw new CliError("Harness 私有 runtime 载荷已漂移，拒绝构建镜像");
  }

  for (const { directory } of imageProjectPackages) {
    rmSync(join(repositoryRoot, "packages", directory, "dist"), { recursive: true, force: true });
  }
  run("pnpm", [
    ...imageProjectPackages.flatMap(({ name }) => ["--filter", name]),
    "build",
  ], 120_000);
  const projectArtifactSha256 = hashPaths(projectArtifactPaths);
  const staging = mkdtempSync(join(paths.stateRoot, ".match-image-build-"));
  try {
    const runtimeRoot = join(staging, "harness-runtime");
    cpSync(frozenRuntimeRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
    restoreCopiedModes(frozenRuntimeRoot, runtimeRoot);
    if (hashHarnessRuntimePayload(runtimeRoot) !== manifest.harness.executable.payloadSha256) {
      throw new CliError("复制到镜像上下文的 Harness runtime 身份不一致");
    }
    const runtimeExecutable = relative(frozenRuntimeRoot, executablePath).split(sep).join("/");
    copyProjectArtifacts(staging);
    const smokeHomes = {
      generator: join(staging, "smoke-home-generator"),
      solver: join(staging, "smoke-home-solver"),
    } as const;
    for (const role of ["generator", "solver"] as const) createSmokeProfile(smokeHomes[role], role);
    const dockerfile = [
      `FROM ${options.baseImage}`,
      "COPY harness-runtime /opt/deepseek-harness",
      "COPY packages /opt/maze-arena/packages",
      `RUN ln -s /opt/deepseek-harness/${runtimeExecutable} /usr/local/bin/dsh`,
      "USER 65532:65532",
      "ENTRYPOINT []",
      "CMD [\"dsh\"]",
      "",
    ].join("\n");
    writeFileSync(join(staging, "Dockerfile"), dockerfile, { mode: 0o600 });
    const iidFile = join(staging, "image-id");
    run("docker", [
      "build", "--pull=false", "--network=none", "--iidfile", iidFile, "--tag", options.imageName,
      "--label", `org.maze-arena.harness-package=${manifest.harness.packageName}`,
      "--label", `org.maze-arena.harness-version=${manifest.harness.packageVersion}`,
      "--label", `org.maze-arena.harness-runtime-sha256=${manifest.harness.executable.payloadSha256}`,
      "--label", `org.maze-arena.dsh-sha256=${manifest.harness.executable.sha256}`,
      "--label", `org.maze-arena.project-artifact-sha256=${projectArtifactSha256}`,
      staging,
    ], 600_000);
    const imageId = parseDigest(readFileSync(iidFile, "utf8"), "Docker 镜像 ID");
    const inspectedId = parseDigest(run("docker", ["image", "inspect", options.imageName, "--format", "{{.Id}}"]), "Docker inspect 镜像 ID");
    if (imageId !== inspectedId) throw new CliError(`Docker 构建摘要不一致：iidfile ${imageId}，inspect ${inspectedId}`);
    for (const role of ["generator", "solver"] as const) {
      const containerName = `maze-image-smoke-${role}-${randomUUID()}`;
      await runImageSmoke([
        "run", "--interactive", "--rm", "--name", containerName, "--network=none", "--read-only", `--user=${matchProfilePolicy.user}`,
        `--memory=${matchProfilePolicy.memory}`, `--memory-swap=${matchProfilePolicy.memorySwap}`,
        `--cpus=${matchProfilePolicy.cpus}`, `--ulimit=cpu=${matchProfilePolicy.cpuUlimit}`,
        `--pids-limit=${matchProfilePolicy.pidsLimit}`, "--security-opt=no-new-privileges", "--cap-drop=ALL",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--tmpfs=/arena:rw,noexec,nosuid,size=32m,mode=0700,uid=65532,gid=65532",
        `--mount=type=bind,src=${smokeHomes[role]},dst=/arena-source,readonly`,
        "--env=DSH_HOME=/arena", "--env=MAZE_MATCH_PROFILE_SOURCE=/arena-source",
        `--env=MAZE_MATCH_ROLE=${role}`,
        imageId, "node", "/opt/maze-arena/packages/match-profile/dist/container-launcher.js",
        "dsh", "--profile", `maze-match-${role}`,
      ], role, containerName);
    }
    manifest.matchProfile = {
      imageId,
      imageReference: validateImmutableImageReference(imageId),
      projectArtifactSha256,
      harnessPackage: manifest.harness.packageName,
      harnessPackageVersion: manifest.harness.packageVersion,
      harnessRuntimePayloadSha256: manifest.harness.executable.payloadSha256,
      dshExecutableSha256: manifest.harness.executable.sha256,
      resourcePolicy: matchProfilePolicy,
    };
    atomicWriteManifest(paths.manifest, manifest);
    process.stdout.write(`Match Profile 镜像已构建：${imageId}\n`);
    process.stdout.write(`正式不可变镜像引用：${manifest.matchProfile.imageReference}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function validateDirectoryPermissions(paths: RuntimePaths): void {
  for (const path of paths.protectedDirectories) {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new CliError(`正式运行目录缺失：${path}`);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o700) throw new CliError(`目录权限必须为 0700：${path} 当前为 ${mode.toString(8).padStart(4, "0")}`);
  }
  if (existsSync(paths.canaryReports)) {
    const reportDirectory = statSync(paths.canaryReports);
    if (!reportDirectory.isDirectory() || (reportDirectory.mode & 0o777) !== 0o700) {
      throw new CliError(`金丝雀报告目录权限必须为 0700：${paths.canaryReports}`);
    }
  }
  const manifestMode = statSync(paths.manifest).mode & 0o777;
  if (manifestMode !== 0o600) throw new CliError(`安装清单权限必须为 0600：当前为 ${manifestMode.toString(8).padStart(4, "0")}`);
}

function validateDockerSecurityCapabilities(): void {
  let value: unknown;
  try {
    value = JSON.parse(run("docker", ["info", "--format", "{{json .SecurityOptions}}"]));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("无法解析 Docker 安全能力，预期为字符串数组 JSON");
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new CliError("Docker 安全能力响应结构无效");
  }
  if (!value.some((entry) => entry.startsWith("name=seccomp"))) throw new CliError("Docker 缺少必需的 seccomp 安全能力");
  if (!value.some((entry) => entry.startsWith("name=cgroupns"))) throw new CliError("Docker 缺少必需的 cgroupns 安全能力");
}

function validateMatchProfileImage(manifest: InstallManifest): void {
  const matchProfile = manifest.matchProfile;
  if (!matchProfile) throw new CliError("Match Profile 镜像尚未构建，请先运行 image build");
  const imageReference = validateImmutableImageReference(matchProfile.imageReference);
  const expectedImageId = parseDigest(matchProfile.imageId, "安装清单镜像 ID");
  if (imageReference !== expectedImageId) throw new CliError("正式镜像引用必须等于本地构建返回的不可变镜像 ID");
  let inspectedImageId: string;
  try {
    inspectedImageId = run(
      "docker",
      ["image", "inspect", imageReference, "--format", "{{.Id}}"],
    );
  } catch (error) {
    throw new CliError(`Match Profile 镜像缺失或不可读取：${(error as Error).message}`);
  }
  const actualImageId = parseDigest(inspectedImageId, "Docker inspect 镜像 ID");
  if (actualImageId !== expectedImageId) {
    throw new CliError(`Match Profile 镜像摘要漂移：期望 ${expectedImageId}`);
  }
  if (matchProfile.harnessPackage !== manifest.harness.packageName
    || matchProfile.harnessPackageVersion !== manifest.harness.packageVersion
    || matchProfile.harnessRuntimePayloadSha256 !== manifest.harness.executable.payloadSha256
    || matchProfile.dshExecutableSha256 !== manifest.harness.executable.sha256) {
    throw new CliError("Match Profile 镜像构建身份与当前安装清单不一致");
  }
  const actualProjectDigest = hashPaths(projectArtifactPaths);
  if (actualProjectDigest !== matchProfile.projectArtifactSha256) {
    throw new CliError(`Match Profile 项目构建身份漂移：期望 ${matchProfile.projectArtifactSha256}，实际 ${actualProjectDigest}`);
  }
  let labels: unknown;
  try {
    labels = JSON.parse(run("docker", ["image", "inspect", imageReference, "--format", "{{json .Config.Labels}}"]));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("无法解析 Match Profile 镜像标签，预期为 JSON 对象");
  }
  const expectedLabels = {
    "org.maze-arena.harness-package": manifest.harness.packageName,
    "org.maze-arena.harness-version": manifest.harness.packageVersion,
    "org.maze-arena.harness-runtime-sha256": manifest.harness.executable.payloadSha256,
    "org.maze-arena.dsh-sha256": manifest.harness.executable.sha256,
    "org.maze-arena.project-artifact-sha256": matchProfile.projectArtifactSha256,
  };
  if (!labels || typeof labels !== "object"
    || Object.entries(expectedLabels).some(([key, value]) => (labels as Record<string, unknown>)[key] !== value)) {
    throw new CliError("Match Profile 镜像标签与安装清单构建身份不一致");
  }
  if (JSON.stringify(matchProfile.resourcePolicy) !== JSON.stringify(matchProfilePolicy)) {
    throw new CliError("Match Profile 资源与安全策略摘要不受支持");
  }
}

function validateModelCatalog(paths: RuntimePaths, manifest: InstallManifest): {
  path: string; exportPath: string; settingsPath: string; release: string; sha256: string; credentialNames: string[];
} {
  const modelsRoot = join(paths.dataRoot, "models");
  const current = join(modelsRoot, "current");
  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) {
    throw new CliError("Harness 模型目录尚未同步，请先运行 models sync");
  }
  const release = realpathSync(current);
  const releasesRoot = realpathSync(join(modelsRoot, "releases"));
  if (!release.startsWith(`${releasesRoot}${sep}`) || dirname(release) !== releasesRoot) {
    throw new CliError("Harness 模型目录 current 未指向受控只读发布");
  }
  const catalogPath = join(release, "catalog.json");
  const runtimePath = join(release, "model-export.json");
  const settingsPath = join(release, "settings.yaml");
  let credentialNames: string[] = [];
  try {
    const releaseStat = lstatSync(release);
    const catalogStat = lstatSync(catalogPath);
    const runtimeStat = lstatSync(runtimePath);
    const settingsStat = lstatSync(settingsPath);
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || (releaseStat.mode & 0o777) !== 0o500
      || !catalogStat.isFile() || catalogStat.isSymbolicLink() || (catalogStat.mode & 0o777) !== 0o400
      || !runtimeStat.isFile() || runtimeStat.isSymbolicLink() || (runtimeStat.mode & 0o777) !== 0o400
      || !settingsStat.isFile() || settingsStat.isSymbolicLink() || (settingsStat.mode & 0o777) !== 0o400) {
      throw new Error("invalid permissions");
    }
    const catalogSerialized = readFileSync(catalogPath, "utf8");
    const runtimeSerialized = readFileSync(runtimePath, "utf8");
    const settingsSerialized = readFileSync(settingsPath, "utf8");
    const parsedCatalog = parseHarnessModelCatalog(JSON.parse(catalogSerialized), manifest.harness.executable.version);
    credentialNames = credentialNamesFromReferences(parsedCatalog.credentialRefs);
    const runtimeExport = JSON.parse(runtimeSerialized) as Record<string, unknown>;
    const { runtimeProviders: _runtimeProviders, ...runtimeCatalog } = runtimeExport;
    const parsedRuntimeCatalog = parseHarnessModelCatalog(runtimeCatalog, manifest.harness.executable.version);
    if (`${JSON.stringify(parsedRuntimeCatalog, null, 2)}\n` !== catalogSerialized) {
      throw new Error("catalog and runtime export disagree");
    }
    JSON.parse(settingsSerialized);
    const expectedRelease = createHash("sha256").update(catalogSerialized).update("\0").update(runtimeSerialized)
      .update("\0").update(settingsSerialized).digest("hex");
    if (basename(release) !== expectedRelease) throw new Error("release identity mismatch");
  } catch (error) {
    throw new CliError(`Harness 模型目录无效：${error instanceof Error ? error.message : "未知错误"}`);
  }
  return { path: catalogPath, exportPath: runtimePath, settingsPath, release: basename(release), sha256: basename(release), credentialNames };
}

function materializeModelReleaseSnapshot(
  paths: RuntimePaths,
  catalog: ReturnType<typeof validateModelCatalog>,
  instanceId: string,
): { root: string; catalogPath: string; exportPath: string; settingsPath: string; sha256: string } {
  const root = join(paths.harnessRuntimes, `model-instance-${instanceId}`);
  const staging = join(paths.harnessRuntimes, `.model-staging-${process.pid}-${randomUUID()}`);
  const entries = [
    ["catalog.json", catalog.path],
    ["model-export.json", catalog.exportPath],
    ["settings.yaml", catalog.settingsPath],
  ] as const;
  try {
    mkdirSync(staging, { mode: 0o700 });
    const contents = entries.map(([name, source]) => {
      const content = readFileSync(source);
      writeFileSync(join(staging, name), content, { mode: 0o400, flag: "wx" });
      return content;
    });
    const digest = createHash("sha256").update(contents[0]!).update("\0").update(contents[1]!)
      .update("\0").update(contents[2]!).digest("hex");
    if (digest !== catalog.sha256) throw new CliError("模型发布在创建实例快照期间发生漂移");
    chmodSync(staging, 0o500);
    renameSync(staging, root);
    assertFrozenModelRelease(root, digest);
    return {
      root: realpathSync(root),
      catalogPath: join(realpathSync(root), "catalog.json"),
      exportPath: join(realpathSync(root), "model-export.json"),
      settingsPath: join(realpathSync(root), "settings.yaml"),
      sha256: digest,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function assertFrozenModelRelease(root: string, expectedSha256: string): void {
  const resolvedRoot = resolveDirectory(root, "运行中模型发布快照");
  const names = readdirSync(resolvedRoot).sort();
  if (names.join("\n") !== ["catalog.json", "model-export.json", "settings.yaml"].join("\n")
    || (lstatSync(resolvedRoot).mode & 0o777) !== 0o500) {
    throw new CliError("运行中模型发布快照结构或权限已漂移");
  }
  const files = names.map((name) => resolveFile(join(resolvedRoot, name), `运行中模型发布 ${name}`));
  if (files.some((path) => (lstatSync(path).mode & 0o777) !== 0o400)) {
    throw new CliError("运行中模型发布文件权限已漂移");
  }
  const digest = createHash("sha256").update(readFileSync(files[0]!)).update("\0")
    .update(readFileSync(files[1]!)).update("\0").update(readFileSync(files[2]!)).digest("hex");
  if (digest !== expectedSha256) throw new CliError("运行中模型发布快照身份已漂移");
}

function validateProductionBuild(): { serverEntry: string; webRoot: string } {
  const serverEntry = resolveFile(join(repositoryRoot, "apps/server/dist/index.js"), "生产 Server 构建入口");
  const webRoot = resolveDirectory(join(repositoryRoot, "apps/web/dist"), "生产 Web 构建目录");
  resolveFile(join(webRoot, "index.html"), "生产 Web index.html");
  return { serverEntry, webRoot };
}

function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^[1-9]\d*$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function waitForProcessStartTime(pid: number, timeout = 1_000): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const startTime = processStartTime(pid);
    if (startTime !== null) return startTime;
    if (!processExists(pid)) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return processStartTime(pid);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

type ExactProcessStatus = "running" | "exited" | "unknown";

function exactProcessStatus(pid: number, procStartTime: string): ExactProcessStatus {
  const actualStartTime = processStartTime(pid);
  if (actualStartTime !== null) return actualStartTime === procStartTime ? "running" : "exited";
  return processExists(pid) ? "unknown" : "exited";
}

function recordedProcessStatus(state: ProcessState): ExactProcessStatus {
  return exactProcessStatus(state.pid, state.procStartTime);
}

function requireKnownProcessStatus(state: ProcessState): Exclude<ExactProcessStatus, "unknown"> {
  const status = recordedProcessStatus(state);
  if (status === "unknown") {
    throw new CliError(`无法验证运行进程身份：PID ${state.pid} 仍存在但启动时间不可读取；状态文件已保留`);
  }
  return status;
}

function readProcessState(paths: RuntimePaths): ProcessState | undefined {
  if (!existsSync(paths.processState)) return undefined;
  try {
    const value = JSON.parse(readFileSync(paths.processState, "utf8")) as Partial<ProcessState>;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.instanceId !== "string" || !Number.isSafeInteger(value.port)
      || Number(value.port) < 1_024 || Number(value.port) > 65_535
      || typeof value.databasePath !== "string" || typeof value.logPath !== "string"
      || value.harnessPackage !== "@deepseek-ai/dsh" || typeof value.harnessPackageVersion !== "string"
      || typeof value.harnessVersion !== "string" || typeof value.modelCatalogRelease !== "string"
      || typeof value.imageDigest !== "string"
      || typeof value.harnessExecutablePath !== "string" || typeof value.harnessExecutableSha256 !== "string"
      || typeof value.harnessRuntimeRoot !== "string" || typeof value.harnessRuntimePayloadSha256 !== "string"
      || typeof value.harnessAdapterPath !== "string" || typeof value.harnessAdapterSha256 !== "string"
      || typeof value.modelReleaseRoot !== "string" || typeof value.modelReleaseSha256 !== "string"
      || typeof value.modelCatalogPath !== "string" || typeof value.modelExportPath !== "string"
      || typeof value.modelSettingsPath !== "string") {
      throw new Error("invalid state");
    }
    if (typeof value.procStartTime !== "string" || !/^[1-9]\d*$/.test(value.procStartTime)) {
      if (!processExists(Number(value.pid))) {
        rmSync(paths.processState, { force: true });
        return undefined;
      }
      throw new CliError(`运行进程状态缺少有效启动时间，PID ${String(value.pid)} 仍存在，无法证明原实例已退出；状态文件已保留`);
    }
    return value as ProcessState;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`运行进程状态文件无效：${paths.processState}`);
  }
}

function writeProcessState(paths: RuntimePaths, state: ProcessState): void {
  const temporary = join(paths.runtime, `.server.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, paths.processState);
    chmodSync(paths.processState, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertFrozenProcessRuntime(paths: RuntimePaths, state: ProcessState): void {
  const expectedRoot = join(paths.harnessRuntimes, `instance-${state.instanceId}`);
  const runtimeRoot = resolveDirectory(state.harnessRuntimeRoot, "运行中 Harness runtime 快照");
  if (runtimeRoot !== realpathSync(expectedRoot)) throw new CliError("运行中 Harness runtime 快照路径与实例身份不一致");
  const executablePath = resolveFile(state.harnessExecutablePath, "运行中 dsh 可执行文件");
  const relation = relative(runtimeRoot, executablePath);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new CliError("运行中 dsh 可执行文件越出冻结 runtime 快照");
  }
  if (sha256(executablePath) !== state.harnessExecutableSha256) {
    throw new CliError("运行中 dsh 可执行文件身份已漂移");
  }
  const adapterPath = resolveFile(state.harnessAdapterPath, "运行中 Arena DSH SDK adapter");
  const adapterRelation = relative(runtimeRoot, adapterPath);
  if (!adapterRelation || adapterRelation === ".." || adapterRelation.startsWith(`..${sep}`) || isAbsolute(adapterRelation)
    || sha256(adapterPath) !== state.harnessAdapterSha256) {
    throw new CliError("运行中 Arena DSH SDK adapter 身份已漂移");
  }
  if (hashHarnessRuntimePayload(runtimeRoot) !== state.harnessRuntimePayloadSha256) {
    throw new CliError("运行中 Harness runtime 快照身份已漂移");
  }
  const expectedModelRoot = join(paths.harnessRuntimes, `model-instance-${state.instanceId}`);
  if (realpathSync(state.modelReleaseRoot) !== realpathSync(expectedModelRoot)) {
    throw new CliError("运行中模型发布快照路径与实例身份不一致");
  }
  assertFrozenModelRelease(state.modelReleaseRoot, state.modelReleaseSha256);
  if (state.modelCatalogPath !== join(state.modelReleaseRoot, "catalog.json")
    || state.modelExportPath !== join(state.modelReleaseRoot, "model-export.json")
    || state.modelSettingsPath !== join(state.modelReleaseRoot, "settings.yaml")) {
    throw new CliError("运行中模型发布文件路径与实例身份不一致");
  }
}

function removeProcessRuntimeSnapshot(paths: RuntimePaths, state: ProcessState): void {
  const expectedRoot = join(paths.harnessRuntimes, `instance-${state.instanceId}`);
  if (resolve(state.harnessRuntimeRoot) === resolve(expectedRoot)) {
    rmSync(expectedRoot, { recursive: true, force: true });
  }
  const modelRoot = join(paths.harnessRuntimes, `model-instance-${state.instanceId}`);
  if (resolve(state.modelReleaseRoot) === resolve(modelRoot)) removeModelReleaseSnapshot(modelRoot);
}

function removeModelReleaseSnapshot(root: string): void {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliError("拒绝清理非普通模型发布实例目录");
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
}

function flockExecutable(): string {
  for (const candidate of ["/usr/bin/flock", "/bin/flock"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CliError("正式运行管理需要 util-linux flock 提供进程互斥");
}

interface PrivateRuntimeRequest {
  schemaVersion: 1;
  args: string[];
}

function currentProcessOwnsRuntimeLock(lockPath: string): boolean {
  let lock: ReturnType<typeof statSync>;
  try {
    lock = statSync(lockPath);
  } catch {
    return false;
  }
  try {
    for (const entry of readdirSync("/proc/self/fd")) {
      const descriptor = Number(entry);
      if (!Number.isSafeInteger(descriptor) || descriptor < 4) continue;
      try {
        const candidate = fstatSync(descriptor);
        if (candidate.dev !== lock.dev || candidate.ino !== lock.ino) continue;
        const fdInfo = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
        if (fdInfo.split(/\r?\n/).some((line) => {
          const match = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/i.exec(line);
          return match?.[1] === String(process.pid) && match[2] === String(lock.ino);
        })) return true;
      } catch {}
    }
  } catch {
    return false;
  }
  return false;
}

function readBoundedPrivateRequest(descriptor: number): Promise<string> {
  return new Promise((resolveRequest, reject) => {
    const stream = new Socket({ fd: descriptor, readable: true, writable: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new CliError("运行管理私有请求读取超时"))), 2_000);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 8 * 1024) {
        finish(() => reject(new CliError("运行管理私有请求超过 8 KiB 限制")));
        return;
      }
      chunks.push(buffer);
    });
    stream.once("end", () => finish(() => resolveRequest(Buffer.concat(chunks).toString("utf8"))));
    stream.once("error", (error) => finish(() => reject(error)));
  });
}

async function readPrivateRuntimeRequest(paths: RuntimePaths): Promise<PrivateRuntimeRequest | undefined> {
  try {
    const requestChannel = fstatSync(3);
    if (!requestChannel.isFIFO() && !requestChannel.isSocket()) return undefined;
    if (!currentProcessOwnsRuntimeLock(paths.processLock)) {
      throw new CliError("运行管理私有请求进程未持有目标互斥锁");
    }
    const value = JSON.parse(await readBoundedPrivateRequest(3)) as Partial<PrivateRuntimeRequest>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.args)
      || !value.args.every((argument) => typeof argument === "string")) {
      throw new CliError("运行管理私有请求结构无效");
    }
    return value as PrivateRuntimeRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBADF") return undefined;
    if (error instanceof CliError) throw error;
    throw new CliError("运行管理私有请求无法读取");
  }
}

async function runWithRuntimeLock(args: string[], paths: RuntimePaths, environment: NodeJS.ProcessEnv): Promise<number> {
  const descriptor = openSync(paths.processLock, "a", 0o600);
  closeSync(descriptor);
  chmodSync(paths.processLock, 0o600);
  const cliEntry = fileURLToPath(import.meta.url);
  const child = spawn(flockExecutable(), [
    "--no-fork", "--exclusive", "--nonblock", "--conflict-exit-code", "75", paths.processLock,
    process.execPath, cliEntry,
  ], { stdio: ["inherit", "inherit", "inherit", "pipe"], env: environment });
  const requestPipe = child.stdio[3];
  if (!requestPipe || !("end" in requestPipe)) {
    child.kill("SIGKILL");
    throw new CliError("无法建立运行管理私有请求管道");
  }
  requestPipe.on("error", () => {});
  requestPipe.end(JSON.stringify({ schemaVersion: 1, args } satisfies PrivateRuntimeRequest));
  return new Promise<number>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveCode(code ?? 1));
  });
}

function parseRuntimePort(environment: NodeJS.ProcessEnv): number {
  const value = environment.MAZE_ARENA_PORT ?? "3000";
  const port = Number(value);
  if (!Number.isSafeInteger(port) || (port !== 0 && (port < 1_024 || port > 65_535))) {
    throw new CliError("MAZE_ARENA_PORT 必须是 0 或 1024 到 65535 之间的整数");
  }
  return port;
}

function readStartupFrame(
  stream: Duplex,
  description: string,
  timeout: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolveFrame, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(deadline);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      stream.pause();
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (detail: string) => finish(() => reject(new CliError(`${description}${detail}`)));
    const onData = (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 8 * 1024) {
        fail("超过 8 KiB 限制");
        return;
      }
      chunks.push(buffer);
      const payload = Buffer.concat(chunks);
      const newline = payload.indexOf(0x0a);
      if (newline < 0) return;
      if (payload.subarray(newline + 1).length !== 0) {
        fail("结构无效");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(payload.subarray(0, newline).toString("utf8"));
      } catch {
        fail("结构无效");
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("结构无效");
        return;
      }
      finish(() => resolveFrame(value as Record<string, unknown>));
    };
    const onEnd = () => fail("在完成前关闭");
    const onError = () => fail("无法读取");
    const onClose = () => fail("在完成前关闭");
    const deadline = setTimeout(() => fail("超时"), timeout);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    stream.resume();
  });
}

function writeStartupFrame(stream: Duplex, value: object, description: string): Promise<void> {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > 8 * 1024) return Promise.reject(new CliError(`${description}超过 8 KiB 限制`));
  return new Promise((resolveWrite, reject) => {
    const onError = () => finish(() => reject(new CliError(`${description}无法写入`)));
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      stream.off("error", onError);
      callback();
    };
    stream.once("error", onError);
    stream.write(frame, (error) => {
      if (error) finish(() => reject(new CliError(`${description}无法写入`)));
      else finish(resolveWrite);
    });
  });
}

async function readStartupHandshake(
  stream: Duplex,
  expectedInstanceId: string,
  expectedPid: number,
  timeout = 10_000,
): Promise<StartupHandshake> {
  const record = await readStartupFrame(stream, "生产 Server 启动握手", timeout);
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== ["instanceId", "phase", "pid", "port", "schemaVersion"].sort().join("\n")
    || record.schemaVersion !== 1 || record.phase !== "ready" || record.instanceId !== expectedInstanceId
    || record.pid !== expectedPid || !Number.isSafeInteger(record.port)
    || Number(record.port) < 1_024 || Number(record.port) > 65_535) {
    throw new CliError("生产 Server 启动握手身份或端口无效");
  }
  return record as unknown as StartupHandshake;
}

async function commitStartupHandshake(stream: Duplex, handshake: StartupHandshake, timeout = 10_000): Promise<void> {
  const identity = {
    schemaVersion: 1,
    instanceId: handshake.instanceId,
    pid: handshake.pid,
    port: handshake.port,
  } as const;
  await writeStartupFrame(stream, { ...identity, phase: "commit" } satisfies StartupConfirmation, "生产 Server 启动确认");
  const record = await readStartupFrame(stream, "生产 Server 启动确认回执", timeout);
  const keys = Object.keys(record).sort();
  if (keys.join("\n") !== ["instanceId", "phase", "pid", "port", "schemaVersion"].sort().join("\n")
    || record.schemaVersion !== 1 || record.phase !== "committed" || record.instanceId !== handshake.instanceId
    || record.pid !== handshake.pid || record.port !== handshake.port) {
    throw new CliError("生产 Server 启动确认回执身份无效");
  }
}

async function terminateExactProcess(
  pid: number,
  procStartTime: string,
  gracefulTimeout = 5_000,
  forcedTimeout = 1_000,
): Promise<boolean> {
  let status = exactProcessStatus(pid, procStartTime);
  if (status === "exited") return true;
  if (status === "unknown") return false;
  try { process.kill(pid, "SIGTERM"); } catch {}
  let deadline = Date.now() + gracefulTimeout;
  while ((status = exactProcessStatus(pid, procStartTime)) === "running" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  status = exactProcessStatus(pid, procStartTime);
  if (status === "exited") return true;
  if (status === "unknown") return false;
  try { process.kill(pid, "SIGKILL"); } catch {}
  deadline = Date.now() + forcedTimeout;
  while ((status = exactProcessStatus(pid, procStartTime)) === "running" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  status = exactProcessStatus(pid, procStartTime);
  return status === "exited";
}

async function stopExactProcessGracefully(pid: number, procStartTime: string, timeout = 30_000): Promise<boolean> {
  let status = exactProcessStatus(pid, procStartTime);
  if (status === "exited") return true;
  if (status === "unknown") return false;
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + timeout;
  while ((status = exactProcessStatus(pid, procStartTime)) === "running" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  status = exactProcessStatus(pid, procStartTime);
  return status === "exited";
}

function healthCheck(port: number, instanceId: string, timeout = 1_000): Promise<boolean> {
  return new Promise((resolveHealth) => {
    let settled = false;
    let healthResponse: import("node:http").IncomingMessage | undefined;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      healthResponse?.destroy();
      healthRequest.destroy();
      resolveHealth(healthy);
    };
    const healthRequest = request({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, (response) => {
      healthResponse = response;
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) {
          finish(false);
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", () => finish(false));
      response.once("aborted", () => finish(false));
      response.once("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: unknown; instanceId?: unknown };
          finish(response.statusCode === 200 && value.status === "ok" && value.instanceId === instanceId);
        } catch { finish(false); }
      });
    });
    const deadline = setTimeout(() => finish(false), timeout);
    healthRequest.once("error", () => finish(false));
    healthRequest.end();
  });
}

async function waitForHealth(state: ProcessState, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const processStatus = recordedProcessStatus(state);
    if (processStatus === "exited") return false;
    if (processStatus === "unknown") throw new CliError(`无法验证生产 Server 进程身份：PID ${state.pid}`);
    if (await healthCheck(state.port, state.instanceId)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function formalRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  paths: RuntimePaths,
  manifest: InstallManifest,
  modelRelease: { catalogPath: string; exportPath: string; settingsPath: string; sha256: string },
  webRoot: string,
  port: number,
  instanceId: string,
  harnessRuntime: { runtimeRoot: string; executablePath: string },
  credentialNames: readonly string[],
): NodeJS.ProcessEnv {
  const inherited = ["HOME", "LANG", "LC_ALL", "NODE_OPTIONS", "PATH", "TMPDIR"]
    .flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]]);
  const inheritedPath = environment.PATH ?? "";
  const runtimeBin = validateFrozenPnpm(harnessRuntime.runtimeRoot);
  const credentials = Object.fromEntries(credentialNames.flatMap((name) =>
    environment[name] === undefined ? [] : [[name, environment[name]!]]));
  return {
    ...Object.fromEntries(inherited),
    ...credentials,
    PATH: inheritedPath ? `${runtimeBin}${delimiter}${inheritedPath}` : runtimeBin,
    NODE_ENV: "production",
    PORT: String(port),
    ARENA_INSTANCE_ID: instanceId,
    ARENA_STARTUP_HANDSHAKE_FD: "3",
    ARENA_DATABASE_PATH: join(paths.dataRoot, "maze-arena.sqlite"),
    ARENA_MODEL_CATALOG_PATH: modelRelease.catalogPath,
    ARENA_MODEL_CATALOG_RELEASE: modelRelease.sha256,
    ARENA_MODEL_RELEASE_SHA256: modelRelease.sha256,
    ARENA_HARNESS_PACKAGE: manifest.harness.packageName,
    ARENA_HARNESS_PACKAGE_VERSION: manifest.harness.packageVersion,
    ARENA_MATCH_IMAGE: manifest.matchProfile!.imageReference,
    ARENA_MATCH_TRUSTED_ROOT: join(paths.dataRoot, "harness"),
    ARENA_MATCH_PROTOCOL_PACKAGE: join(repositoryRoot, "packages/match-profile"),
    ARENA_GENERATOR_PLUGIN_PACKAGE: join(repositoryRoot, "packages/generator-plugin"),
    ARENA_SOLVER_PLUGIN_PACKAGE: join(repositoryRoot, "packages/solver-plugin"),
    ARENA_WEB_ROOT: webRoot,
    DSH_EXECUTABLE: harnessRuntime.executablePath,
    DSH_HOME: join(paths.dataRoot, "harness"),
    DSH_MODEL_EXPORT_PATH: modelRelease.exportPath,
    DSH_MODEL_SETTINGS_PATH: modelRelease.settingsPath,
    DSH_HARNESS_VERSION: manifest.harness.executable.version,
    DSH_EVOLUTION_COMMAND: join(harnessRuntime.runtimeRoot, "maze-arena/dsh-sdk-adapter.js"),
    DSH_SMOKE_COMMAND: join(harnessRuntime.runtimeRoot, "maze-arena/dsh-sdk-adapter.js"),
    DSH_EVOLUTION_EXECUTION_KIND: "real-provider",
    DSH_UNSHARE_EXECUTABLE: unshareExecutable,
    DSH_BWRAP_EXECUTABLE: manifest.isolation.bubblewrap.path,
    DSH_HARNESS_RUNTIME_ROOT: harnessRuntime.runtimeRoot,
    DSH_HARNESS_RUNTIME_SHA256: manifest.harness.executable.payloadSha256,
  };
}

async function doctor(
  environment: NodeJS.ProcessEnv,
  printDiagnostics = true,
  loadCredentialFile = true,
): Promise<ValidatedDoctorContext> {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  const { diagnostics, bubblewrapVersion } = validateTools();
  if (bubblewrapVersion !== manifest.isolation.bubblewrap.version) {
    throw new CliError(`bubblewrap 版本漂移：期望 ${manifest.isolation.bubblewrap.version}`);
  }
  validateDirectoryPermissions(paths);
  const { executablePath, runtimeRoot } = validateFrozenHarnessRuntime(manifest);
  await validateSandboxedHarnessVersion(
    executablePath,
    runtimeRoot,
    manifest.harness.executable.version,
    environment,
    "dsh 版本漂移",
    manifest.harness.executable.payloadSha256,
  );
  const actualPayloadSha256 = hashHarnessRuntimePayload(runtimeRoot);
  if (actualPayloadSha256 !== manifest.harness.executable.payloadSha256) {
    throw new CliError(`Harness runtime 载荷内容漂移：期望 ${manifest.harness.executable.payloadSha256}，实际 ${actualPayloadSha256}`);
  }
  validateDockerSecurityCapabilities();
  validateMatchProfileImage(manifest);
  const catalog = validateModelCatalog(paths, manifest);
  const runtimeEnvironment = loadCredentialFile
    ? loadUserEnvironment(paths, environment, catalog.credentialNames)
    : { ...environment };
  const sensitiveValues = sensitiveEnvironmentValues(runtimeEnvironment, catalog.credentialNames);
  const build = validateProductionBuild();
  const backup = createBackupManager(paths, manifest, catalog.release, sensitiveValues);
  backup.assertSourceDatabaseSchemaSupported();
  if (hasRegisteredLineages(join(paths.dataRoot, "maze-arena.sqlite"))) {
    const latest = backup.latestComplete();
    if (!latest) throw new CliError("正式运行数据存在，但最近完整备份缺失或校验失败");
    if (printDiagnostics) process.stdout.write(`检查通过：最近完整备份 ${latest.manifest.backupId}\n`);
  }
  if (printDiagnostics) {
    for (const diagnostic of diagnostics) process.stdout.write(`${diagnostic}\n`);
    process.stdout.write("检查通过：正式运行目录权限正确\n");
    process.stdout.write("检查通过：DeepSeek Harness 身份未漂移\n");
    process.stdout.write(`检查通过：Match Profile 镜像 ${manifest.matchProfile!.imageReference}\n`);
    process.stdout.write(`检查通过：Harness 模型目录 ${catalog.release}\n`);
    process.stdout.write("检查通过：生产 Server 与 Web 构建产物可用\n");
    process.stdout.write("检查通过：Docker seccomp 与 cgroupns 安全能力可用\n");
  }
  return { manifest, catalog, build, runtimeEnvironment, sensitiveValues };
}

function createBackupManager(
  paths: RuntimePaths,
  manifest: InstallManifest,
  modelCatalogRelease: string,
  sensitiveValues: SensitiveEnvironmentValueSet,
): RuntimeBackupManager {
  if (!manifest.matchProfile) throw new CliError("Match Profile 镜像尚未构建，请先运行 image build");
  return new RuntimeBackupManager({
    databasePath: join(paths.dataRoot, "maze-arena.sqlite"),
    lineageRoot: join(paths.dataRoot, "lineages"),
    backupsRoot: paths.backups,
    runtimeIdentity: {
      harnessPackage: manifest.harness.packageName,
      harnessVersion: manifest.harness.executable.version,
      modelCatalogRelease,
      modelReleaseSha256: modelCatalogRelease,
      imageDigest: manifest.matchProfile.imageReference,
    },
    sensitiveValues,
  });
}

function hasRegisteredLineages(databasePath: string): boolean {
  if (!existsSync(databasePath)) return false;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lineage_repositories'").get();
    if (!table) return false;
    return Boolean(database.prepare("SELECT 1 FROM lineage_repositories LIMIT 1").get());
  } finally { database.close(); }
}

function assertServerStopped(paths: RuntimePaths): void {
  const state = readProcessState(paths);
  if (state && requireKnownProcessStatus(state) === "running") {
    throw new CliError("一致性备份创建或恢复要求 Maze Arena 服务已停止");
  }
}

function parseBackupPath(args: string[], action: "verify" | "restore"): { backupPath: string; target?: string } {
  if (action === "verify" && args.length === 1) return { backupPath: resolve(args[0]!) };
  if (action === "restore" && args.length === 3 && args[1] === "--target") {
    return { backupPath: resolve(args[0]!), target: args[2]! };
  }
  throw new CliError(action === "verify"
    ? "用法：maze-arena backup verify <备份目录>"
    : "用法：maze-arena backup restore <备份目录> --target <绝对隔离目录>");
}

function backupCommand(args: string[], environment: NodeJS.ProcessEnv): void {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  validateDirectoryPermissions(paths);
  const catalog = validateModelCatalog(paths, manifest);
  const runtimeEnvironment = loadUserEnvironment(paths, environment, catalog.credentialNames);
  const sensitiveValues = sensitiveEnvironmentValues(runtimeEnvironment, catalog.credentialNames);
  const manager = createBackupManager(paths, manifest, catalog.release, sensitiveValues);
  const [action, ...rest] = args;
  if (action === "create" && rest.length === 0) {
    assertServerStopped(paths);
    const result = manager.create("manual");
    process.stdout.write(`完整备份已创建：${redactBackupOutput(result.path, redactionSensitiveValues(sensitiveValues))}\n`);
    for (const warning of result.rotationWarnings) process.stdout.write(`警告：${warning}\n`);
    process.stdout.write("备份未由应用加密，请依赖操作系统保护磁盘与备份介质\n");
    return;
  }
  if (action === "verify") {
    const { backupPath } = parseBackupPath(rest, "verify");
    const verified = manager.verify(backupPath);
    process.stdout.write(`完整备份校验通过：${verified.backupId}\n`);
    return;
  }
  if (action === "restore") {
    assertServerStopped(paths);
    const { backupPath, target } = parseBackupPath(rest, "restore");
    const restored = manager.restore(backupPath, target!);
    process.stdout.write(`完整备份已恢复到隔离目录：${redactBackupOutput(target!, redactionSensitiveValues(sensitiveValues))}\n备份身份：${restored.backupId}\n`);
    return;
  }
  throw new CliError("用法：maze-arena backup <create|verify|restore> [参数]");
}

function redactBackupOutput(value: string, sensitiveValues: string[]): string {
  return [...sensitiveValues].sort((left, right) => right.length - left.length)
    .reduce((sanitized, secret) => sanitized.split(secret).join("[REDACTED]"), value);
}

async function start(environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const existing = readProcessState(paths);
  if (existing) {
    const processStatus = requireKnownProcessStatus(existing);
    if (processStatus === "running") {
      assertFrozenProcessRuntime(paths, existing);
      const healthy = await healthCheck(existing.port, existing.instanceId);
      if (!healthy) throw new CliError(`Maze Arena 进程仍存在但 HTTP 健康检查失败：PID ${existing.pid}`);
      process.stdout.write(`Maze Arena 已在运行：PID ${existing.pid}，http://127.0.0.1:${existing.port}\n`);
      return;
    }
    removeProcessRuntimeSnapshot(paths, existing);
    rmSync(paths.processState, { force: true });
  }

  // 使用同一份已验证上下文创建实例快照，避免 doctor 后重新读取可交换的清单。
  const { manifest, catalog, build, runtimeEnvironment } = await doctor(environment, true, true);
  const port = parseRuntimePort(environment);
  const instanceId = randomUUID();
  const instanceRuntime = materializeHarnessRuntimeSnapshot(
    paths,
    manifest.harness.executable.runtimeRoot,
    manifest.harness.executable.path,
    manifest.harness.executable.payloadSha256,
    manifest.harness.executable.sha256,
    `instance-${instanceId}`,
  );
  const instanceModelRelease = materializeModelReleaseSnapshot(paths, catalog, instanceId);
  const logPath = join(paths.logs, `server-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const logDescriptor = openSync(logPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [build.serverEntry], {
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor, "pipe"],
      env: formalRuntimeEnvironment(
        runtimeEnvironment,
        paths,
        manifest,
        instanceModelRelease,
        build.webRoot,
        port,
        instanceId,
        instanceRuntime,
        catalog.credentialNames,
      ),
    });
  } finally {
    closeSync(logDescriptor);
  }
  if (!child.pid) throw new CliError("生产 Server 进程未能启动");
  const startupPipe = child.stdio[3] as Duplex | null;
  const procStartTime = await waitForProcessStartTime(child.pid);
  if (!startupPipe || procStartTime === null) {
    startupPipe?.destroy();
    // 这里只能使用刚创建的 ChildProcess 句柄温和终止；缺少 /proc 身份时禁止按裸 PID 强杀。
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw new CliError("无法建立生产 Server 启动身份与私有握手管道");
  }
  let state: ProcessState | undefined;
  try {
    const handshake = await readStartupHandshake(startupPipe, instanceId, child.pid);
    state = {
      schemaVersion: 1,
      pid: child.pid,
      procStartTime,
      instanceId,
      port: handshake.port,
      startedAt: new Date().toISOString(),
      databasePath: join(paths.dataRoot, "maze-arena.sqlite"),
      harnessPackage: manifest.harness.packageName,
      harnessPackageVersion: manifest.harness.packageVersion,
      harnessVersion: manifest.harness.executable.version,
      harnessExecutablePath: instanceRuntime.executablePath,
      harnessExecutableSha256: manifest.harness.executable.sha256,
      harnessRuntimeRoot: instanceRuntime.runtimeRoot,
      harnessRuntimePayloadSha256: manifest.harness.executable.payloadSha256,
      harnessAdapterPath: join(instanceRuntime.runtimeRoot, "maze-arena/dsh-sdk-adapter.js"),
      harnessAdapterSha256: manifest.harness.adapter.sha256,
      modelCatalogRelease: catalog.release,
      modelReleaseRoot: instanceModelRelease.root,
      modelReleaseSha256: instanceModelRelease.sha256,
      modelCatalogPath: instanceModelRelease.catalogPath,
      modelExportPath: instanceModelRelease.exportPath,
      modelSettingsPath: instanceModelRelease.settingsPath,
      imageDigest: manifest.matchProfile!.imageReference,
      logPath,
    };
    writeProcessState(paths, state);
    await commitStartupHandshake(startupPipe, handshake);
    startupPipe.destroy();
    child.unref();
    if (!await waitForHealth(state, 15_000)) {
      throw new CliError(`生产 Server 未通过启动健康检查，请查看净化日志：${logPath}`);
    }
  } catch (error) {
    startupPipe.destroy();
    const stopped = await terminateExactProcess(child.pid, procStartTime);
    if (stopped) {
      rmSync(paths.processState, { force: true });
      rmSync(instanceRuntime.runtimeRoot, { recursive: true, force: true });
      removeModelReleaseSnapshot(instanceModelRelease.root);
    }
    else throw new CliError(`生产 Server 启动失败且无法安全清理，运行状态已保留；请查看净化日志：${logPath}`);
    throw error;
  }
  process.stdout.write(`Maze Arena 已启动：PID ${state.pid}，http://127.0.0.1:${state.port}\n`);
  process.stdout.write(`数据库：${state.databasePath}\n日志：${state.logPath}\n`);
}

async function stop(environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const state = readProcessState(paths);
  if (!state) {
    rmSync(paths.processState, { force: true });
    process.stdout.write("Maze Arena 已停止\n");
    return;
  }
  const processStatus = requireKnownProcessStatus(state);
  if (processStatus === "exited") {
    removeProcessRuntimeSnapshot(paths, state);
    rmSync(paths.processState, { force: true });
    process.stdout.write("Maze Arena 已停止\n");
    return;
  }
  await healthCheck(state.port, state.instanceId);
  if (!await stopExactProcessGracefully(state.pid, state.procStartTime)) {
    throw new CliError("Maze Arena 未能安全停止，可能仍有活动原子步骤；运行状态已保留，可稍后重试 stop 或检查 status");
  }
  rmSync(paths.processState, { force: true });
  removeProcessRuntimeSnapshot(paths, state);
  process.stdout.write("Maze Arena 已安全停止\n");
}

async function status(environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const state = readProcessState(paths);
  if (!state || requireKnownProcessStatus(state) === "exited") {
    if (state) {
      removeProcessRuntimeSnapshot(paths, state);
      rmSync(paths.processState, { force: true });
    }
    const manifest = readManifest(paths);
    const catalog = validateModelCatalog(paths, manifest);
    if (!manifest.matchProfile) throw new CliError("Match Profile 镜像尚未构建，请先运行 image build");
    process.stdout.write("进程：已停止\nHTTP：不可用\n");
    process.stdout.write(`数据库：${join(paths.dataRoot, "maze-arena.sqlite")}\n`);
    process.stdout.write(`Harness：${manifest.harness.packageName}@${manifest.harness.packageVersion}\n`);
    process.stdout.write(`模型目录版本：${catalog.release}\n`);
    process.stdout.write(`镜像摘要：${manifest.matchProfile.imageReference}\n`);
    return;
  }
  assertFrozenProcessRuntime(paths, state);
  const healthy = await healthCheck(state.port, state.instanceId);
  process.stdout.write(`进程：运行中（PID ${state.pid}）\n`);
  process.stdout.write(`HTTP：${healthy ? "健康" : "异常"}（http://127.0.0.1:${state.port}）\n`);
  process.stdout.write(`数据库：${state.databasePath}\n`);
  process.stdout.write(`Harness：${state.harnessPackage}@${state.harnessPackageVersion}（dsh ${state.harnessVersion}）\n`);
  process.stdout.write(`模型目录版本：${state.modelCatalogRelease}\n`);
  process.stdout.write(`镜像摘要：${state.imageDigest}\n`);
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new CliError(`${label}必须为正整数`);
  return parsed;
}

function parsePositiveNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CliError(`${label}必须为正有限数字`);
  return parsed;
}

function parseCanaryRequest(args: string[]): RealDshCanaryRequest {
  const allowed = new Set([
    "--name", "--provider", "--model", "--credential-ref", "--context-tokens", "--output-tokens",
    "--token-limit", "--cost-limit", "--reasoning-effort", "--temperature", "--top-p",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || value === undefined || value.startsWith("--") || values.has(name)) {
      throw new CliError("canary 参数必须使用唯一的 --name value 形式");
    }
    values.set(name, value);
  }
  const requireText = (name: string, label: string) => {
    const value = values.get(name)?.trim();
    if (!value) throw new CliError(`${label}不能为空`);
    return value;
  };
  const tokenLimit = parsePositiveInteger(values.get("--token-limit"), "令牌上限");
  if (tokenLimit > REAL_DSH_CANARY_MAX_TOKENS) {
    throw new CliError(`金丝雀令牌上限不得超过 ${REAL_DSH_CANARY_MAX_TOKENS}`);
  }
  const contextTokens = parsePositiveInteger(values.get("--context-tokens"), "上下文令牌");
  const outputTokens = parsePositiveInteger(values.get("--output-tokens"), "输出令牌");
  const perSessionTokenLimit = contextTokens + outputTokens;
  if (!Number.isSafeInteger(perSessionTokenLimit) || perSessionTokenLimit * 2 > tokenLimit) {
    throw new CliError("金丝雀总令牌上限必须至少覆盖 Generator 与 Solver 两个会话的上下文和输出预算");
  }
  const profile: ModelProfileInput = {
    providerId: requireText("--provider", "提供方"),
    modelId: requireText("--model", "模型"),
    credentialRef: requireText("--credential-ref", "凭据引用"),
    contextTokens,
    outputTokens,
    totalTokenLimit: perSessionTokenLimit,
  };
  const reasoning = values.get("--reasoning-effort");
  if (reasoning) {
    if (!(["off", "low", "high", "max"] as const).includes(reasoning as "off" | "low" | "high" | "max")) {
      throw new CliError("推理强度只允许 off、low、high 或 max");
    }
    profile.reasoningEffort = reasoning as "off" | "low" | "high" | "max";
  }
  if (values.has("--temperature")) profile.temperature = Number(values.get("--temperature"));
  if (values.has("--top-p")) profile.topP = Number(values.get("--top-p"));
  if (profile.temperature !== undefined && !Number.isFinite(profile.temperature)) throw new CliError("temperature 必须为有限数字");
  if (profile.topP !== undefined && !Number.isFinite(profile.topP)) throw new CliError("top-p 必须为有限数字");
  const costLimit = parsePositiveNumber(values.get("--cost-limit"), "成本上限");
  if (costLimit > REAL_DSH_CANARY_MAX_COST) {
    throw new CliError(`金丝雀成本上限不得超过 ${REAL_DSH_CANARY_MAX_COST}`);
  }
  return {
    name: requireText("--name", "金丝雀名称"),
    modelProfile: profile,
    tokenLimit,
    costLimit,
    operatorConfirmed: true,
  };
}

function assertCanaryCredentialConfigured(
  requestBody: RealDshCanaryRequest,
  environment: NodeJS.ProcessEnv,
  environmentFile: string,
): void {
  const prefix = "dsh-credential://";
  const reference = requestBody.modelProfile.credentialRef;
  const name = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  if (!environmentNamePattern.test(name)) throw new CliError("金丝雀凭据引用必须使用 dsh-credential://POSIX_NAME 格式");
  if (!environment[name]) {
    throw new CliError(`金丝雀凭据 ${name} 未配置；请写入 ${environmentFile} 或在进程环境中设置`);
  }
}

function localJsonRequest<T>(
  state: ProcessState,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeout = 10_000,
): Promise<T> {
  return new Promise((resolveResponse, reject) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const requestHandle = request({
      host: "127.0.0.1",
      port: state.port,
      path,
      method,
      headers: serialized ? { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          response.destroy(new Error("金丝雀 API 响应超过 2 MiB 限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new CliError("金丝雀 API 未返回合法 JSON")); return; }
        if ((response.statusCode ?? 500) >= 400) {
          const record = value as { error?: { message?: unknown }; reason?: unknown };
          const reason = typeof record.error?.message === "string" ? record.error.message
            : typeof record.reason === "string" ? record.reason : "金丝雀 API 拒绝请求";
          reject(new CliError(reason));
          return;
        }
        resolveResponse(value as T);
      });
    });
    requestHandle.once("error", () => reject(new CliError("无法连接本机 Maze Arena Server")));
    requestHandle.setTimeout(timeout, () => requestHandle.destroy(new Error("金丝雀 API 请求超时")));
    if (serialized) requestHandle.end(serialized); else requestHandle.end();
  });
}

function persistCanaryReport(paths: RuntimePaths, report: RealDshCanaryReport): string {
  mkdirSync(paths.canaryReports, { recursive: true, mode: 0o700 });
  chmodSync(paths.canaryReports, 0o700);
  const target = join(paths.canaryReports, `${report.canaryId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return target;
}

async function canary(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  if (environment.DSH_EVOLUTION_EXECUTION_KIND && environment.DSH_EVOLUTION_EXECUTION_KIND !== "real-provider") {
    throw new CliError("正式金丝雀只允许 executionKind=real-provider，拒绝确定性夹具或 Fake Harness");
  }
  const requestBody = parseCanaryRequest(args);
  const paths = runtimePaths(environment);
  const context = await doctor(environment, false, true);
  assertCanaryCredentialConfigured(requestBody, context.runtimeEnvironment, paths.environmentFile);
  const state = readProcessState(paths);
  if (!state || requireKnownProcessStatus(state) !== "running" || !await healthCheck(state.port, state.instanceId)) {
    throw new CliError("真实金丝雀要求已经由正式 start 启动且健康的本机 Server");
  }
  const latest = createBackupManager(
    paths,
    context.manifest,
    context.catalog.release,
    context.sensitiveValues,
  ).latestComplete();
  if (!latest) throw new CliError("真实金丝雀开始前必须存在已校验的最近完整备份");
  process.stdout.write(`金丝雀预算上限：${requestBody.tokenLimit} tokens，成本 ${requestBody.costLimit}\n`);
  process.stdout.write(`前置身份：镜像 ${context.manifest.matchProfile!.imageReference}，备份 ${latest.manifest.backupId}\n`);
  let report = await localJsonRequest<RealDshCanaryReport>(state, "POST", "/api/canaries", requestBody, 45 * 60_000);
  const deadline = Date.now() + 45 * 60_000;
  while (report.status === "running" && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    report = await localJsonRequest<RealDshCanaryReport>(state, "GET", `/api/canaries/${encodeURIComponent(report.canaryId)}`);
  }
  if (report.status === "running") throw new CliError("真实金丝雀在四十五分钟内未完成，实验保持可审计状态");
  const reportPath = persistCanaryReport(paths, report);
  process.stdout.write(`验收报告：${reportPath}\n`);
  process.stdout.write(`mechanismClosed=${report.mechanismClosed}\npromoted=${report.promoted}\nformalAcceptancePassed=${report.formalAcceptancePassed}\n`);
  process.stdout.write(`结论：${report.reason}\n非保证：${report.nonGuarantee}\n`);
  if (!report.formalAcceptancePassed) throw new CliError("真实 DSH 金丝雀未通过正式验收；报告已持久化");
}

function usage(): never {
  throw new CliError("用法：maze-arena <install|image build|models sync|doctor|start|stop|status|backup|canary> [参数]");
}

async function main(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const privateRequest = await readPrivateRuntimeRequest(paths);
  const locked = privateRequest !== undefined;
  if (privateRequest) args = privateRequest.args;
  const [command, ...rest] = args;
  if (command === "install") return install(rest, environment);
  if (command === "image" && rest[0] === "build") return buildMatchProfileImage(rest.slice(1), environment);
  if (command === "models" && rest[0] === "sync" && rest.length === 1) return syncHarnessModels(environment);
  if (command === "doctor" && rest.length === 0) {
    await doctor(environment);
    return;
  }
  if (command === "backup") {
    if (locked) return backupCommand(rest, environment);
    const code = await runWithRuntimeLock(args, paths, environment);
    if (code === 75) throw new CliError("另一个运行管理命令正在执行");
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (command === "canary") {
    const canaryArgs = rest[0] === "run" ? rest.slice(1) : rest;
    if (locked) return canary(canaryArgs, environment);
    if (environment.DSH_EVOLUTION_EXECUTION_KIND && environment.DSH_EVOLUTION_EXECUTION_KIND !== "real-provider") {
      throw new CliError("正式金丝雀只允许 executionKind=real-provider，拒绝确定性夹具或 Fake Harness");
    }
    parseCanaryRequest(canaryArgs);
    if (!existsSync(paths.manifest) || !existsSync(paths.runtime)) {
      throw new CliError("真实金丝雀尚未配置正式安装，请先完成 install、image build、models sync、backup create 与 start");
    }
    const code = await runWithRuntimeLock(args, paths, environment);
    if (code === 75) throw new CliError("另一个运行管理命令正在执行");
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (command === "start" && rest.length === 0) {
    if (locked) return start(environment);
    const code = await runWithRuntimeLock(args, paths, environment);
    if (code === 75) throw new CliError("另一个运行管理命令正在执行");
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (command === "stop" && rest.length === 0) {
    if (locked) return stop(environment);
    const code = await runWithRuntimeLock(args, paths, environment);
    if (code === 75) throw new CliError("另一个运行管理命令正在执行");
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (command === "status" && rest.length === 0) {
    if (locked) return status(environment);
    const code = await runWithRuntimeLock(args, paths, environment);
    if (code === 75) throw new CliError("另一个运行管理命令正在执行");
    if (code !== 0) process.exitCode = code;
    return;
  }
  return usage();
}

try {
  await main(process.argv.slice(2), process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误：${message}\n`);
  process.exitCode = 1;
}
