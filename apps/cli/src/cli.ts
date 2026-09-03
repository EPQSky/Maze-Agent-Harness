#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
    const detail = (result.stderr || result.stdout).trim();
    throw new CliError(`${command} 检查失败${detail ? `：${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function parseDigest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!digestPattern.test(normalized)) throw new CliError(`${label}不是有效 SHA-256 摘要：${value}`);
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
      } catch (error) {
        throw new CliError(`${role} Match Profile ready 握手不是有效 JSON：${(error as Error).message}`);
      }
      if (!ready || typeof ready !== "object"
        || (ready as Record<string, unknown>).type !== "match-profile.ready"
        || (ready as Record<string, unknown>).protocolVersion !== 1
        || (ready as Record<string, unknown>).role !== role) {
        throw new CliError(`${role} Match Profile ready 握手无效：${firstFrame}`);
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
    throw new CliError(`无法解析 Docker 安全能力：${(error as Error).message}`);
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
    throw new CliError(`Match Profile 镜像摘要漂移：期望 ${expectedImageId}，实际 ${actualImageId}`);
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
    throw new CliError(`无法解析 Match Profile 镜像标签：${(error as Error).message}`);
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
  validateDockerSecurityCapabilities();
  validateMatchProfileImage(manifest);
  for (const diagnostic of diagnostics) process.stdout.write(`${diagnostic}\n`);
  process.stdout.write("检查通过：正式运行目录权限正确\n");
  process.stdout.write("检查通过：DeepSeek Harness 身份未漂移\n");
  process.stdout.write(`检查通过：Match Profile 镜像 ${manifest.matchProfile!.imageReference}\n`);
  process.stdout.write("检查通过：Docker seccomp 与 cgroupns 安全能力可用\n");
}

function usage(): never {
  throw new CliError("用法：maze-arena <install|image build|doctor> [参数]");
}

function main(args: string[], environment: NodeJS.ProcessEnv): void {
  const [command, ...rest] = args;
  if (command === "install") return install(rest, environment);
  if (command === "image" && rest[0] === "build") return buildMatchProfileImage(rest.slice(1), environment);
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
