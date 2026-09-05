#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RuntimeBackupManager, sensitiveEnvironmentValues } from "@maze-arena/backup";
import {
  createHarnessNetworkSeccompProgram,
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
}

interface ProcessState {
  schemaVersion: 1;
  pid: number;
  procStartTime: string;
  instanceId: string;
  port: number;
  startedAt: string;
  databasePath: string;
  harnessCommit: string;
  harnessVersion: string;
  harnessExecutablePath: string;
  harnessExecutableSha256: string;
  harnessRuntimeRoot: string;
  harnessRuntimePayloadSha256: string;
  modelCatalogRelease: string;
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
    sourceDirectory: string;
    commit: string;
    executable: {
      sourcePath: string;
      sourceRuntimeRoot: string;
      path: string;
      runtimeRoot: string;
      payloadSha256: string;
      sha256: string;
      version: string;
    };
  };
  isolation: {
    bubblewrap: { path: string; version: string };
  };
  matchProfile?: {
    imageId: string;
    imageReference: string;
    projectArtifactSha256: string;
    harnessCommit: string;
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
  };
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
    "检查通过：Harness Unix socket 系统调用已隔离且 TCP 回环可用",
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
  sourceRuntimeRoot: string,
  sourceExecutable: string,
  payloadSha256: string,
  executableSha256: string,
  snapshotName = payloadSha256,
): { runtimeRoot: string; executablePath: string } {
  if (!/^(?:[0-9a-f]{64}|instance-[0-9a-f-]{36})$/.test(snapshotName)) {
    throw new CliError("Harness 私有 runtime 快照名称无效");
  }
  const executableLocalPath = relative(sourceRuntimeRoot, sourceExecutable);
  if (!executableLocalPath || executableLocalPath === ".." || executableLocalPath.startsWith(`..${sep}`) || isAbsolute(executableLocalPath)) {
    throw new CliError("dsh 可执行文件必须位于声明的来源运行根内");
  }
  const runtimeRoot = join(paths.harnessRuntimes, snapshotName);
  const staging = join(paths.harnessRuntimes, `.staging-${process.pid}-${randomUUID()}`);
  try {
    if (!existsSync(runtimeRoot)) {
      cpSync(sourceRuntimeRoot, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
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

function findHarnessRuntimePackage(sourceDirectory: string): HarnessRuntimePackage {
  const matches: HarnessRuntimePackage[] = [];
  const pending = [sourceDirectory];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name === "package.json") {
        let manifest: { name?: unknown; bin?: unknown };
        try {
          manifest = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
          throw new CliError(`Harness package.json 无效：${path}：${(error as Error).message}`);
        }
        const bin = typeof manifest.bin === "string"
          ? manifest.bin
          : manifest.bin && typeof manifest.bin === "object"
            ? (manifest.bin as Record<string, unknown>).dsh
            : undefined;
        if (typeof manifest.name === "string" && typeof bin === "string") {
          const declaredExecutable = resolve(directory, bin);
          const relation = relative(directory, declaredExecutable);
          if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
            throw new CliError(`Harness dsh bin 禁止越出所属运行包：${bin}`);
          }
          matches.push({ name: manifest.name, root: directory, executable: bin });
        }
      }
    }
  }
  if (matches.length !== 1) {
    throw new CliError(`锁定 Harness 源码必须且只能包含一个声明 dsh bin 的运行包，实际 ${matches.length} 个`);
  }
  const match = matches[0]!;
  return match;
}

function validateDeployedHarnessRuntime(runtimeRoot: string, expected: HarnessRuntimePackage, executableSha256: string): string {
  const manifestPath = join(runtimeRoot, "package.json");
  if (!existsSync(manifestPath)) throw new CliError("Harness 生产部署缺少 package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    bin?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const bin = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === "object"
      ? (manifest.bin as Record<string, unknown>).dsh
      : undefined;
  if (manifest.name !== expected.name || typeof bin !== "string" || bin !== expected.executable) {
    throw new CliError("Harness 生产部署的包名或 dsh 入口与锁定源码不一致");
  }
  const deployedExecutable = resolveFile(join(runtimeRoot, bin), "Harness 生产部署 dsh 入口");
  if (sha256(deployedExecutable) !== executableSha256) {
    throw new CliError("Harness 生产部署 dsh 入口与安装清单中的可执行文件身份不一致");
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const dependencyRoot = join(runtimeRoot, "node_modules", ...dependency.split("/"));
    if (!existsSync(join(dependencyRoot, "package.json"))) {
      throw new CliError(`Harness 生产部署缺少运行依赖：${dependency}`);
    }
  }
  return bin.split(sep).join("/");
}

function currentHarnessCommit(sourceDirectory: string): string {
  return run("git", ["-C", sourceDirectory, "rev-parse", "HEAD"]);
}

function validateCleanHarnessWorktree(sourceDirectory: string): void {
  const status = run("git", ["-C", sourceDirectory, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new CliError("Harness 源码工作树不干净");
}

function validateCommit(commit: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new CliError("Harness 固定提交必须是 40 位小写 Git 对象 ID");
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
  executable: string,
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
    DSH_HOME: resolve(harnessHome),
  });
  try {
    const result = await runIsolatedHarnessCommand({
      command: executable,
      args: ["models", "export", "--schema-version", "1", "--format", "json"],
      runtimeRoot,
      expectedRuntimePayloadSha256: payloadSha256,
      environment: childEnvironment,
      timeoutMs: 30_000,
      cwd: workspace,
      writablePaths: [sessionHome, workspace],
      readOnlyPaths: [harnessHome],
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

function validateExistingModelRelease(release: string, serialized: string): void {
  try {
    const releaseStat = lstatSync(release);
    if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory() || (releaseStat.mode & 0o777) !== 0o500) {
      throw new Error("invalid release");
    }
    const catalogPath = join(release, "catalog.json");
    const catalogStat = lstatSync(catalogPath);
    if (catalogStat.isSymbolicLink() || !catalogStat.isFile() || (catalogStat.mode & 0o777) !== 0o400
      || readFileSync(catalogPath, "utf8") !== serialized) {
      throw new Error("invalid catalog");
    }
  } catch {
    throw new CliError("已存在的同摘要模型目录不满足不可变发布约束，拒绝发布");
  }
}

async function syncHarnessModels(environment: NodeJS.ProcessEnv): Promise<void> {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  validateDirectoryPermissions(paths);
  const sourceDirectory = resolveDirectory(manifest.harness.sourceDirectory, "Harness 源码目录");
  if (currentHarnessCommit(sourceDirectory) !== manifest.harness.commit) throw new CliError("Harness 源码提交已漂移，拒绝同步模型目录");
  validateCleanHarnessWorktree(sourceDirectory);
  const executable = resolveFile(manifest.harness.executable.path, "dsh 可执行文件");
  if (sha256(executable) !== manifest.harness.executable.sha256) throw new CliError("dsh 可执行文件内容已漂移，拒绝同步模型目录");
  await validateSandboxedHarnessVersion(
    executable,
    manifest.harness.executable.runtimeRoot,
    manifest.harness.executable.version,
    environment,
    "dsh 精确版本已漂移，拒绝同步模型目录",
    manifest.harness.executable.payloadSha256,
  );

  let raw: unknown;
  try {
    raw = JSON.parse(await runHarnessModelExport(
      executable,
      manifest.harness.executable.runtimeRoot,
      manifest.harness.executable.payloadSha256,
      environment,
      join(paths.dataRoot, "harness"),
    ));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("Harness 模型导出不是有效 JSON");
  }
  const catalog = parseHarnessModelCatalog(raw, manifest.harness.executable.version);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const releaseId = createHash("sha256").update(serialized).digest("hex");
  const modelsRoot = join(paths.dataRoot, "models");
  const releasesRoot = join(modelsRoot, "releases");
  const release = join(releasesRoot, releaseId);
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  chmodSync(releasesRoot, 0o700);
  if (lstatSync(release, { throwIfNoEntry: false })) {
    validateExistingModelRelease(release, serialized);
  } else {
    const staging = mkdtempSync(join(modelsRoot, ".sync-"));
    try {
      const catalogPath = join(staging, "catalog.json");
      writeFileSync(catalogPath, serialized, { mode: 0o400, flag: "wx" });
      chmodSync(catalogPath, 0o400);
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
  const allowed = new Set(["--harness-source", "--harness-commit", "--dsh-executable", "--dsh-version"]);
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

async function install(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  const options = parseInstallOptions(args);
  const { diagnostics, bubblewrapVersion } = validateTools();
  const sourceDirectory = resolveDirectory(options["--harness-source"]!, "Harness 源码目录");
  const commit = options["--harness-commit"]!;
  validateCommit(commit);
  const actualCommit = currentHarnessCommit(sourceDirectory);
  if (actualCommit !== commit) throw new CliError(`Harness 源码提交不匹配：期望 ${commit}，实际 ${actualCommit}`);
  validateCleanHarnessWorktree(sourceDirectory);
  const executablePath = resolveFile(options["--dsh-executable"]!, "dsh 可执行文件");
  const sourceRuntimeRoot = resolveHarnessRuntimeRoot(executablePath);
  const expectedVersion = options["--dsh-version"]!;
  await validateSandboxedHarnessVersion(
    executablePath,
    sourceRuntimeRoot,
    expectedVersion,
    environment,
    "dsh 版本不匹配",
  );

  const paths = runtimePaths(environment);
  ensureDirectories(paths);
  const executableSha256 = sha256(executablePath);
  const payloadSha256 = hashHarnessRuntimePayload(sourceRuntimeRoot);
  const snapshot = materializeHarnessRuntimeSnapshot(
    paths, sourceRuntimeRoot, executablePath, payloadSha256, executableSha256,
  );
  await validateSandboxedHarnessVersion(
    snapshot.executablePath,
    snapshot.runtimeRoot,
    expectedVersion,
    environment,
    "隔离运行中的 dsh 版本漂移",
    payloadSha256,
  );
  atomicWriteManifest(paths.manifest, {
    schemaVersion: 1,
    requirements,
    directories: { config: paths.configRoot, data: paths.dataRoot, state: paths.stateRoot },
    harness: {
      sourceDirectory,
      commit,
      executable: {
        sourcePath: executablePath,
        sourceRuntimeRoot,
        path: snapshot.executablePath,
        runtimeRoot: snapshot.runtimeRoot,
        payloadSha256,
        sha256: executableSha256,
        version: expectedVersion,
      },
    },
    isolation: { bubblewrap: { path: bubblewrapExecutable, version: bubblewrapVersion } },
  });
  for (const diagnostic of diagnostics) process.stdout.write(`${diagnostic}\n`);
  process.stdout.write(`正式运行目录已初始化：${paths.dataRoot}\n`);
  process.stdout.write(`安装清单已写入：${paths.manifest}\n`);
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
  if (manifest.schemaVersion !== 1 || !manifest.harness?.sourceDirectory || !manifest.harness.commit
    || !manifest.harness.executable?.sourcePath || !manifest.harness.executable.sourceRuntimeRoot
    || !manifest.harness.executable.path || !manifest.harness.executable.runtimeRoot
    || !manifest.harness.executable.payloadSha256 || !manifest.harness.executable.sha256 || !manifest.harness.executable.version
    || manifest.isolation?.bubblewrap.path !== bubblewrapExecutable || !manifest.isolation.bubblewrap.version) {
    throw new CliError("安装清单结构无效");
  }
  return manifest as InstallManifest;
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
    dsh: { profile: { bundles: ["@maze-arena/match-profile", `@maze-arena/${rolePackage}`] } },
  }, null, 2)}\n`);
  writeFileSync(join(profile, "cordis.patch.yml"), "[]\n");
}

function buildMatchProfileImage(args: string[], environment: NodeJS.ProcessEnv): void {
  const options = parseImageBuildOptions(args);
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  validateDirectoryPermissions(paths);
  const sourceDirectory = resolveDirectory(manifest.harness.sourceDirectory, "Harness 源码目录");
  if (currentHarnessCommit(sourceDirectory) !== manifest.harness.commit) throw new CliError("Harness 源码提交已漂移，拒绝构建镜像");
  validateCleanHarnessWorktree(sourceDirectory);
  const executablePath = resolveFile(manifest.harness.executable.path, "dsh 可执行文件");
  if (sha256(executablePath) !== manifest.harness.executable.sha256) throw new CliError("dsh 可执行文件内容已漂移，拒绝构建镜像");

  for (const { directory } of imageProjectPackages) {
    rmSync(join(repositoryRoot, "packages", directory, "dist"), { recursive: true, force: true });
  }
  run("pnpm", [
    ...imageProjectPackages.flatMap(({ name }) => ["--filter", name]),
    "build",
  ], 120_000);
  const projectArtifactSha256 = hashPaths(projectArtifactPaths);
  const staging = mkdtempSync(join(paths.stateRoot, ".match-image-build-"));
  const worktree = join(staging, "harness-worktree");
  try {
    run("git", ["-C", sourceDirectory, "worktree", "add", "--detach", worktree, manifest.harness.commit], 120_000);
    run("pnpm", ["--dir", worktree, "install", "--offline", "--frozen-lockfile"], 300_000);
    const runtimePackage = findHarnessRuntimePackage(worktree);
    run("pnpm", ["--dir", runtimePackage.root, "build"], 300_000);
    const builtRuntimeExecutable = resolveFile(
      join(runtimePackage.root, runtimePackage.executable),
      "Harness 源码 dsh 构建产物",
    );
    if (sha256(builtRuntimeExecutable) !== manifest.harness.executable.sha256) {
      throw new CliError("Harness 固定源码构建出的 dsh 与安装清单可执行文件身份不一致");
    }
    const runtimeRoot = join(staging, "harness-runtime");
    run("pnpm", ["--dir", worktree, "--filter", runtimePackage.name, "deploy", "--prod", runtimeRoot], 300_000);
    const runtimeExecutable = validateDeployedHarnessRuntime(runtimeRoot, runtimePackage, manifest.harness.executable.sha256);
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
      "--label", `org.maze-arena.harness-commit=${manifest.harness.commit}`,
      "--label", `org.maze-arena.dsh-sha256=${manifest.harness.executable.sha256}`,
      "--label", `org.maze-arena.project-artifact-sha256=${projectArtifactSha256}`,
      staging,
    ], 600_000);
    const imageId = parseDigest(readFileSync(iidFile, "utf8"), "Docker 镜像 ID");
    const inspectedId = parseDigest(run("docker", ["image", "inspect", options.imageName, "--format", "{{.Id}}"]), "Docker inspect 镜像 ID");
    if (imageId !== inspectedId) throw new CliError(`Docker 构建摘要不一致：iidfile ${imageId}，inspect ${inspectedId}`);
    for (const role of ["generator", "solver"] as const) {
      const handshake = runWithInput("docker", [
        "run", "--rm", "--network=none", "--read-only", `--user=${matchProfilePolicy.user}`,
        `--memory=${matchProfilePolicy.memory}`, `--memory-swap=${matchProfilePolicy.memorySwap}`,
        `--cpus=${matchProfilePolicy.cpus}`, `--ulimit=cpu=${matchProfilePolicy.cpuUlimit}`,
        `--pids-limit=${matchProfilePolicy.pidsLimit}`, "--security-opt=no-new-privileges", "--cap-drop=ALL",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        `--mount=type=bind,src=${smokeHomes[role]},dst=/arena,readonly`,
        "--env=DSH_HOME=/arena", `--env=MAZE_MATCH_ROLE=${role}`,
        imageId, "dsh", "--profile", `maze-match-${role}`,
      ], "", 60_000);
      const firstFrame = handshake.split("\n")[0];
      let ready: unknown;
      try {
        ready = JSON.parse(firstFrame ?? "");
      } catch {
        throw new CliError(`${role} Match Profile ready 握手不是有效 JSON，预期单行 match-profile.ready`);
      }
      if (!ready || typeof ready !== "object"
        || (ready as Record<string, unknown>).type !== "match-profile.ready"
        || (ready as Record<string, unknown>).protocolVersion !== 1
        || (ready as Record<string, unknown>).role !== role) {
        throw new CliError(`${role} Match Profile ready 握手字段无效，预期 protocolVersion=1 且角色匹配`);
      }
    }
    manifest.matchProfile = {
      imageId,
      imageReference: validateImmutableImageReference(imageId),
      projectArtifactSha256,
      harnessCommit: manifest.harness.commit,
      dshExecutableSha256: manifest.harness.executable.sha256,
      resourcePolicy: matchProfilePolicy,
    };
    atomicWriteManifest(paths.manifest, manifest);
    process.stdout.write(`Match Profile 镜像已构建：${imageId}\n`);
    process.stdout.write(`正式不可变镜像引用：${manifest.matchProfile.imageReference}\n`);
  } finally {
    if (existsSync(worktree)) {
      try { run("git", ["-C", sourceDirectory, "worktree", "remove", "--force", worktree], 120_000); } catch {}
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

function validateDirectoryPermissions(paths: RuntimePaths): void {
  for (const path of paths.protectedDirectories) {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new CliError(`正式运行目录缺失：${path}`);
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o700) throw new CliError(`目录权限必须为 0700：${path} 当前为 ${mode.toString(8).padStart(4, "0")}`);
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
  if (matchProfile.harnessCommit !== manifest.harness.commit
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
    "org.maze-arena.harness-commit": manifest.harness.commit,
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

function validateModelCatalog(paths: RuntimePaths, manifest: InstallManifest): { path: string; release: string } {
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
  try {
    const releaseStat = lstatSync(release);
    const catalogStat = lstatSync(catalogPath);
    if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || (releaseStat.mode & 0o777) !== 0o500
      || !catalogStat.isFile() || catalogStat.isSymbolicLink() || (catalogStat.mode & 0o777) !== 0o400) {
      throw new Error("invalid permissions");
    }
    parseHarnessModelCatalog(JSON.parse(readFileSync(catalogPath, "utf8")), manifest.harness.executable.version);
  } catch (error) {
    throw new CliError(`Harness 模型目录无效：${error instanceof Error ? error.message : "未知错误"}`);
  }
  return { path: catalogPath, release: basename(release) };
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
      || typeof value.harnessExecutablePath !== "string" || typeof value.harnessExecutableSha256 !== "string"
      || typeof value.harnessRuntimeRoot !== "string" || typeof value.harnessRuntimePayloadSha256 !== "string") {
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
  if (hashHarnessRuntimePayload(runtimeRoot) !== state.harnessRuntimePayloadSha256) {
    throw new CliError("运行中 Harness runtime 快照身份已漂移");
  }
}

function removeProcessRuntimeSnapshot(paths: RuntimePaths, state: ProcessState): void {
  const expectedRoot = join(paths.harnessRuntimes, `instance-${state.instanceId}`);
  if (resolve(state.harnessRuntimeRoot) === resolve(expectedRoot)) {
    rmSync(expectedRoot, { recursive: true, force: true });
  }
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
  catalogPath: string,
  webRoot: string,
  port: number,
  instanceId: string,
  harnessRuntime: { runtimeRoot: string; executablePath: string },
): NodeJS.ProcessEnv {
  const inherited = ["HOME", "LANG", "LC_ALL", "NODE_OPTIONS", "PATH", "TMPDIR"]
    .flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]]);
  return {
    ...Object.fromEntries(inherited),
    NODE_ENV: "production",
    PORT: String(port),
    ARENA_INSTANCE_ID: instanceId,
    ARENA_STARTUP_HANDSHAKE_FD: "3",
    ARENA_DATABASE_PATH: join(paths.dataRoot, "maze-arena.sqlite"),
    ARENA_MODEL_CATALOG_PATH: catalogPath,
    ARENA_MODEL_CATALOG_RELEASE: basename(dirname(catalogPath)),
    ARENA_HARNESS_COMMIT: manifest.harness.commit,
    ARENA_MATCH_IMAGE: manifest.matchProfile!.imageReference,
    ARENA_MATCH_TRUSTED_ROOT: join(paths.dataRoot, "harness"),
    ARENA_MATCH_PROTOCOL_PACKAGE: join(repositoryRoot, "packages/match-profile"),
    ARENA_GENERATOR_PLUGIN_PACKAGE: join(repositoryRoot, "packages/generator-plugin"),
    ARENA_SOLVER_PLUGIN_PACKAGE: join(repositoryRoot, "packages/solver-plugin"),
    ARENA_WEB_ROOT: webRoot,
    DSH_EXECUTABLE: harnessRuntime.executablePath,
    DSH_HOME: join(paths.dataRoot, "harness"),
    DSH_HARNESS_VERSION: manifest.harness.executable.version,
    DSH_EVOLUTION_COMMAND: harnessRuntime.executablePath,
    DSH_SMOKE_COMMAND: harnessRuntime.executablePath,
    DSH_UNSHARE_EXECUTABLE: unshareExecutable,
    DSH_BWRAP_EXECUTABLE: manifest.isolation.bubblewrap.path,
    DSH_HARNESS_RUNTIME_ROOT: harnessRuntime.runtimeRoot,
    DSH_HARNESS_RUNTIME_SHA256: manifest.harness.executable.payloadSha256,
  };
}

async function doctor(environment: NodeJS.ProcessEnv, printDiagnostics = true): Promise<ValidatedDoctorContext> {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  const { diagnostics, bubblewrapVersion } = validateTools();
  if (bubblewrapVersion !== manifest.isolation.bubblewrap.version) {
    throw new CliError(`bubblewrap 版本漂移：期望 ${manifest.isolation.bubblewrap.version}`);
  }
  validateDirectoryPermissions(paths);
  const sourceDirectory = resolveDirectory(manifest.harness.sourceDirectory, "Harness 源码目录");
  const actualCommit = currentHarnessCommit(sourceDirectory);
  if (actualCommit !== manifest.harness.commit) {
    throw new CliError(`Harness 源码提交漂移：期望 ${manifest.harness.commit}，实际 ${actualCommit}`);
  }
  validateCleanHarnessWorktree(sourceDirectory);
  const sourceExecutablePath = resolveFile(manifest.harness.executable.sourcePath, "dsh 来源可执行文件");
  const sourceRuntimeRoot = resolveDirectory(manifest.harness.executable.sourceRuntimeRoot, "Harness 来源 runtime root");
  const inferredSourceRuntimeRoot = resolveHarnessRuntimeRoot(sourceExecutablePath);
  if (sourceRuntimeRoot !== inferredSourceRuntimeRoot) {
    throw new CliError(`Harness 来源 runtime root 漂移：期望 ${manifest.harness.executable.sourceRuntimeRoot}，实际 ${inferredSourceRuntimeRoot}`);
  }
  const sourceSha256 = sha256(sourceExecutablePath);
  if (sourceSha256 !== manifest.harness.executable.sha256) {
    throw new CliError(`dsh 可执行文件内容漂移：期望 ${manifest.harness.executable.sha256}，实际 ${sourceSha256}`);
  }
  await validateSandboxedHarnessVersion(
    sourceExecutablePath,
    sourceRuntimeRoot,
    manifest.harness.executable.version,
    environment,
    "dsh 版本漂移",
    manifest.harness.executable.payloadSha256,
  );
  const sourcePayloadSha256 = hashHarnessRuntimePayload(sourceRuntimeRoot);
  if (sourcePayloadSha256 !== manifest.harness.executable.payloadSha256) {
    throw new CliError(`Harness runtime 来源载荷内容漂移：期望 ${manifest.harness.executable.payloadSha256}，实际 ${sourcePayloadSha256}`);
  }
  const executablePath = resolveFile(manifest.harness.executable.path, "dsh 私有快照可执行文件");
  const runtimeRoot = resolveDirectory(manifest.harness.executable.runtimeRoot, "Harness runtime root");
  const inferredRuntimeRoot = resolveHarnessRuntimeRoot(executablePath);
  if (runtimeRoot !== inferredRuntimeRoot) {
    throw new CliError(`Harness runtime root 漂移：期望 ${manifest.harness.executable.runtimeRoot}，实际 ${inferredRuntimeRoot}`);
  }
  const actualSha256 = sha256(executablePath);
  if (actualSha256 !== manifest.harness.executable.sha256) {
    throw new CliError(`dsh 可执行文件内容漂移：期望 ${manifest.harness.executable.sha256}，实际 ${actualSha256}`);
  }
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
  const build = validateProductionBuild();
  const backup = createBackupManager(paths, manifest, catalog.release, environment);
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
  return { manifest, catalog, build };
}

function createBackupManager(
  paths: RuntimePaths,
  manifest: InstallManifest,
  modelCatalogRelease: string,
  environment: NodeJS.ProcessEnv,
): RuntimeBackupManager {
  if (!manifest.matchProfile) throw new CliError("Match Profile 镜像尚未构建，请先运行 image build");
  return new RuntimeBackupManager({
    databasePath: join(paths.dataRoot, "maze-arena.sqlite"),
    lineageRoot: join(paths.dataRoot, "lineages"),
    backupsRoot: paths.backups,
    runtimeIdentity: {
      harnessCommit: manifest.harness.commit,
      harnessVersion: manifest.harness.executable.version,
      modelCatalogRelease,
      imageDigest: manifest.matchProfile.imageReference,
    },
    sensitiveValues: sensitiveEnvironmentValues(environment),
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
  const manager = createBackupManager(paths, manifest, catalog.release, environment);
  const [action, ...rest] = args;
  if (action === "create" && rest.length === 0) {
    assertServerStopped(paths);
    const result = manager.create("manual");
    process.stdout.write(`完整备份已创建：${redactBackupOutput(result.path, environment)}\n`);
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
    process.stdout.write(`完整备份已恢复到隔离目录：${redactBackupOutput(target!, environment)}\n备份身份：${restored.backupId}\n`);
    return;
  }
  throw new CliError("用法：maze-arena backup <create|verify|restore> [参数]");
}

function redactBackupOutput(value: string, environment: NodeJS.ProcessEnv): string {
  return sensitiveEnvironmentValues(environment).sort((left, right) => right.length - left.length)
    .reduce((sanitized, secret) => secret.length >= 8 ? sanitized.split(secret).join("[REDACTED]") : sanitized, value);
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
  const { manifest, catalog, build } = await doctor(environment);
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
  const logPath = join(paths.logs, `server-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const logDescriptor = openSync(logPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [build.serverEntry], {
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor, "pipe"],
      env: formalRuntimeEnvironment(environment, paths, manifest, catalog.path, build.webRoot, port, instanceId, instanceRuntime),
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
      harnessCommit: manifest.harness.commit,
      harnessVersion: manifest.harness.executable.version,
      harnessExecutablePath: instanceRuntime.executablePath,
      harnessExecutableSha256: manifest.harness.executable.sha256,
      harnessRuntimeRoot: instanceRuntime.runtimeRoot,
      harnessRuntimePayloadSha256: manifest.harness.executable.payloadSha256,
      modelCatalogRelease: catalog.release,
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
    process.stdout.write(`Harness：${manifest.harness.executable.version} @ ${manifest.harness.commit}\n`);
    process.stdout.write(`模型目录版本：${catalog.release}\n`);
    process.stdout.write(`镜像摘要：${manifest.matchProfile.imageReference}\n`);
    return;
  }
  assertFrozenProcessRuntime(paths, state);
  const healthy = await healthCheck(state.port, state.instanceId);
  process.stdout.write(`进程：运行中（PID ${state.pid}）\n`);
  process.stdout.write(`HTTP：${healthy ? "健康" : "异常"}（http://127.0.0.1:${state.port}）\n`);
  process.stdout.write(`数据库：${state.databasePath}\n`);
  process.stdout.write(`Harness：${state.harnessVersion} @ ${state.harnessCommit}\n`);
  process.stdout.write(`模型目录版本：${state.modelCatalogRelease}\n`);
  process.stdout.write(`镜像摘要：${state.imageDigest}\n`);
}

function usage(): never {
  throw new CliError("用法：maze-arena <install|image build|models sync|doctor|start|stop|status|backup> [参数]");
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
