#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
      path: string;
      sha256: string;
      version: string;
    };
  };
}

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
      join(dataRoot, "lineages"),
      join(dataRoot, "lineages/generator"),
      join(dataRoot, "lineages/solver"),
      join(dataRoot, "backups"),
      stateRoot,
      join(stateRoot, "logs"),
    ],
  };
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 10_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new CliError(`缺少必需工具 ${command}`);
  }
  if (result.error) throw new CliError(`无法执行 ${command}：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`${command} 检查失败${detail ? `：${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function parseVersion(label: string, output: string): [number, number, number] {
  const match = output.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new CliError(`无法解析 ${label} 版本：${output}`);
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

function validateTools(): string[] {
  const nodeOutput = run("node", ["--version"]);
  const nodeVersion = parseVersion("Node.js", process.version);
  if (compareVersion(nodeVersion, requirements.node.minimum) < 0
    || compareVersion(nodeVersion, requirements.node.maximumExclusive) >= 0) {
    throw new CliError(`Node.js 版本不受支持：${process.version}，要求 >=${requirements.node.minimum} <${requirements.node.maximumExclusive}`);
  }
  if (nodeOutput !== process.version) {
    throw new CliError(`Node.js 执行身份不一致：当前进程 ${process.version}，PATH 中为 ${nodeOutput}`);
  }

  const pnpmOutput = run("pnpm", ["--version"]);
  if (pnpmOutput !== requirements.pnpm.exact) {
    throw new CliError(`pnpm 版本不受支持：${pnpmOutput}，要求 ${requirements.pnpm.exact}`);
  }

  const gitOutput = run("git", ["--version"]);
  if (compareVersion(parseVersion("Git", gitOutput), requirements.git.minimum) < 0) {
    throw new CliError(`Git 版本不受支持：${gitOutput}，要求 >=${requirements.git.minimum}`);
  }

  const dockerOutput = run("docker", ["--version"]);
  if (compareVersion(parseVersion("Docker", dockerOutput), requirements.docker.minimum) < 0) {
    throw new CliError(`Docker 版本不受支持：${dockerOutput}，要求 >=${requirements.docker.minimum}`);
  }
  const dockerDaemon = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (compareVersion(parseVersion("Docker daemon", dockerDaemon), requirements.docker.minimum) < 0) {
    throw new CliError(`Docker daemon 版本不受支持：${dockerDaemon}，要求 >=${requirements.docker.minimum}`);
  }

  return [
    `检查通过：Node.js ${nodeOutput}`,
    `检查通过：pnpm ${pnpmOutput}`,
    `检查通过：${gitOutput}`,
    `检查通过：Docker ${dockerOutput}`,
    `检查通过：Docker daemon ${dockerDaemon}`,
  ];
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function currentHarnessCommit(sourceDirectory: string): string {
  return run("git", ["-C", sourceDirectory, "rev-parse", "HEAD"]);
}

function validateCleanHarnessWorktree(sourceDirectory: string): void {
  const status = run("git", ["-C", sourceDirectory, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new CliError(`Harness 源码工作树不干净：${status}`);
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

function install(args: string[], environment: NodeJS.ProcessEnv): void {
  const options = parseInstallOptions(args);
  const diagnostics = validateTools();
  const sourceDirectory = resolveDirectory(options["--harness-source"]!, "Harness 源码目录");
  const commit = options["--harness-commit"]!;
  validateCommit(commit);
  const actualCommit = currentHarnessCommit(sourceDirectory);
  if (actualCommit !== commit) throw new CliError(`Harness 源码提交不匹配：期望 ${commit}，实际 ${actualCommit}`);
  validateCleanHarnessWorktree(sourceDirectory);
  const executablePath = resolveFile(options["--dsh-executable"]!, "dsh 可执行文件");
  const expectedVersion = options["--dsh-version"]!;
  const actualVersion = run(executablePath, ["--version"]);
  if (actualVersion !== expectedVersion) throw new CliError(`dsh 版本不匹配：期望 ${expectedVersion}，实际 ${actualVersion}`);

  const paths = runtimePaths(environment);
  ensureDirectories(paths);
  atomicWriteManifest(paths.manifest, {
    schemaVersion: 1,
    requirements,
    directories: { config: paths.configRoot, data: paths.dataRoot, state: paths.stateRoot },
    harness: {
      sourceDirectory,
      commit,
      executable: { path: executablePath, sha256: sha256(executablePath), version: expectedVersion },
    },
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
    || !manifest.harness.executable?.path || !manifest.harness.executable.sha256 || !manifest.harness.executable.version) {
    throw new CliError("安装清单结构无效");
  }
  return manifest as InstallManifest;
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

function doctor(environment: NodeJS.ProcessEnv): void {
  const paths = runtimePaths(environment);
  const manifest = readManifest(paths);
  const diagnostics = validateTools();
  validateDirectoryPermissions(paths);
  const sourceDirectory = resolveDirectory(manifest.harness.sourceDirectory, "Harness 源码目录");
  const actualCommit = currentHarnessCommit(sourceDirectory);
  if (actualCommit !== manifest.harness.commit) {
    throw new CliError(`Harness 源码提交漂移：期望 ${manifest.harness.commit}，实际 ${actualCommit}`);
  }
  validateCleanHarnessWorktree(sourceDirectory);
  const executablePath = resolveFile(manifest.harness.executable.path, "dsh 可执行文件");
  const actualSha256 = sha256(executablePath);
  if (actualSha256 !== manifest.harness.executable.sha256) {
    throw new CliError(`dsh 可执行文件内容漂移：期望 ${manifest.harness.executable.sha256}，实际 ${actualSha256}`);
  }
  const actualVersion = run(executablePath, ["--version"]);
  if (actualVersion !== manifest.harness.executable.version) {
    throw new CliError(`dsh 版本漂移：期望 ${manifest.harness.executable.version}，实际 ${actualVersion}`);
  }
  for (const diagnostic of diagnostics) process.stdout.write(`${diagnostic}\n`);
  process.stdout.write("检查通过：正式运行目录权限正确\n");
  process.stdout.write("检查通过：DeepSeek Harness 身份未漂移\n");
}

function usage(): never {
  throw new CliError("用法：maze-arena <install|doctor> [参数]");
}

function main(args: string[], environment: NodeJS.ProcessEnv): void {
  const [command, ...rest] = args;
  if (command === "install") return install(rest, environment);
  if (command === "doctor" && rest.length === 0) return doctor(environment);
  return usage();
}

try {
  main(process.argv.slice(2), process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误：${message}\n`);
  process.exitCode = 1;
}
