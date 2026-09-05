import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import packlist from "npm-packlist";
import { parseDocument } from "yaml";
import type {
  Coordinate,
  GeneratorResponse,
  MatchPluginRole,
  MatchProtocolRequest,
  MatchProtocolResponse,
  SolverResponse,
} from "@maze-arena/contracts";
import { MATCH_OUTPUT_LIMIT_BYTES, MATCH_PROTOCOL_VERSION } from "@maze-arena/contracts";
import { runIsolatedHarnessCommand } from "@maze-arena/dsh-integration";
import {
  GOAL,
  GRID_SIZE,
  MAX_SOLVER_STEPS,
  START,
  type MatchEvent,
  type MatchResult,
  type MatchScore,
  type MazeSnapshot,
  type SolverAction,
  type SolverObservation,
  validateMaze,
} from "@maze-arena/engine";
import {
  evaluateAsyncSolverPair,
  evaluateGeneratorPair,
  shortestPathLength,
  type EvaluationCase,
  type FrozenEvaluationContext,
  type GeneratorPairEvaluation,
  type SolverPairEvaluation,
} from "@maze-arena/evaluation";

export const MATCH_PROFILE_POLICY = Object.freeze({
  memoryBytes: 128 * 1024 * 1024,
  cpuSeconds: 2,
  responseTimeoutMs: 100,
  startupTimeoutMs: 5_000,
  exitTimeoutMs: 250,
  cleanupTimeoutMs: 2_000,
  outputBytes: MATCH_OUTPUT_LIMIT_BYTES,
  user: "65532:65532",
});

export const MATCH_PROFILE_POLICY_DIGEST = `sha256-${createHash("sha256")
  .update(JSON.stringify(MATCH_PROFILE_POLICY)).digest("hex")}`;

export type MatchProfileFailureCode =
  | "PLUGIN_LOAD_FAILED" | "CAPABILITY_INVALID" | "PROTOCOL_INVALID" | "OUTPUT_LIMIT"
  | "OUTPUT_MULTIPLE" | "OUTPUT_OUT_OF_ORDER" | "TIMEOUT" | "NON_ZERO_EXIT" | "OOM";

export class MatchProfileError extends Error {
  constructor(readonly code: MatchProfileFailureCode, message: string) {
    super(message);
    this.name = "MatchProfileError";
  }
}

export interface MatchProfileCommand {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  cleanup?: {
    identity: string;
    remove: MatchProfileCleanupCommand;
    verifyAbsent: MatchProfileCleanupCommand;
  };
  cpuMonitor?: {
    resolvePid?: MatchProfileCleanupCommand;
    dockerSocketPath?: string;
    containerIdentity?: string;
    procRoot?: string;
    cgroupRoot?: string;
    sampleIntervalMs?: number;
    limitUsec?: number;
  };
}

export interface MatchProfileCleanupCommand {
  executable: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface MatchProfileCommandFactory {
  create(role: MatchPluginRole): MatchProfileCommand;
}

export interface TrustedCandidateTestRunner {
  run(input: { packageRoot: string; trustedToolRoot: string }): void | Promise<void>;
}

export class DockerTrustedCandidateTestRunner implements TrustedCandidateTestRunner {
  constructor(
    private readonly image: string,
    private readonly executable = "docker",
    private readonly environment: NodeJS.ProcessEnv = {},
    private readonly runtimeExecutable = "node",
  ) {
    assertImmutableImageReference(image);
  }

  async run(input: { packageRoot: string; trustedToolRoot: string }): Promise<void> {
    const packageRoot = resolve(input.packageRoot);
    const trustedToolRoot = resolve(input.trustedToolRoot);
    const repositoryRoot = resolve(trustedToolRoot, "../..");
    const vitest = trustedVitestEntry(trustedToolRoot);
    const mounts = trustedCandidateTestMounts(packageRoot, trustedToolRoot, repositoryRoot, this.runtimeExecutable);
    if (mounts.some((path) => path.includes(",") || /[\r\n]/.test(path))) {
      throw new Error("Docker 候选测试挂载路径包含不支持的字符");
    }
    const containerName = `maze-candidate-test-${randomBytes(12).toString("hex")}`;
    const result = spawnSync(this.executable, [
      "run", "--rm", "--name", containerName, "--network=none", "--read-only", `--user=${MATCH_PROFILE_POLICY.user}`,
      "--memory=128m", "--memory-swap=128m", "--cpus=1", "--ulimit=cpu=2:2", "--pids-limit=64",
      "--security-opt=no-new-privileges", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
      ...mounts.map((path) => `--mount=type=bind,src=${path},dst=${path},readonly`),
      `--workdir=${packageRoot}`, `--entrypoint=${this.runtimeExecutable}`, this.image, vitest, "run", "--root", packageRoot,
    ], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: this.commandEnvironment() });
    try {
      await cleanupContainer({
        identity: containerName,
        remove: { executable: this.executable, args: ["rm", "-f", containerName], environment: this.commandEnvironment(), timeoutMs: 2_000 },
        verifyAbsent: { executable: this.executable, args: ["inspect", containerName], environment: this.commandEnvironment(), timeoutMs: 2_000 },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知清理错误";
      throw new Error(`${result.error || result.status !== 0 ? "候选测试失败且" : "候选测试完成但"}隔离容器清理未确认：${reason}`);
    }
    if (result.error || result.status !== 0) {
      const diagnostic = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 8_192);
      throw new Error(`候选测试失败${diagnostic ? `：${diagnostic}` : ""}`);
    }
  }

  private commandEnvironment(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, ...this.environment };
  }
}

export interface HarnessProfileInstallOptions {
  executable: string;
  runtimeRoot: string;
  runtimePayloadSha256: string;
  expectedVersion: string;
  home: string;
  protocolBundle: string;
  roleBundles: Record<MatchPluginRole, string>;
  roleLineageBaselines?: Partial<Record<MatchPluginRole, LineageBaseline>>;
  environment?: NodeJS.ProcessEnv;
}

export class HarnessMatchProfileInstaller {
  constructor(private readonly options: HarnessProfileInstallOptions) {}

  async prepare(): Promise<void> {
    const version = await this.run(["--version"], [], false);
    if (version.trim() !== this.options.expectedVersion) {
      throw new Error(`DeepSeek Harness 版本不匹配：期望 ${this.options.expectedVersion}`);
    }
    for (const role of ["generator", "solver"] as const) await this.installRole(role);
  }

  async uninstall(): Promise<void> {
    for (const role of ["generator", "solver"] as const) {
      const profile = profileName(role);
      await this.run(["plugin", "--profile", profile, "remove", packageName(this.options.roleBundles[role]), packageName(this.options.protocolBundle)]);
      const manifest = readProfile(this.options.home, profile);
      if (Object.keys(manifest.dependencies ?? {}).length !== 0 || (manifest.dsh?.profile?.bundles ?? []).length !== 0) {
        throw new Error(`${profile} 卸载后仍残留能力 bundle`);
      }
    }
  }

  private async installRole(role: MatchPluginRole): Promise<void> {
    const profile = profileName(role);
    const directory = join(resolve(this.options.home), "profiles", profile);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), `${JSON.stringify({
      name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }, null, 2)}\n`);
    writeFileSync(join(directory, "cordis.patch.yml"), "[]\n");
    await validatePluginPackage(this.options.protocolBundle);
    await validatePluginPackage(this.options.roleBundles[role], this.options.roleLineageBaselines?.[role] ?? {});
    const artifactRoot = join(resolve(this.options.home), "artifacts");
    const protocolArtifact = await createInstallArtifact(this.options.protocolBundle, artifactRoot);
    const roleArtifact = await createInstallArtifact(this.options.roleBundles[role], artifactRoot);
    await validateInstallArtifact(protocolArtifact);
    await validateInstallArtifact(roleArtifact);
    await this.run([
      "plugin", "--profile", profile, "add", "--offline", "--save-exact",
      `file:${protocolArtifact}`, `file:${roleArtifact}`,
    ], [protocolArtifact, roleArtifact]);
    const manifest = readProfile(this.options.home, profile);
    const protocolName = packageName(protocolArtifact);
    const roleName = packageName(roleArtifact);
    const expected = [protocolName, roleName];
    if (JSON.stringify(Object.keys(manifest.dependencies ?? {})) !== JSON.stringify(expected)
      || JSON.stringify(manifest.dsh?.profile?.bundles ?? []) !== JSON.stringify(expected)) {
      throw new Error(`${profile} 必须且只能安装协议 bundle 与一个角色 bundle`);
    }
    validateProfilePatches(this.options.home, profile, expected);
    for (const [name, artifact] of [[protocolName, protocolArtifact], [roleName, roleArtifact]] as const) {
      const installed = join(directory, "node_modules", ...name.split("/"));
      if (realpathSync(installed) !== realpathSync(artifact)) throw new Error(`${profile} 安装结果未指向已验证的内容寻址产物：${name}`);
      await validateInstallArtifact(installed);
    }
    freezeProfileSnapshot(this.options.home, role);
  }

  private async run(args: string[], readOnlyArtifacts: readonly string[] = [], useProfileHome = true): Promise<string> {
    const home = resolve(this.options.home);
    const sessionRoot = useProfileHome ? undefined : join(home, `.version-session-${process.pid}-${randomBytes(6).toString("hex")}`);
    const commandHome = sessionRoot ?? home;
    const workspace = sessionRoot ? join(sessionRoot, "workspace") : home;
    if (sessionRoot) mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const environment: NodeJS.ProcessEnv = {};
    const source = { ...process.env, ...this.options.environment };
    for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (source[key] !== undefined) environment[key] = source[key];
    }
    for (const [key, value] of Object.entries(this.options.environment ?? {})) {
      if (key.startsWith("DSH_") && value !== undefined) environment[key] = value;
    }
    Object.assign(environment, {
      HOME: commandHome,
      DSH_HOME: commandHome,
      TMPDIR: commandHome,
      XDG_CONFIG_HOME: join(commandHome, ".config"),
      XDG_DATA_HOME: join(commandHome, ".local/share"),
      XDG_STATE_HOME: join(commandHome, ".local/state"),
      npm_config_cache: join(commandHome, ".npm-cache"),
    });
    try {
      const artifactRoot = join(home, "artifacts");
      const result = await runIsolatedHarnessCommand({
        command: this.options.executable,
        args,
        runtimeRoot: this.options.runtimeRoot,
        expectedRuntimePayloadSha256: this.options.runtimePayloadSha256,
        environment,
        timeoutMs: 30_000,
        outputLimitBytes: 1024 * 1024,
        cwd: workspace,
        writablePaths: [commandHome],
        readOnlyPaths: useProfileHome && existsSync(artifactRoot)
          ? [artifactRoot, ...readOnlyArtifacts]
          : readOnlyArtifacts,
      });
      return result.stdout;
    } catch (error) {
      const exitCode = error && typeof error === "object" && "exitCode" in error ? (error as { exitCode?: unknown }).exitCode : undefined;
      if (typeof exitCode === "number") throw new Error(`dsh 命令失败（退出码 ${exitCode}）`);
      throw error;
    } finally {
      if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
    }
  }
}

export class DockerMatchProfileCommandFactory implements MatchProfileCommandFactory {
  constructor(
    private readonly image: string,
    private readonly harnessHome: string,
    private readonly executable = "docker",
    private readonly environment: NodeJS.ProcessEnv = {},
    private readonly monitorCpu = true,
  ) {
    assertImmutableImageReference(image);
  }

  create(role: MatchPluginRole): MatchProfileCommand {
    const trustedRoot = join(resolve(this.harnessHome), "snapshots", role);
    const expectedDigest = readFileSync(`${trustedRoot}.sha256`, "utf8").trim();
    if (hashDirectory(trustedRoot) !== expectedDigest) throw new Error(`冻结 Match Profile 快照摘要不匹配：${role}`);
    const containerName = `maze-match-${role}-${randomBytes(12).toString("hex")}`;
    const commandEnvironment = { PATH: process.env.PATH, ...this.environment };
    return {
      executable: this.executable,
      environment: commandEnvironment,
      args: [
        "run", "--rm", "--name", containerName, "--network=none", "--read-only", `--user=${MATCH_PROFILE_POLICY.user}`,
        "--memory=128m", "--memory-swap=128m", "--cpus=1", "--ulimit=cpu=2:2", "--pids-limit=64",
        "--security-opt=no-new-privileges", "--cap-drop=ALL", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        `--mount=type=bind,src=${trustedRoot},dst=/arena,readonly`,
        "--env=DSH_HOME=/arena",
        "--env=MAZE_MATCH_ROLE=" + role,
        this.image,
        "dsh", "--profile", profileName(role),
      ],
      cleanup: {
        identity: containerName,
        remove: { executable: this.executable, args: ["rm", "-f", containerName], environment: commandEnvironment, timeoutMs: 2_000 },
        verifyAbsent: { executable: this.executable, args: ["inspect", containerName], environment: commandEnvironment, timeoutMs: 2_000 },
      },
      cpuMonitor: this.monitorCpu ? {
        dockerSocketPath: process.env.DOCKER_HOST?.startsWith("unix://")
          ? process.env.DOCKER_HOST.slice("unix://".length) : "/var/run/docker.sock",
        containerIdentity: containerName,
        limitUsec: MATCH_PROFILE_POLICY.cpuSeconds * 1_000_000,
      } : undefined,
    };
  }
}

export interface DockerPairedEvaluationInput {
  role: MatchPluginRole;
  protocolVersion: typeof MATCH_PROTOCOL_VERSION;
  candidate: { commit: string; root: string };
  champion: { commit: string; root: string };
  opponent: { commit: string; root: string };
  cases: readonly EvaluationCase[];
  context: FrozenEvaluationContext;
}

export interface PairedEvaluationRunner {
  evaluate(input: DockerPairedEvaluationInput): Promise<GeneratorPairEvaluation | SolverPairEvaluation>;
}

export interface VersionedMatchRunner {
  runVersioned(input: {
    seed: string;
    generator: { commit: string; root: string };
    solver: { commit: string; root: string };
    onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void;
  }): Promise<MatchResult>;
}

interface PrivateVersionSnapshot {
  commit: string;
  root: string;
  contentSha256: string;
}

interface GitTreeEntry {
  mode: string;
  object: string;
  size: number;
  path: string;
}

interface PrivateSnapshotOptions {
  gitExecutable?: string;
  remove?: (root: string) => void;
}

export async function withPrivateGitCommitSnapshot<T>(
  version: { commit: string; root: string },
  operation: (snapshot: PrivateVersionSnapshot) => Promise<T> | T,
  options: PrivateSnapshotOptions = {},
): Promise<T> {
  if (!/^[0-9a-f]{40}$/i.test(version.commit)) throw new Error("版本化 Match Profile 必须使用不可变 Git 提交身份");
  const gitExecutable = options.gitExecutable ?? "git";
  const repository = realpathSync(resolve(version.root));
  const topLevel = runGitBytes(gitExecutable, repository, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  if (realpathSync(topLevel) !== repository) throw new Error("版本化 Match Profile 根目录必须是独立 Git 工作树根");
  const resolved = runGitBytes(gitExecutable, repository, ["rev-parse", `${version.commit}^{commit}`]).toString("utf8").trim();
  if (resolved !== version.commit) throw new Error("版本化 Match Profile 提交不属于指定 Git 对象库");
  const entries = parseGitTree(runGitBytes(gitExecutable, repository, ["ls-tree", "-rz", "--full-tree", "-l", version.commit]));
  validateGitTree(entries);
  const snapshotRoot = mkdtempSync(join(tmpdir(), "maze-version-snapshot-"));
  let primaryError: Error | undefined;
  try {
    chmodSync(snapshotRoot, 0o700);
    const archive = runGitBytes(gitExecutable, repository, ["archive", "--format=tar", version.commit], 8 * 1024 * 1024);
    validateGitArchive(archive, entries);
    const extraction = spawnSync("tar", ["--extract", "--directory", snapshotRoot, "--no-same-owner", "--no-same-permissions"], {
      input: archive, encoding: null, maxBuffer: 8 * 1024 * 1024,
    });
    if (extraction.status !== 0) throw new Error("无法展开版本化 Match Profile 提交归档");
    verifyExtractedGitTree(gitExecutable, repository, snapshotRoot, entries);
    const snapshot = { commit: version.commit, root: snapshotRoot, contentSha256: hashDirectory(snapshotRoot) };
    return await operation(snapshot);
  } catch (error) {
    primaryError = error as Error;
    throw error;
  } finally {
    try {
      (options.remove ?? ((root) => rmSync(root, { recursive: true, force: true })))(snapshotRoot);
      if (existsSync(snapshotRoot)) throw new Error("版本化 Match Profile 私有快照清理后仍然存在");
    } catch (cleanupError) {
      throw primaryError
        ? new AggregateError([primaryError, cleanupError as Error], `${primaryError.message}；且私有提交快照清理失败`)
        : cleanupError;
    }
  }
}

function validateGitArchive(archive: Buffer, entries: readonly GitTreeEntry[]): void {
  const listed = spawnSync("tar", ["--list", "--file=-"], { input: archive, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error("版本化 Match Profile 提交归档无法读取");
  const archiveFiles = listed.stdout.split("\n").filter((path) => path && !path.endsWith("/")).sort();
  for (const path of archiveFiles) {
    const segments = path.split("/");
    if (path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")
      || /[\0\r\n\t]/.test(path) || segments[0] === ".git") {
      throw new Error("版本化 Match Profile 提交归档包含非法路径");
    }
  }
  if (JSON.stringify(archiveFiles) !== JSON.stringify(entries.map(({ path }) => path).sort())) {
    throw new Error("版本化 Match Profile 提交归档条目与 Git tree 不一致");
  }
}

function runGitBytes(executable: string, repository: string, args: string[], maxBuffer = 2 * 1024 * 1024): Buffer {
  const result = spawnSync(executable, ["-C", repository, ...args], {
    encoding: null, maxBuffer, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0 || !result.stdout) throw new Error(`无法读取版本化 Match Profile Git 对象：${args[0]}`);
  return result.stdout;
}

function parseGitTree(output: Buffer): GitTreeEntry[] {
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(\d{6}) (\S+) ([0-9a-f]+)\s+(\d+|-)\t(.+)$/s.exec(record);
    if (!match) throw new Error("版本化 Match Profile Git tree 输出非法");
    return { mode: match[1]!, object: match[3]!, size: Number(match[4]), path: match[5]! };
  });
}

function validateGitTree(entries: readonly GitTreeEntry[]): void {
  let totalBytes = 0;
  if (entries.length === 0 || entries.length > 256) throw new Error("版本化 Match Profile 提交文件数量超出冻结边界");
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error("版本化 Match Profile 提交包含符号链接、子模块或特殊文件");
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 2 * 1024 * 1024
      || entry.path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")
      || /[\0\r\n\t]/.test(entry.path) || segments[0] === ".git") {
      throw new Error("版本化 Match Profile 提交包含非法路径或文件大小");
    }
    totalBytes += entry.size;
  }
  if (totalBytes > 5 * 1024 * 1024) throw new Error("版本化 Match Profile 提交总大小超出冻结边界");
}

function verifyExtractedGitTree(
  gitExecutable: string, repository: string, snapshotRoot: string, entries: readonly GitTreeEntry[],
): void {
  const actual = versionedWorkingTreeFiles(snapshotRoot).sort();
  const expected = entries.map(({ path }) => path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("版本化 Match Profile 归档条目与 Git tree 不一致");
  for (const entry of entries) {
    const path = join(snapshotRoot, ...entry.path.split("/"));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
      throw new Error("版本化 Match Profile 归档包含非法条目类型或大小");
    }
    const blob = runGitBytes(gitExecutable, repository, ["cat-file", "blob", entry.object], entry.size + 1);
    if (!blob.equals(readFileSync(path))) throw new Error("版本化 Match Profile 归档内容与 Git blob 不一致");
  }
}

export class DockerPairedEvaluationRunner implements PairedEvaluationRunner, VersionedMatchRunner {
  constructor(
    private readonly image: string,
    private readonly harnessHome: string,
    private readonly executable = "docker",
    private readonly environment: NodeJS.ProcessEnv = {},
    private readonly monitorCpu = true,
    private readonly privateSnapshotOptions: PrivateSnapshotOptions = {},
  ) {
    assertImmutableImageReference(image);
  }

  async evaluate(input: DockerPairedEvaluationInput): Promise<GeneratorPairEvaluation | SolverPairEvaluation> {
    this.assertFrozenInput(input);
    return withPrivateGitCommitSnapshot(input.candidate, (candidate) =>
      withPrivateGitCommitSnapshot(input.champion, (champion) =>
        withPrivateGitCommitSnapshot(input.opponent, async (opponent) => {
          if (input.role === "generator") {
            return evaluateGeneratorPair({
              candidate: this.generator(candidate),
              champion: this.generator(champion),
              solver: {
                version: opponent.commit,
                solve: (maze) => this.solveDeterministically(opponent, "paired-generator", maze).then(({ rawScore }) => rawScore),
              },
              cases: input.cases,
              context: input.context,
            });
          }
          return evaluateAsyncSolverPair({
            candidate: this.solver(candidate),
            champion: this.solver(champion),
            generator: {
              version: opponent.commit,
              generate: (seed) => this.generateDeterministically(opponent, seed).then(({ maze }) => maze),
            },
            cases: input.cases,
            context: input.context,
          });
        }, this.privateSnapshotOptions), this.privateSnapshotOptions), this.privateSnapshotOptions);
  }

  async runVersioned(input: {
    seed: string;
    generator: { commit: string; root: string };
    solver: { commit: string; root: string };
    onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void;
  }): Promise<MatchResult> {
    this.assertCommit(input.generator.commit);
    this.assertCommit(input.solver.commit);
    return withPrivateGitCommitSnapshot(input.generator, (generator) =>
      withPrivateGitCommitSnapshot(input.solver, async (solver) => {
        const generatorHome = await materializeVersionedProfile(this.harnessHome, "generator", generator.root);
        let solverHome: string | undefined;
        try {
          solverHome = await materializeVersionedProfile(this.harnessHome, "solver", solver.root);
          const runner = new NativePluginMatchRunner({
            create: (role) => new DockerMatchProfileCommandFactory(
              this.image,
              role === "generator" ? generatorHome : solverHome!,
              this.executable,
              this.environment,
              this.monitorCpu,
            ).create(role),
          });
          return await runner.run(input.seed, input.onEvents);
        } finally {
          removeVersionedProfile(generatorHome, "generator");
          if (solverHome) removeVersionedProfile(solverHome, "solver");
        }
      }, this.privateSnapshotOptions), this.privateSnapshotOptions);
  }

  private generator(version: PrivateVersionSnapshot) {
    return {
      version: version.commit,
      generate: async (seed: string) => {
        const generated = await this.generateDeterministically(version, seed);
        return { maze: generated.maze, protocolValid: true, resourceCompliant: true, trace: generated.events };
      },
    };
  }

  private solver(version: PrivateVersionSnapshot) {
    return {
      version: version.commit,
      solve: async (seed: string, maze: MazeSnapshot) => this.solveDeterministically(version, seed, maze),
    };
  }

  private async generateDeterministically(version: PrivateVersionSnapshot, seed: string): Promise<{ maze: MazeSnapshot; events: MatchEvent[] }> {
    return this.repeatDeterministically(() => this.withVersionedProcess("generator", version, (profileProcess) => runGeneratorProfile(profileProcess, seed)));
  }

  private async solveDeterministically(version: PrivateVersionSnapshot, seed: string, maze: MazeSnapshot): Promise<{
    score: { solved: boolean; extraActions: number; illegalActions: number };
    rawScore: MatchScore;
    trace: Array<{ observation: SolverObservation; action: SolverAction }>;
  }> {
    const result = await this.repeatDeterministically(() => this.withVersionedProcess("solver", version, (profileProcess) => runSolverProfile(profileProcess, seed, maze)));
    return {
      score: {
        solved: result.score.solved,
        extraActions: result.score.solved ? Math.max(0, result.score.actions - shortestPathLength(maze)) : 0,
        illegalActions: result.score.illegalMoves,
      },
      rawScore: result.score,
      trace: result.trace,
    };
  }

  private async repeatDeterministically<T>(execute: () => Promise<T>): Promise<T> {
    const first = await execute();
    const second = await execute();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new MatchProfileError("PROTOCOL_INVALID", "Match Profile 重复执行产生非确定性权威结果");
    }
    return first;
  }

  private async withVersionedProcess<T>(
    role: MatchPluginRole,
    version: PrivateVersionSnapshot,
    operation: (profileProcess: MatchProfileProcess) => Promise<T>,
  ): Promise<T> {
    if (hashDirectory(version.root) !== version.contentSha256) throw new Error("版本化 Match Profile 私有快照在执行前发生漂移");
    const home = await materializeVersionedProfile(this.harnessHome, role, version.root);
    let profileProcess: MatchProfileProcess | undefined;
    let primaryError: Error | undefined;
    try {
      profileProcess = new MatchProfileProcess(
        new DockerMatchProfileCommandFactory(this.image, home, this.executable, this.environment, this.monitorCpu).create(role), role,
      );
      const result = await operation(profileProcess);
      await profileProcess.finalize();
      if (hashDirectory(version.root) !== version.contentSha256) throw new Error("版本化 Match Profile 私有快照在执行期间发生漂移");
      return result;
    } catch (error) {
      primaryError = error as Error;
      throw error;
    } finally {
      let cleanupError: unknown;
      try { await profileProcess?.close(); }
      catch (error) { cleanupError = error; }
      removeVersionedProfile(home, role);
      if (cleanupError) {
        throw primaryError
          ? new AggregateError([primaryError, cleanupError as Error], `${primaryError.message}；且 Match Profile 清理失败`)
          : cleanupError;
      }
    }
  }

  private assertFrozenInput(input: DockerPairedEvaluationInput): void {
    if (input.protocolVersion !== MATCH_PROTOCOL_VERSION) throw new Error("配对评测协议版本与冻结 Match Profile 不一致");
    if (input.context.imageDigest !== this.image) throw new Error("配对评测镜像摘要与冻结上下文不一致");
    if (input.context.resourcePolicyDigest !== MATCH_PROFILE_POLICY_DIGEST) throw new Error("配对评测资源策略与冻结上下文不一致");
    if (input.context.opponentVersion !== input.opponent.commit) throw new Error("配对评测对手提交与冻结上下文不一致");
    if (input.cases.length === 0) throw new Error("配对评测至少需要一个有序案例");
    for (let index = 1; index < input.cases.length; index += 1) {
      if (input.cases[index - 1]!.id.localeCompare(input.cases[index]!.id) >= 0) {
        throw new Error("配对评测案例必须按唯一标识严格有序");
      }
    }
    for (const version of [input.candidate, input.champion, input.opponent]) {
      this.assertCommit(version.commit);
    }
  }

  private assertCommit(commit: string): void {
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("版本化 Match Profile 必须使用不可变 Git 提交身份");
  }

}

function versionedWorkingTreeFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (current === root && entry.name === ".git") return [];
    const path = join(current, entry.name);
    return entry.isDirectory() ? versionedWorkingTreeFiles(root, path) : [relative(root, path).split(sep).join("/")];
  });
}

function removeVersionedProfile(home: string, role: MatchPluginRole): void {
  const snapshot = join(home, "snapshots", role);
  if (existsSync(snapshot)) thawTree(snapshot);
  const digest = `${snapshot}.sha256`;
  if (existsSync(digest)) chmodSync(digest, 0o600);
  rmSync(home, { recursive: true, force: true });
}

async function materializeVersionedProfile(harnessHome: string, role: MatchPluginRole, packageRoot: string): Promise<string> {
  const trustedHome = resolve(harnessHome);
  const sourceSnapshot = join(trustedHome, "snapshots", role);
  const expected = readFileSync(`${sourceSnapshot}.sha256`, "utf8").trim();
  if (hashDirectory(sourceSnapshot) !== expected) throw new Error(`冻结 Match Profile 快照摘要不匹配：${role}`);
  // 版本提交已经由私有 Git 快照绑定；执行阶段应校验完整历史，而不是把累积谱系误判为单次新增。
  await validatePluginPackage(packageRoot, lineageIdentity(packageRoot));
  const home = mkdtempSync(join(tmpdir(), `maze-paired-${role}-`));
  try {
    chmodSync(home, 0o755);
    const snapshot = join(home, "snapshots", role);
    cpSync(sourceSnapshot, snapshot, { recursive: true });
    thawTree(snapshot);
    const artifactStaging = join(home, ".artifacts");
    mkdirSync(artifactStaging, { recursive: true });
    const artifact = await createInstallArtifact(packageRoot, artifactStaging);
    await validateInstallArtifact(artifact);
    const artifactTarget = join(snapshot, "artifacts", artifact.split(sep).at(-1)!);
    cpSync(artifact, artifactTarget, { recursive: true });
    const name = packageName(artifact);
    const profile = profileName(role);
    const profileRoot = join(snapshot, "profiles", profile);
    const installed = join(profileRoot, "node_modules", ...name.split("/"));
    if (!existsSync(installed)) throw new Error(`冻结 Profile 未安装预期角色包：${name}`);
    rmSync(installed, { recursive: true, force: true });
    cpSync(artifactTarget, installed, { recursive: true });
    const manifestPath = join(profileRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    if (!record(manifest.dependencies) || !(name in manifest.dependencies)) throw new Error(`冻结 Profile 依赖缺少角色包：${name}`);
    manifest.dependencies[name] = `file:/arena/artifacts/${artifact.split(sep).at(-1)!}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    freezeTree(snapshot);
    writeFileSync(`${snapshot}.sha256`, `${hashDirectory(snapshot)}\n`, { mode: 0o444 });
    rmSync(artifactStaging, { recursive: true, force: true });
    return home;
  } catch (error) {
    removeVersionedProfile(home, role);
    throw error;
  }
}

function thawTree(root: string): void {
  for (const directory of [root, ...walkDirectories(root)].sort((left, right) => left.length - right.length)) chmodSync(directory, 0o755);
  for (const path of walk(root)) chmodSync(path, 0o644);
}

function freezeTree(root: string): void {
  for (const path of walk(root)) chmodSync(path, 0o444);
  for (const directory of walkDirectories(root).sort((left, right) => right.length - left.length)) chmodSync(directory, 0o555);
  chmodSync(root, 0o555);
}

async function runGeneratorProfile(profileProcess: MatchProfileProcess, seed: string): Promise<{ maze: MazeSnapshot; events: MatchEvent[] }> {
  const passages: MazeSnapshot["passages"] = [];
  const events: MatchEvent[] = [];
  let sequence = 0;
  let response = generatorPayload(await profileProcess.request(request("generator", ++sequence, {
    type: "generator.start", seed, rules: { size: GRID_SIZE, start: { ...START }, goal: { ...GOAL } },
  })));
  while (response.type !== "generator.complete") {
    const key = passageKey(response.from, response.to);
    if (passages.some(({ from, to }) => passageKey(from, to) === key)) {
      throw new MatchProfileError("PROTOCOL_INVALID", "生成器重复凿通边");
    }
    passages.push({ from: { ...response.from }, to: { ...response.to } });
    events.push({ type: "maze.carved", protocolVersion: 1, sequence: events.length + 1,
      from: { ...response.from }, to: { ...response.to } });
    if (passages.length > GRID_SIZE * (GRID_SIZE - 1) * 2) {
      throw new MatchProfileError("PROTOCOL_INVALID", "生成器凿通数量超出网格上限");
    }
    response = generatorPayload(await profileProcess.request(request("generator", ++sequence, { type: "generator.next" })));
  }
  const maze: MazeSnapshot = { size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, passages };
  const validation = validateMaze(maze);
  if (!validation.valid) throw new MatchProfileError("PROTOCOL_INVALID", validation.reason ?? "生成迷宫非法");
  events.push({ type: "maze.completed", protocolVersion: 1, sequence: events.length + 1, passageCount: passages.length });
  return { maze, events };
}

async function runSolverProfile(profileProcess: MatchProfileProcess, seed: string, maze: MazeSnapshot): Promise<{
  score: MatchScore;
  trace: Array<{ observation: SolverObservation; action: SolverAction }>;
}> {
  const validation = validateMaze(maze);
  if (!validation.valid) throw new MatchProfileError("PROTOCOL_INVALID", validation.reason ?? "冻结迷宫非法");
  let sequence = 0;
  const ready = solverPayload(await profileProcess.request(request("solver", ++sequence, {
    type: "solver.start", start: { ...START }, goal: { ...GOAL },
  })));
  if (ready.type !== "solver.ready") throw new MatchProfileError("PROTOCOL_INVALID", "求解器初始化响应非法");
  let position: Coordinate = { ...START };
  let previousAction: { direction: "north" | "east" | "south" | "west"; moved: boolean } | null = null;
  let actions = 0;
  let illegalMoves = 0;
  let backtracks = 0;
  const trace: Array<{ observation: SolverObservation; action: SolverAction }> = [];
  while (!same(position, GOAL) && actions < MAX_SOLVER_STEPS) {
    const open = openDirections(maze, position);
    const observation: SolverObservation = {
      position: { ...position }, start: { ...START }, goal: { ...GOAL }, openDirections: [...open],
      remainingSteps: MAX_SOLVER_STEPS - actions, previousAction,
    };
    const next = solverPayload(await profileProcess.request(request("solver", ++sequence, {
      type: "solver.next", position: observation.position, start: observation.start, goal: observation.goal,
      openDirections: observation.openDirections, remainingSteps: observation.remainingSteps, previousAction: observation.previousAction,
    })));
    if (next.type !== "solver.move") throw new MatchProfileError("PROTOCOL_INVALID", "求解器动作响应非法");
    const action: SolverAction = { direction: next.direction, kind: next.kind };
    trace.push({ observation, action });
    const candidate = moved(position, next.direction);
    const didMove = open.includes(next.direction);
    actions += 1;
    if (didMove) position = candidate;
    else illegalMoves += 1;
    if (next.kind === "backtrack") backtracks += 1;
    previousAction = { direction: next.direction, moved: didMove };
  }
  return {
    score: { solved: same(position, GOAL), actions, illegalMoves, backtracks, remainingSteps: MAX_SOLVER_STEPS - actions },
    trace,
  };
}

function freezeProfileSnapshot(home: string, role: MatchPluginRole): void {
  const root = resolve(home);
  const snapshot = join(root, "snapshots", role);
  if (existsSync(snapshot)) {
    // 上一轮快照刻意只读；正式服务重启时仅解冻待替换副本，不改变内容校验边界。
    for (const path of walk(snapshot)) chmodSync(path, 0o600);
    for (const directory of walkDirectories(snapshot).sort((left, right) => right.length - left.length)) chmodSync(directory, 0o700);
    chmodSync(snapshot, 0o700);
  }
  rmSync(snapshot, { recursive: true, force: true });
  cpSync(join(root, "artifacts"), join(snapshot, "artifacts"), { recursive: true, dereference: true });
  const sourceProfile = join(root, "profiles", profileName(role));
  const targetProfile = join(snapshot, "profiles", profileName(role));
  cpSync(sourceProfile, targetProfile, {
    recursive: true,
    dereference: true,
    filter: (source) => !relative(sourceProfile, source).split(sep).includes("node_modules"),
  });
  const manifest = readProfile(root, profileName(role));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const installed = join(sourceProfile, "node_modules", ...name.split("/"));
    cpSync(realpathSync(installed), join(targetProfile, "node_modules", ...name.split("/")), { recursive: true, dereference: true });
  }
  const homePatch = join(root, "cordis.patch.yml");
  if (existsSync(homePatch)) cpSync(homePatch, join(snapshot, "cordis.patch.yml"));
  for (const path of walk(snapshot).sort((left, right) => right.length - left.length)) chmodSync(path, 0o444);
  for (const directory of walkDirectories(snapshot).sort((left, right) => right.length - left.length)) chmodSync(directory, 0o555);
  chmodSync(snapshot, 0o555);
  rmSync(`${snapshot}.sha256`, { force: true });
  writeFileSync(`${snapshot}.sha256`, `${hashDirectory(snapshot)}\n`, { mode: 0o444 });
}

function walkDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? [path, ...walkDirectories(path)] : [];
  });
}

export class MatchProfileProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private output = Buffer.alloc(0);
  private pending?: { request: MatchProtocolRequest; resolve(value: MatchProtocolResponse): void; reject(error: Error): void; timer: NodeJS.Timeout };
  private exited = false;
  private terminalError?: Error;
  private readonly closed: Promise<void>;
  private closeResolve!: () => void;
  private cleanupPromise?: Promise<void>;
  private handshakeState: "pending" | "initializing" | "ready" | "failed" = "pending";
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly startupTimer: NodeJS.Timeout;
  private closing = false;
  private cpuMonitorTimer?: NodeJS.Timeout;
  private cpuMonitorTask: Promise<void> = Promise.resolve();
  private cpuMonitorActive = false;
  private cpuMonitorFinalized = false;
  private cpuMonitorError?: MatchProfileError;
  private cpuReadUsage?: () => Promise<number>;
  private cpuLimitUsec = MATCH_PROFILE_POLICY.cpuSeconds * 1_000_000;
  private cpuSampleIntervalMs = 10;
  private failurePromise?: Promise<void>;

  constructor(
    private readonly command: MatchProfileCommand,
    private readonly role: MatchPluginRole,
    timeoutMs: number = MATCH_PROFILE_POLICY.responseTimeoutMs,
    startupTimeoutMs: number = MATCH_PROFILE_POLICY.startupTimeoutMs,
  ) {
    this.timeoutMs = timeoutMs;
    this.closed = new Promise((resolve) => { this.closeResolve = resolve; });
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.startupTimer = setTimeout(() => {
      void this.fail(new MatchProfileError("TIMEOUT", "Match Profile 启动握手超时"));
    }, startupTimeoutMs);
    this.child = spawn(command.executable, command.args, {
      env: command.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", () => { /* stderr 仅供受控诊断，不进入协议或对手输入。 */ });
    this.child.on("error", (error) => { void this.fail(new MatchProfileError("PLUGIN_LOAD_FAILED", `无法启动 Match Profile：${error.message}`)); });
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      void this.stopCpuMonitor(false);
      if (this.closing) {
        void this.cleanupContainer().catch((error) => { this.terminalError = combineErrors(this.terminalError, error as Error); });
        this.closeResolve();
        return;
      }
      const oom = code === 137 || signal === "SIGKILL";
      if (code !== 0 || signal || this.handshakeState !== "ready") {
        void this.fail(new MatchProfileError(oom ? "OOM" : "NON_ZERO_EXIT", `Match Profile 异常退出：${code ?? signal ?? "启动握手前正常退出"}`));
      }
      else void this.cleanupContainer().catch((error) => { this.terminalError = combineErrors(this.terminalError, error as Error); });
      this.closeResolve();
    });
  }
  private readonly timeoutMs: number;

  async request(request: MatchProtocolRequest): Promise<MatchProtocolResponse> {
    await this.readyPromise;
    if (this.terminalError) throw this.terminalError;
    if (this.exited) throw new MatchProfileError("NON_ZERO_EXIT", "Match Profile 已退出");
    if (this.pending) throw new MatchProfileError("OUTPUT_OUT_OF_ORDER", "上一请求尚未完成");
    if (request.role !== this.role) throw new MatchProfileError("PROTOCOL_INVALID", "请求角色与 Profile 不匹配");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        void this.fail(new MatchProfileError("TIMEOUT", "插件响应超时"));
      }, this.timeoutMs);
      this.pending = { request, resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async close(): Promise<void> {
    const priorError = this.terminalError;
    let closeError: Error | undefined;
    this.closing = true;
    clearTimeout(this.startupTimer);
    try { await this.stopCpuMonitor(true); } catch (error) {
      closeError = combineErrors(priorError, error as Error);
      this.terminalError = closeError;
    }
    this.child.stdin.end();
    if (!this.exited) this.child.kill("SIGTERM");
    try { await this.cleanupContainer(); } catch (error) {
      closeError = combineErrors(this.terminalError, error as Error);
      this.terminalError = closeError;
    }
    if (this.failurePromise) await this.failurePromise;
    if (closeError) throw closeError;
  }

  async finalize(): Promise<void> {
    try { await this.stopCpuMonitor(true); } catch (error) {
      this.terminalError = combineErrors(this.terminalError, error as Error);
      if (!this.exited) this.child.kill("SIGKILL");
    }
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new MatchProfileError("TIMEOUT", "Match Profile 结束超时"));
      }, MATCH_PROFILE_POLICY.exitTimeoutMs);
    });
    try { await Promise.race([this.closed, timedOut]); } finally {
      if (timer) clearTimeout(timer);
      await this.cleanupContainer();
    }
    if (this.terminalError) throw this.terminalError;
    if (this.output.byteLength > 0) throw new MatchProfileError("OUTPUT_MULTIPLE", "进程结束时存在未关联尾随输出");
  }

  private consume(chunk: Buffer): void {
    this.output = Buffer.concat([this.output, chunk]);
    if (this.output.byteLength > MATCH_OUTPUT_LIMIT_BYTES) {
      return void this.fail(new MatchProfileError("OUTPUT_LIMIT", "插件输出超过 16 KiB"));
    }
    if (this.handshakeState === "failed") return;
    if (this.handshakeState === "initializing") {
      return void this.fail(new MatchProfileError("OUTPUT_OUT_OF_ORDER", "CPU 监管初始化期间存在额外输出"));
    }
    const newline = this.output.indexOf(0x0a);
    if (newline < 0) return;
    if (this.handshakeState === "pending") {
      const raw = this.output.subarray(0, newline).toString("utf8");
      this.output = this.output.subarray(newline + 1);
      try {
        const value = JSON.parse(raw) as unknown;
        if (!record(value) || !exactKeys(value, ["type", "protocolVersion", "role"])
          || value.type !== "match-profile.ready" || value.protocolVersion !== MATCH_PROTOCOL_VERSION || value.role !== this.role) {
          throw new MatchProfileError("PROTOCOL_INVALID", "Match Profile 启动握手非法");
        }
        this.handshakeState = "initializing";
        if (this.output.byteLength > 0) {
          return void this.fail(new MatchProfileError("OUTPUT_OUT_OF_ORDER", "启动握手后存在未关联输出"));
        }
        void this.startCpuMonitor().then(() => {
          if (this.handshakeState !== "initializing") return;
          this.handshakeState = "ready";
          clearTimeout(this.startupTimer);
          this.readyResolve();
        }, (error) => { void this.fail(error as Error); });
      } catch (error) { void this.fail(error as Error); }
      return;
    }
    if (!this.pending) return void this.fail(new MatchProfileError("OUTPUT_OUT_OF_ORDER", "收到未关联输出"));
    if (newline !== this.output.byteLength - 1 || this.output.indexOf(0x0a, newline + 1) >= 0) {
      return void this.fail(new MatchProfileError("OUTPUT_MULTIPLE", "每个请求只能返回一个 JSON Lines 输出"));
    }
    const raw = this.output.subarray(0, newline).toString("utf8");
    this.output = Buffer.alloc(0);
    let response: unknown;
    try { response = JSON.parse(raw); } catch { return void this.fail(new MatchProfileError("PROTOCOL_INVALID", "插件输出不是合法 JSON")); }
    const pending = this.pending;
    try { validateResponse(response, pending.request); } catch (error) { return void this.fail(error as Error); }
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      pending.resolve(response as MatchProtocolResponse);
    }, 2);
  }

  private fail(error: Error): Promise<void> {
    if (this.failurePromise) return this.failurePromise;
    this.handshakeState = "failed";
    const primaryError = this.terminalError ?? error;
    this.terminalError = primaryError;
    this.failurePromise = this.performFailure(primaryError);
    return this.failurePromise;
  }

  private async performFailure(primaryError: Error): Promise<void> {
    clearTimeout(this.startupTimer);
    await this.stopCpuMonitor(false);
    if (!this.exited) this.child.kill("SIGKILL");
    try { await this.cleanupContainer(); } catch (cleanupError) {
      this.terminalError = combineErrors(primaryError, cleanupError as Error);
    }
    this.readyReject(this.terminalError ?? primaryError);
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(this.terminalError ?? primaryError);
  }

  private cleanupContainer(): Promise<void> {
    if (!this.command.cleanup) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      if (!this.exited) {
        await Promise.race([
          this.closed,
          new Promise<void>((resolve) => setTimeout(resolve, MATCH_PROFILE_POLICY.exitTimeoutMs)),
        ]);
      }
      await cleanupContainer(this.command.cleanup!);
    })();
    return this.cleanupPromise;
  }

  private async startCpuMonitor(): Promise<void> {
    const monitor = this.command.cpuMonitor;
    if (!monitor) return;
    let readUsage: () => Promise<number>;
    if (monitor.dockerSocketPath && monitor.containerIdentity) {
      readUsage = () => readDockerCpuUsageUsec(monitor.dockerSocketPath!, monitor.containerIdentity!);
    } else if (monitor.resolvePid) {
      const pidResult = await runCleanupCommand(monitor.resolvePid);
      const pid = Number(pidResult.stdout.trim());
      if (pidResult.code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new MatchProfileError("NON_ZERO_EXIT", `无法取得 Match Profile 容器 PID（docker 退出码 ${pidResult.code ?? "未知"}）`);
      }
      const procRoot = resolve(monitor.procRoot ?? "/proc");
      const cgroupRoot = resolve(monitor.cgroupRoot ?? "/sys/fs/cgroup");
      const membership = readFileSync(join(procRoot, String(pid), "cgroup"), "utf8");
      const unified = membership.split(/\r?\n/).find((line) => line.startsWith("0::"))?.slice(3);
      if (!unified?.startsWith("/")) throw new MatchProfileError("NON_ZERO_EXIT", "Match Profile 容器不在可监管的 cgroup v2 中");
      const cpuStat = resolve(cgroupRoot, `.${unified}`, "cpu.stat");
      if (cpuStat !== cgroupRoot && !cpuStat.startsWith(`${cgroupRoot}${sep}`)) {
        throw new MatchProfileError("NON_ZERO_EXIT", "Match Profile cgroup 路径越界");
      }
      readUsage = async () => readCpuUsageUsec(cpuStat);
    } else {
      throw new MatchProfileError("NON_ZERO_EXIT", "Match Profile CPU 监管缺少可信计量来源");
    }
    this.cpuReadUsage = readUsage;
    this.cpuLimitUsec = monitor.limitUsec ?? MATCH_PROFILE_POLICY.cpuSeconds * 1_000_000;
    this.cpuSampleIntervalMs = monitor.sampleIntervalMs ?? 10;
    const usage = await readUsage();
    if (usage >= this.cpuLimitUsec) {
      throw new MatchProfileError("TIMEOUT", `Match Profile 整容器累计 CPU 超过 ${this.cpuLimitUsec} 微秒`);
    }
    if (this.handshakeState !== "initializing") return;
    this.cpuMonitorActive = true;
    this.scheduleCpuSample();
  }

  private scheduleCpuSample(): void {
    if (!this.cpuMonitorActive || this.cpuMonitorTimer) return;
    this.cpuMonitorTimer = setTimeout(() => {
      this.cpuMonitorTimer = undefined;
      if (!this.cpuMonitorActive) return;
      const task = this.sampleCpuUsage();
      this.cpuMonitorTask = task;
      void task.finally(() => {
        if (this.cpuMonitorTask === task) this.cpuMonitorTask = Promise.resolve();
        this.scheduleCpuSample();
      });
    }, this.cpuSampleIntervalMs);
  }

  private async sampleCpuUsage(): Promise<void> {
    let monitorError: MatchProfileError | undefined;
    try {
      const usage = await this.cpuReadUsage!();
      if (usage >= this.cpuLimitUsec) {
        monitorError = new MatchProfileError("TIMEOUT", `Match Profile 整容器累计 CPU 超过 ${this.cpuLimitUsec} 微秒`);
      }
    } catch (error) {
      monitorError = new MatchProfileError("NON_ZERO_EXIT", `Match Profile CPU 监管失败：${(error as Error).message}`);
    }
    if (!monitorError) return;
    this.cpuMonitorError ??= monitorError;
    // finalize 会关闭主动采样后等待在途请求，错误必须留给终态检查传播。
    if (this.cpuMonitorActive) queueMicrotask(() => { void this.fail(this.cpuMonitorError!); });
  }

  private async stopCpuMonitor(finalCheck: boolean): Promise<void> {
    this.cpuMonitorActive = false;
    if (this.cpuMonitorTimer) clearTimeout(this.cpuMonitorTimer);
    this.cpuMonitorTimer = undefined;
    await this.cpuMonitorTask;
    if (!finalCheck || this.cpuMonitorFinalized) return;
    this.cpuMonitorFinalized = true;
    if (!this.cpuReadUsage || this.terminalError) return;
    let finalError: MatchProfileError | undefined;
    try {
      const usage = await this.cpuReadUsage();
      if (usage >= this.cpuLimitUsec) {
        finalError = new MatchProfileError("TIMEOUT", `Match Profile 整容器累计 CPU 超过 ${this.cpuLimitUsec} 微秒`);
      }
    } catch (error) {
      finalError = new MatchProfileError("NON_ZERO_EXIT", `Match Profile CPU 终态监管失败：${(error as Error).message}`);
    }
    if (this.cpuMonitorError) throw this.cpuMonitorError;
    if (finalError) throw finalError;
  }
}

export interface ArenaMatchRunner {
  run(seed: string, onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void): Promise<MatchResult>;
}

type UnsequencedMatchEvent = MatchEvent extends infer Event
  ? Event extends MatchEvent ? Omit<Event, "protocolVersion" | "sequence"> : never
  : never;

export class NativePluginMatchRunner implements ArenaMatchRunner {
  constructor(private readonly commands: MatchProfileCommandFactory) {}

  async run(seed: string, onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void): Promise<MatchResult> {
    const generator = new MatchProfileProcess(this.commands.create("generator"), "generator");
    const solver = new MatchProfileProcess(this.commands.create("solver"), "solver");
    let primaryError: Error | undefined;
    try {
      const passages: MazeSnapshot["passages"] = [];
      const events: MatchEvent[] = [];
      let eventSequence = 0;
      const emit = async (event: UnsequencedMatchEvent) => {
        const sequenced = { ...event, protocolVersion: 1 as const, sequence: ++eventSequence } as MatchEvent;
        events.push(sequenced);
        await onEvents?.([sequenced]);
      };
      await emit({ type: "match.started", seed, size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, stepBudget: MAX_SOLVER_STEPS });
      const carved = new Set<string>();
      let generatorSequence = 0;
      let response = generatorPayload(await generator.request(request("generator", ++generatorSequence, {
        type: "generator.start",
        seed,
        rules: { size: GRID_SIZE, start: { ...START }, goal: { ...GOAL } },
      })));
      while (response.type !== "generator.complete") {
        const key = passageKey(response.from, response.to);
        if (carved.has(key)) throw new MatchProfileError("PROTOCOL_INVALID", "生成器重复凿通边");
        carved.add(key);
        passages.push({ from: { ...response.from }, to: { ...response.to } });
        await emit({ type: "maze.carved", from: { ...response.from }, to: { ...response.to } });
        if (passages.length > GRID_SIZE * (GRID_SIZE - 1) * 2) throw new MatchProfileError("PROTOCOL_INVALID", "生成器凿通数量超出网格上限");
        response = generatorPayload(await generator.request(request("generator", ++generatorSequence, { type: "generator.next" })));
      }
      await generator.finalize();
      const maze: MazeSnapshot = { size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, passages };
      const mazeValidation = validateMaze(maze);
      if (!mazeValidation.valid) throw new MatchProfileError("PROTOCOL_INVALID", mazeValidation.reason ?? "生成迷宫非法");
      await emit({ type: "maze.completed", passageCount: passages.length });

      let solverSequence = 0;
      const ready = solverPayload(await solver.request(request("solver", ++solverSequence, {
        type: "solver.start", start: { ...START }, goal: { ...GOAL },
      })));
      if (ready.type !== "solver.ready") throw new MatchProfileError("PROTOCOL_INVALID", "求解器初始化响应非法");
      let position: Coordinate = { ...START };
      let previousAction: { direction: "north" | "east" | "south" | "west"; moved: boolean } | null = null;
      let actions = 0;
      let illegalMoves = 0;
      let backtracks = 0;
      while (!same(position, GOAL) && actions < MAX_SOLVER_STEPS) {
        const open = openDirections(maze, position);
        const next = solverPayload(await solver.request(request("solver", ++solverSequence, {
          type: "solver.next", position: { ...position }, start: { ...START }, goal: { ...GOAL },
          openDirections: open, remainingSteps: MAX_SOLVER_STEPS - actions, previousAction,
        })));
        if (next.type !== "solver.move") throw new MatchProfileError("PROTOCOL_INVALID", "求解器动作响应非法");
        const from = { ...position };
        const candidate = moved(position, next.direction);
        const didMove = open.includes(next.direction);
        actions += 1;
        if (didMove) position = candidate;
        else illegalMoves += 1;
        if (next.kind === "backtrack") backtracks += 1;
        previousAction = { direction: next.direction, moved: didMove };
        await emit({
          type: "solver.action", step: actions,
          action: { direction: next.direction, kind: next.kind }, from, to: { ...position }, moved: didMove,
        });
      }
      const score: MatchScore = {
        solved: same(position, GOAL), actions, illegalMoves, backtracks, remainingSteps: MAX_SOLVER_STEPS - actions,
      };
      await solver.finalize();
      await emit({ type: "match.completed", score });
      return { maze, events, score };
    } catch (error) {
      primaryError = error as Error;
      throw error;
    } finally {
      const cleanupResults = await Promise.allSettled([generator.close(), solver.close()]);
      const cleanupErrors = cleanupResults.flatMap((result) => result.status === "rejected" ? [result.reason as Error] : []);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
          primaryError ? `${primaryError.message}；且 Match Profile 清理失败` : "Match Profile 清理失败",
        );
      }
    }
  }
}

export function validateResponse(value: unknown, request: MatchProtocolRequest): asserts value is MatchProtocolResponse {
  if (!record(value) || !exactKeys(value, ["protocolVersion", "requestId", "sequence", "role", "payload"])
    || value.protocolVersion !== MATCH_PROTOCOL_VERSION || value.requestId !== request.requestId
    || value.sequence !== request.sequence || value.role !== request.role || !record(value.payload)) {
    throw new MatchProfileError("OUTPUT_OUT_OF_ORDER", "响应关联、顺序或协议版本非法");
  }
  const payload = value.payload;
  if (request.role === "generator") {
    if (payload.type === "generator.complete") {
      if (!exactKeys(payload, ["type"])) invalidPayload();
      return;
    }
    if (payload.type !== "generator.carve" || !exactKeys(payload, ["type", "from", "to"])
      || !coordinate(payload.from) || !coordinate(payload.to)
      || Math.abs(payload.from.x - payload.to.x) + Math.abs(payload.from.y - payload.to.y) !== 1) invalidPayload();
  } else if (request.payload.type === "solver.start") {
    if (payload.type !== "solver.ready" || !exactKeys(payload, ["type"])) invalidPayload();
  } else if (payload.type !== "solver.move" || !exactKeys(payload, ["type", "direction", "kind"])
    || !["north", "east", "south", "west"].includes(String(payload.direction))
    || !["move", "backtrack"].includes(String(payload.kind))) invalidPayload();
}

export interface PluginQuotaReport {
  source: { files: number; bytes: number };
  runtime: { files: number; bytes: number };
  auxiliary: { files: number; bytes: number };
  lineageEntries: Array<{ path: string; bytes: number }>;
  buildBytes: number;
  runtimeSha256: string;
  installPayloadSha256: string;
}

export type LineageBaseline = Record<string, string>;

export async function validatePluginPackage(packageRoot: string, lineageBaseline: LineageBaseline = {}): Promise<PluginQuotaReport> {
  const root = resolve(packageRoot);
  assertPackageTreePreflight(root);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== "string" || !patch.startsWith("./")) throw new Error("插件必须声明相对 dsh.bundle.patch");
  validateBundlePatch(manifest.name, readFileSync(join(root, patch), "utf8"));
  const packed = (await packageFiles(root, manifest)).map((path) => ({ path, size: statSync(join(root, path)).size }));
  const forbiddenPacked = packed.filter(({ path }) => /\.(?:node|wasm)$/i.test(path));
  if (forbiddenPacked.length > 0) throw new Error(`插件不得包含二进制、原生或 WebAssembly 产物：${forbiddenPacked[0]!.path}`);
  const metadata = new Set(["package.json", patch.slice(2)]);
  const installPayload = packed.filter(({ path }) => !metadata.has(path));
  const unsupportedPacked = installPayload.filter(({ path }) => !/\.(?:[cm]?js|d\.ts|map|json|dat)$/i.test(path));
  if (unsupportedPacked.length > 0) throw new Error(`插件包含非允许类型的安装内容：${unsupportedPacked[0]!.path}`);
  const buildBytes = installPayload.reduce((sum, file) => sum + file.size, 0);
  if (buildBytes > 2 * 1024 * 1024) throw new Error("构建产物超过冻结配额");
  const binaryPacked = installPayload.find(({ path }) => readFileSync(join(root, path)).includes(0));
  if (binaryPacked) throw new Error(`插件不得包含二进制安装内容：${binaryPacked.path}`);
  validateModuleClosure(root, packed.map(({ path }) => path), new Set(Object.keys(manifest.dependencies ?? {})));
  if (packed.some(({ path }) => path === "docs" || path.startsWith("docs/") || path === "lineage" || path.startsWith("lineage/") || /\.test\.[cm]?[jt]sx?$/.test(path))) {
    throw new Error("测试、文档与 lineage 不得进入 npm pack 构建产物");
  }
  const all = walk(root).filter((path) => !path.includes(`${sep}node_modules${sep}`));
  const source = all.filter((path) => !relative(root, path).startsWith(`dist${sep}`)
    && /(?<!\.d)\.[cm]?[jt]sx?$/i.test(path));
  const sourceSet = new Set(source);
  const packedSet = new Set(packed.map(({ path }) => normalizeLocal(path)));
  const lineage = all.filter((path) => relative(root, path).startsWith(`lineage${sep}`));
  const auxiliary = all.filter((path) => {
    const local = relative(root, path);
    return !sourceSet.has(path) && !local.startsWith(`lineage${sep}`) && !packedSet.has(normalizeLocal(local))
      && local !== "package.json" && local !== patch.slice(2) && local !== "tsconfig.json";
  });
  const runtime = collectRuntimeFiles(root, manifest, packed.map(({ path }) => path));
  const result = {
    source: measure(source), runtime: measure(runtime.map((path) => join(root, path))), auxiliary: measure(auxiliary),
    lineageEntries: lineage.map((path) => ({ path: relative(root, path), bytes: statSync(path).size })),
    buildBytes,
    runtimeSha256: hashFiles(root, runtime),
    installPayloadSha256: hashFiles(root, installPayload.map(({ path }) => path)),
  };
  if (result.runtime.files > 64 || result.runtime.bytes > 256 * 1024) throw new Error("可安装运行载荷超过冻结配额");
  if (result.source.files > 64 || result.source.bytes > 256 * 1024) throw new Error("候选源码超过冻结配额");
  if (result.auxiliary.files > 128 || result.auxiliary.bytes > 2 * 1024 * 1024) throw new Error("辅助工程资料超过冻结配额");
  if (result.lineageEntries.some(({ bytes }) => bytes > 64 * 1024)) throw new Error("lineage 条目超过冻结配额");
  const currentLineage = Object.fromEntries(lineage.map((path) => [relative(root, path), sha256(path)]));
  for (const [path, hash] of Object.entries(lineageBaseline)) {
    if (currentLineage[path] !== hash) throw new Error(`既有 lineage 条目被修改或删除：${path}`);
  }
  const additions = Object.keys(currentLineage).filter((path) => !(path in lineageBaseline));
  if (additions.length > 1) throw new Error("每次候选尝试最多新增一份 lineage 策略计划");
  return result;
}

export interface TrustedCandidateBuildReport extends PluginQuotaReport {
  changedSourcePaths: string[];
  contentSha256: string;
}

const CANDIDATE_IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist",
]);

/** 从冻结源码和工具链重建候选，绝不采用模型写入的安装产物。 */
export async function rebuildTrustedPluginCandidate(options: {
  championRoot: string;
  candidateRoot: string;
  trustedToolRoot: string;
  testRunner: TrustedCandidateTestRunner;
  strategyRecord?: { attemptId: string; strategyPlan: string };
}): Promise<TrustedCandidateBuildReport> {
  const championRoot = resolve(options.championRoot);
  const candidateRoot = resolve(options.candidateRoot);
  const trustedToolRoot = resolve(options.trustedToolRoot);
  assertPackageTreePreflight(championRoot);
  assertPackageTreePreflight(candidateRoot);
  assertPackageTreePreflight(trustedToolRoot);
  const championManifest = readJsonObject(join(championRoot, "package.json"));
  const candidateManifest = readJsonObject(join(candidateRoot, "package.json"));
  const trustedManifest = readJsonObject(join(trustedToolRoot, "package.json"));
  if (canonicalJson(candidateManifest) !== canonicalJson(championManifest)) throw new Error("候选不得修改冻结 package.json");
  if (canonicalJson(packageDependencyContract(trustedManifest)) !== canonicalJson(packageDependencyContract(championManifest))) {
    throw new Error("可信构建工具链的依赖契约与冠军不一致");
  }

  const before = sourceTreeIdentity(championRoot);
  const after = sourceTreeIdentity(candidateRoot);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]).sort();
  const forbidden = changed.find((path) => !path.startsWith("src/") && !path.startsWith("docs/") && !path.startsWith("lineage/"));
  if (forbidden) throw new Error(`候选修改了冻结保护边界：${forbidden}`);
  for (const [path, hash] of Object.entries(before).filter(([path]) => path.startsWith("lineage/"))) {
    if (after[path] !== hash) throw new Error(`候选修改或删除了既有策略记录：${path}`);
  }
  const changedSourcePaths = changed.filter((path) => path.startsWith("src/") && !/\.test\.[cm]?[jt]sx?$/.test(path));
  if (changedSourcePaths.length === 0) throw new Error("候选没有可安装运行源码变化");
  const addedLineage = changed.filter((path) => path.startsWith("lineage/") && !(path in before));
  if (addedLineage.length > 0) {
    const expectedPath = options.strategyRecord && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.strategyRecord.attemptId)
      ? `lineage/${options.strategyRecord.attemptId}.md` : undefined;
    if (!expectedPath || addedLineage.length !== 1 || addedLineage[0] !== expectedPath) throw new Error("候选新增了非标准策略记录");
    if (Buffer.byteLength(options.strategyRecord!.strategyPlan, "utf8") > 64 * 1024
      || readFileSync(join(candidateRoot, expectedPath), "utf8") !== options.strategyRecord!.strategyPlan) {
      throw new Error("候选策略记录与 Harness 响应不一致");
    }
  }
  assertCandidatePrebuildQuota(candidateRoot);

  const lineageBaseline = lineageIdentity(championRoot);
  const championReport = await validatePluginPackage(championRoot, lineageBaseline);
  const buildRoot = mkdtempSync(join(tmpdir(), "maze-candidate-build-"));
  try {
    copyCandidateSources(candidateRoot, buildRoot);
    replaceCandidateTestsWithTrustedTests(buildRoot, trustedToolRoot);
    const trustedNodeModules = realpathSync(join(trustedToolRoot, "node_modules"));
    const trustedTsc = join(trustedNodeModules, ".bin/tsc");
    const trustedVitest = join(trustedNodeModules, ".bin/vitest");
    if (!existsSync(trustedTsc) || !existsSync(trustedVitest)) throw new Error("冻结候选构建工具链不完整");
    assertTrustedToolVersion(trustedNodeModules, "typescript", trustedManifest);
    assertTrustedToolVersion(trustedNodeModules, "vitest", trustedManifest);
    symlinkSync(trustedNodeModules, join(buildRoot, "node_modules"), "dir");
    // 临时副本中的原始相对 extends 已脱离仓库层级；以冻结配置的绝对路径替换它。
    const configPath = join(buildRoot, "tsconfig.json");
    writeFileSync(configPath, `${JSON.stringify({
      compilerOptions: {
        strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
        esModuleInterop: true, forceConsistentCasingInFileNames: true, skipLibCheck: true,
        noUncheckedIndexedAccess: true, declaration: true,
        rootDir: join(buildRoot, "src"), outDir: join(buildRoot, "dist"),
      },
      include: [join(buildRoot, "src/**/*.ts")],
      exclude: [join(buildRoot, "src/**/*.test.ts")],
    })}\n`);
    runTrustedCandidateCommand(trustedTsc, ["-p", configPath, "--noEmit"], buildRoot, "类型检查");
    await withReadOnlyCandidateTestTree(buildRoot, () => options.testRunner.run({ packageRoot: buildRoot, trustedToolRoot }));
    runTrustedCandidateCommand(trustedTsc, ["-p", configPath], buildRoot, "构建");
    const buildReport = await validatePluginPackage(buildRoot, lineageBaseline);
    if (buildReport.runtimeSha256 === championReport.runtimeSha256) throw new Error("候选可信重建后的可安装运行载荷没有变化");

    const candidateDist = join(candidateRoot, "dist");
    if (existsSync(candidateDist)) renameSync(candidateDist, join(buildRoot, "untrusted-dist"));
    renameSync(join(buildRoot, "dist"), candidateDist);
    const report = await validatePluginPackage(candidateRoot, lineageBaseline);
    if (report.installPayloadSha256 !== buildReport.installPayloadSha256) throw new Error("候选安装载荷身份与可信构建结果不一致");
    return { ...report, changedSourcePaths, contentSha256: candidateContentIdentity(candidateRoot, report.installPayloadSha256) };
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}

export async function verifyTrustedPluginCandidate(root: string, expectedContentSha256: string): Promise<void> {
  const resolved = resolve(root);
  assertPackageTreePreflight(resolved);
  const report = await validatePluginPackage(resolved, lineageIdentity(resolved));
  if (candidateContentIdentity(resolved, report.installPayloadSha256) !== expectedContentSha256) {
    throw new Error("候选工作区已偏离可信重建内容身份");
  }
}

function runTrustedCandidateCommand(executable: string, args: string[], cwd: string, label: string): void {
  const result = spawnSync(executable, args, {
    cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, NO_COLOR: "1" },
  });
  if (result.error || result.status !== 0) {
    const diagnostic = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 8_192);
    throw new Error(`候选${label}失败${diagnostic ? `：${diagnostic}` : ""}`);
  }
}

function assertImmutableImageReference(image: string): void {
  const directDigest = /^sha256:[0-9a-f]{64}$/;
  const imageNameSegment = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
  const registrySegment = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?$/;
  const named = image.match(/^(.+)@(sha256:[0-9a-f]{64})$/);
  const namedSegments = named?.[1]!.split("/") ?? [];
  const validNamedDigest = namedSegments.length > 0 && namedSegments.every((segment, index) =>
    (index === 0 && namedSegments.length > 1 ? registrySegment : imageNameSegment).test(segment));
  if (!directDigest.test(image) && !validNamedDigest) {
    throw new Error("Match Profile 镜像必须使用完整 sha256 摘要精确锁定");
  }
}

function copyCandidateSources(source: string, destination: string, root = source): void {
  for (const entry of readdirSync(source)) {
    if (source === root && CANDIDATE_IGNORED_DIRECTORIES.has(entry)) continue;
    const from = join(source, entry);
    const to = join(destination, entry);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`候选源树包含不安全文件：${relative(source, from)}`);
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyCandidateSources(from, to, root);
    } else cpSync(from, to);
  }
}

function replaceCandidateTestsWithTrustedTests(buildRoot: string, trustedToolRoot: string): void {
  for (const path of walk(join(buildRoot, "src"), true).filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path))) unlinkSync(path);
  for (const path of walk(join(trustedToolRoot, "src"), true).filter((path) => /\.test\.[cm]?[jt]sx?$/.test(path))) {
    const target = join(buildRoot, "src", relative(join(trustedToolRoot, "src"), path));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(path, target);
  }
}

function assertTrustedToolVersion(nodeModules: string, name: "typescript" | "vitest", manifest: Record<string, unknown>): void {
  const expected = record(manifest.devDependencies) ? manifest.devDependencies[name] : undefined;
  const actual = readJsonObject(join(nodeModules, name, "package.json")).version;
  if (typeof expected !== "string" || typeof actual !== "string" || expected !== actual) {
    throw new Error(`冻结候选构建工具版本漂移：${name}`);
  }
}

function trustedVitestEntry(trustedToolRoot: string): string {
  const packageRoot = realpathSync(join(trustedToolRoot, "node_modules/vitest"));
  const manifest = readJsonObject(join(packageRoot, "package.json"));
  const binary = typeof manifest.bin === "string"
    ? manifest.bin
    : record(manifest.bin) && typeof manifest.bin.vitest === "string" ? manifest.bin.vitest : undefined;
  if (!binary || isAbsolute(binary)) throw new Error("冻结 Vitest 包缺少相对 JavaScript 入口");
  const entry = realpathSync(join(packageRoot, binary));
  const relation = relative(packageRoot, entry);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation) || !/\.[cm]?js$/i.test(entry)) {
    throw new Error("冻结 Vitest JavaScript 入口越出可信包");
  }
  return entry;
}

function trustedCandidateTestMounts(
  packageRoot: string,
  trustedToolRoot: string,
  repositoryRoot: string,
  runtimeExecutable: string,
): string[] {
  const repositoryNodeModules = realpathSync(join(repositoryRoot, "node_modules"));
  const trustedNodeModules = realpathSync(join(trustedToolRoot, "node_modules"));
  const manifest = readJsonObject(join(trustedToolRoot, "package.json"));
  const dependencies = record(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  const workspaceDependencies = dependencies.flatMap((name) => {
    const dependency = realpathSync(join(trustedNodeModules, ...name.split("/")));
    const inNodeModules = relative(repositoryNodeModules, dependency);
    if (inNodeModules !== ".." && !inNodeModules.startsWith(`..${sep}`) && !isAbsolute(inNodeModules)) return [];
    const inRepository = relative(repositoryRoot, dependency);
    if (inRepository === ".." || inRepository.startsWith(`..${sep}`) || isAbsolute(inRepository)) {
      throw new Error(`冻结候选测试依赖越出仓库：${name}`);
    }
    return [dependency];
  });
  const runtimeMount = isAbsolute(runtimeExecutable) ? [realpathSync(runtimeExecutable)] : [];
  return [...new Set([packageRoot, repositoryNodeModules, trustedNodeModules, ...workspaceDependencies, ...runtimeMount])];
}

async function withReadOnlyCandidateTestTree<T>(root: string, run: () => T | Promise<T>): Promise<T> {
  const modes: Array<{ path: string; mode: number }> = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`候选测试树包含不支持的文件类型：${relative(root, path)}`);
    modes.push({ path, mode: stat.mode & 0o777 });
    chmodSync(path, stat.isDirectory() ? 0o555 : 0o444);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  try {
    visit(root);
    return await run();
  } finally {
    // 先恢复父目录的遍历权限，再恢复其子项，确保失败路径也可完整清理。
    for (const item of modes) chmodSync(item.path, item.mode);
  }
}

function sourceTreeIdentity(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (directory === root && CANDIDATE_IGNORED_DIRECTORIES.has(entry)) continue;
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`候选源树包含不安全文件：${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else result[normalizeLocal(relative(root, path))] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  visit(root);
  return result;
}

function assertPackageTreePreflight(root: string): void {
  const limits = { files: 256, singleBytes: 2 * 1024 * 1024, totalBytes: 5 * 1024 * 1024 };
  let files = 0;
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      if (directory === root && (entry === ".git" || entry === "node_modules")) continue;
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`候选源树包含不安全文件：${relative(root, path)}`);
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      files += 1;
      totalBytes += stat.size;
      const local = normalizeLocal(relative(root, path));
      if (local.startsWith("lineage/") && stat.size > 64 * 1024) throw new Error("lineage 条目超过冻结配额");
      if (local.startsWith("src/") && /(?<!\.d)\.[cm]?[jt]sx?$/i.test(local) && stat.size > 256 * 1024) {
        throw new Error("候选源码超过冻结配额");
      }
      if (local.startsWith("dist/") && stat.size > 2 * 1024 * 1024) throw new Error("构建产物超过冻结配额");
      if (files > limits.files || stat.size > limits.singleBytes || totalBytes > limits.totalBytes) {
        throw new Error("候选文件树超过冻结预检配额");
      }
    }
  };
  visit(root);
}

function lineageIdentity(root: string): LineageBaseline {
  return Object.fromEntries(Object.entries(sourceTreeIdentity(root)).filter(([path]) => path.startsWith("lineage/")));
}

function assertCandidatePrebuildQuota(root: string): void {
  const source = walk(join(root, "src"), true).filter((path) => /(?<!\.d)\.[cm]?[jt]sx?$/i.test(path));
  const report = measure(source);
  if (report.files > 64 || report.bytes > 256 * 1024) throw new Error("候选源码超过冻结配额");
}

function candidateContentIdentity(root: string, installPayloadSha256: string): string {
  const source = Object.fromEntries(Object.entries(sourceTreeIdentity(root)).filter(([path]) => !path.startsWith("lineage/")));
  return createHash("sha256").update(canonicalJson({ installPayloadSha256, source })).digest("hex");
}

function readJsonObject(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!record(value)) throw new Error(`JSON 对象非法：${path}`);
  return value;
}

function packageDependencyContract(manifest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .map((key) => [key, manifest[key] ?? {}]));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hashFiles(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...files].map(normalizeLocal).sort()) {
    hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
  }
  return hash.digest("hex");
}

function collectRuntimeFiles(root: string, manifest: Record<string, any>, packed: string[]): string[] {
  const packedSet = new Set(packed.map(normalizeLocal));
  const entries = new Set<string>();
  collectManifestEntries(manifest.main, entries);
  collectManifestEntries(manifest.exports, entries);
  const patchPath = manifest.dsh?.bundle?.patch;
  if (typeof patchPath === "string") {
    const document = parseDocument(readFileSync(join(root, patchPath), "utf8")).toJS() as Array<{ insert?: Array<{ name?: string }> }>;
    for (const contribution of document[0]?.insert ?? []) {
      if (typeof contribution.name !== "string" || contribution.name === manifest.name) continue;
      const subpath = contribution.name.startsWith(`${manifest.name}/`) ? `./${contribution.name.slice(manifest.name.length + 1)}` : undefined;
      if (subpath && record(manifest.exports)) collectManifestEntries(manifest.exports[subpath], entries);
    }
  }
  const queue = [...entries].map(normalizeLocal);
  const result = new Set<string>();
  while (queue.length) {
    const current = resolvePackedModule(queue.shift()!, packedSet);
    if (!current || result.has(current)) continue;
    result.add(current);
    const source = readFileSync(join(root, current), "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      queue.push(normalizeLocal(relative(root, resolve(dirname(join(root, current)), specifier))));
    }
  }
  return [...result];
}

function collectManifestEntries(value: unknown, output: Set<string>): void {
  if (typeof value === "string" && value.startsWith("./") && !value.endsWith(".d.ts")) output.add(value.slice(2));
  else if (record(value)) for (const nested of Object.values(value)) collectManifestEntries(nested, output);
}

function resolvePackedModule(candidate: string, packed: Set<string>): string | undefined {
  return [candidate, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.cjs`, `${candidate}/index.js`, `${candidate}/index.mjs`, `${candidate}/index.cjs`]
    .find((path) => packed.has(path));
}

function normalizeLocal(path: string): string { return path.split(sep).join("/").replace(/^\.\//, ""); }

async function packageFiles(root: string, manifest: Record<string, any>): Promise<string[]> {
  return [...await packlist({ path: root, package: manifest, edgesOut: new Map(), isProjectRoot: false } as any)];
}

function validateBundlePatch(packageName: string, text: string): void {
  const document = parseDocument(text);
  if (document.errors.length) throw new Error("bundle patch 不是合法 YAML");
  const patch = document.toJS() as unknown;
  if (!Array.isArray(patch) || patch.length !== 1 || !record(patch[0]) || !exactKeys(patch[0], ["insert"])
    || !Array.isArray(patch[0].insert)) throw new Error("bundle patch 只能包含一个 insert 操作");
  const entries = patch[0].insert;
  if (packageName === "@maze-arena/match-profile") {
    const expected = [
      { id: "maze-match-protocol-generator", name: "@maze-arena/match-profile/host", inject: ["mazeGenerator"], disabled: "process.env.MAZE_MATCH_ROLE !== 'generator'" },
      { id: "maze-match-protocol-solver", name: "@maze-arena/match-profile/host", inject: ["mazeSolver"], disabled: "process.env.MAZE_MATCH_ROLE !== 'solver'" },
    ];
    if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error("协议 bundle 贡献项不符合冻结配置");
    return;
  }
  const id = packageName === "@maze-arena/generator-plugin" ? "maze-generator"
    : packageName === "@maze-arena/solver-plugin" ? "maze-solver" : undefined;
  if (!id || entries.length !== 1 || !record(entries[0]) || !exactKeys(entries[0], ["id", "name"])
    || entries[0].id !== id || entries[0].name !== packageName) throw new Error("角色 bundle 必须且只能挂载自身一个能力入口");
}

async function createInstallArtifact(source: string, artifactRoot: string): Promise<string> {
  const root = resolve(source);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>;
  const packageName = manifest.name as string;
  const packed = await packageFiles(root, manifest);
  const files = packageName === "@maze-arena/match-profile"
    ? packed.filter((file) => file === "package.json" || file === manifest.dsh?.bundle?.patch?.slice(2) || /^dist\/host\.(?:js|d\.ts)$/.test(file))
    : packed;
  const staging = join(artifactRoot, `.staging-${process.pid}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`);
  rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    const target = join(staging, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target);
  }
  const cleanManifest = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
  delete cleanManifest.scripts;
  delete cleanManifest.devDependencies;
  cleanManifest.dependencies = {};
  if (packageName === "@maze-arena/match-profile") {
    cleanManifest.main = "./dist/host.js";
    cleanManifest.types = "./dist/host.d.ts";
    cleanManifest.exports = { ".": { types: "./dist/host.d.ts", default: "./dist/host.js" }, "./host": "./dist/host.js" };
    cleanManifest.files = ["dist/host.js", "dist/host.d.ts", "cordis.patch.yml"];
  }
  validateModuleClosure(staging, files, new Set());
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(cleanManifest, null, 2)}\n`);
  const digest = hashDirectory(staging);
  const artifact = join(artifactRoot, `sha256-${digest}`);
  if (existsSync(artifact)) {
    if (hashDirectory(artifact) !== digest) throw new Error(`内容寻址安装产物已被篡改：${artifact}`);
    rmSync(staging, { recursive: true, force: true });
    return artifact;
  }
  renameSync(staging, artifact);
  return artifact;
}

async function validateInstallArtifact(root: string): Promise<void> {
  const artifact = realpathSync(resolve(root));
  const manifestText = readFileSync(join(artifact, "package.json"), "utf8");
  if (manifestText.includes("workspace:")) throw new Error("安装产物不得保留 workspace 依赖");
  const manifest = JSON.parse(manifestText) as Record<string, any>;
  if (manifest.scripts || manifest.devDependencies || Object.keys(manifest.dependencies ?? {}).length !== 0) {
    throw new Error("安装产物必须是无生命周期脚本且依赖闭包完整的最小包");
  }
  await validatePluginPackage(artifact);
  validateModuleClosure(artifact, walk(artifact).map((path) => relative(artifact, path)), new Set());
  const expected = `sha256-${hashDirectory(artifact)}`;
  if (artifact.split(sep).at(-1) !== expected) throw new Error("安装产物目录名与内容哈希不匹配");
}

function validateModuleClosure(root: string, files: string[], allowedBare: Set<string>): void {
  for (const local of files.filter((path) => /\.[cm]?js$/i.test(path))) {
    const source = readFileSync(join(root, local), "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
        if (!allowedBare.has(packageName)) throw new Error(`安装产物存在未封闭的运行依赖：${local} -> ${specifier}`);
        continue;
      }
      const target = resolve(dirname(join(root, local)), specifier);
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`构建产物引用包外模块：${local} -> ${specifier}`);
      if (!existsSync(target) && !existsSync(`${target}.js`) && !existsSync(join(target, "index.js"))) {
        throw new Error(`构建产物引用缺失模块：${local} -> ${specifier}`);
      }
    }
  }
}

function moduleSpecifiers(source: string): string[] {
  let ast: unknown;
  try { ast = parse(source, { sourceType: "unambiguous" }); } catch (error) {
    throw new Error(`可执行文件无法安全解析：${(error as Error).message}`);
  }
  const specifiers: string[] = [];
  const visit = (value: unknown, parent?: Record<string, unknown>, key?: string): void => {
    if (Array.isArray(value)) return void value.forEach((entry) => visit(entry, parent, key));
    if (!record(value)) return;
    const type = value.type;
    if ((type === "ImportDeclaration" || type === "ExportNamedDeclaration" || type === "ExportAllDeclaration") && stringLiteral(value.source)) {
      addModuleSpecifier(specifiers, value.source.value as string);
    } else if (type === "ImportExpression") {
      if (!stringLiteral(value.source)) throw new Error("可执行文件包含无法静态分析的动态 import");
      addModuleSpecifier(specifiers, value.source.value as string);
    } else if (type === "CallExpression" && record(value.callee) && value.callee.type === "Import") {
      const args = Array.isArray(value.arguments) ? value.arguments : [];
      if (args.length !== 1 || !stringLiteral(args[0])) throw new Error("可执行文件包含无法静态分析的动态 import");
      addModuleSpecifier(specifiers, args[0].value as string);
    } else if ((type === "MemberExpression" || type === "OptionalMemberExpression") && forbiddenModuleLoaderMember(value)) {
      throw new Error("可执行文件不得使用成员式 Node 模块加载入口");
    } else if (type === "Identifier" && value.name === "require" && !identifierIsNonReferenceProperty(parent, key)) {
      const directCall = parent?.type === "CallExpression" && key === "callee";
      const args = directCall && Array.isArray(parent.arguments) ? parent.arguments : [];
      if (!directCall || args.length !== 1 || !stringLiteral(args[0])) {
        throw new Error("可执行文件包含无法静态分析的 require");
      }
      addModuleSpecifier(specifiers, args[0].value as string);
    } else if (type === "Identifier" && value.name === "createRequire" && !identifierIsNonReferenceProperty(parent, key)) {
      throw new Error("可执行文件不得使用 createRequire");
    } else if (type === "Identifier" && value.name === "Module" && !identifierIsMemberProperty(parent, key)) {
      throw new Error("可执行文件不得引用 Node Module 加载器");
    } else if (type === "Identifier" && value.name === "module" && !identifierIsNonReferenceProperty(parent, key)
      && !isModuleExportsObject(parent, key)) {
      throw new Error("可执行文件不得引用 CommonJS module 加载器");
    } else if (type === "Identifier" && value.name === "process" && !identifierIsNonReferenceProperty(parent, key)
      && !identifierIsDirectMemberObject(parent, key)) {
      throw new Error("可执行文件不得为 Node 进程全局对象创建别名");
    } else if (type === "Identifier" && ["global", "globalThis"].includes(String(value.name))
      && !identifierIsNonReferenceProperty(parent, key) && !identifierIsDirectMemberObject(parent, key)) {
      throw new Error("可执行文件不得为 Node 全局对象创建别名");
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "loc" || childKey === "start" || childKey === "end" || childKey === "extra") continue;
      visit(child, value, childKey);
    }
  };
  visit(ast);
  return specifiers;
}

function addModuleSpecifier(specifiers: string[], specifier: string): void {
  // Node Module 加载器可派生 createRequire 等包外加载入口，拒绝其来源比追踪任意别名更可靠。
  if (specifier === "module" || specifier === "node:module") {
    throw new Error("可执行文件不得导入 Node Module 加载器");
  }
  specifiers.push(specifier);
}

function stringLiteral(value: unknown): value is Record<string, unknown> {
  return record(value) && value.type === "StringLiteral" && typeof value.value === "string";
}

function identifier(value: unknown, name: string): boolean {
  return record(value) && value.type === "Identifier" && value.name === name;
}

function identifierIsMemberProperty(parent: Record<string, unknown> | undefined, key: string | undefined): boolean {
  if (!parent || key !== "property" || parent.computed) return false;
  return parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression";
}

function identifierIsDirectMemberObject(parent: Record<string, unknown> | undefined, key: string | undefined): boolean {
  return Boolean(parent && key === "object" && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
    && (!parent.computed || stringLiteral(parent.property)));
}

function identifierIsNonReferenceProperty(parent: Record<string, unknown> | undefined, key: string | undefined): boolean {
  if (identifierIsMemberProperty(parent, key)) return true;
  if (!parent || key !== "key" || parent.computed) return false;
  if (parent.type === "ObjectProperty") return parent.shorthand !== true;
  return parent.type === "ObjectMethod" || parent.type === "ClassMethod" || parent.type === "ClassProperty";
}

function isModuleExportsObject(parent: Record<string, unknown> | undefined, key: string | undefined): boolean {
  return Boolean(parent?.type === "MemberExpression" && key === "object" && memberName(parent) === "exports");
}

function memberName(value: Record<string, unknown>): string | undefined {
  if (!record(value.property)) return undefined;
  if (value.computed) return stringLiteral(value.property) ? value.property.value as string : undefined;
  return value.property.type === "Identifier" && typeof value.property.name === "string" ? value.property.name : undefined;
}

function forbiddenModuleLoaderMember(value: Record<string, unknown>): boolean {
  const name = memberName(value);
  if (identifier(value.object, "process") && name === "mainModule") return true;
  if (identifier(value.object, "module") && name === "constructor") return true;
  if (identifier(value.object, "module") && ["require", "createRequire", "_load", "load", "_compile"].includes(name ?? "")) return true;
  if (identifier(value.object, "Module") && ["_load", "createRequire", "register", "registerHooks"].includes(name ?? "")) return true;
  if (identifier(value.object, "process") && ["getBuiltinModule", "binding", "_linkedBinding"].includes(name ?? "")) return true;
  if (["global", "globalThis"].some((root) => identifier(value.object, root)) && name === "process") return true;
  return Boolean(value.computed && !name && ["module", "Module", "process", "global", "globalThis"]
    .some((root) => identifier(value.object, root)));
}

interface CleanupResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

async function cleanupContainer(cleanup: NonNullable<MatchProfileCommand["cleanup"]>): Promise<void> {
  const removal = await runCleanupCommand(cleanup.remove);
  if (removal.code !== 0 && !explicitlyAbsent(removal) && !removalInProgress(removal)) {
    throw new MatchProfileError("NON_ZERO_EXIT", `无法强制清理 Match Profile 容器 ${cleanup.identity}（退出码 ${removal.code ?? "未知"}）`);
  }
  const deadline = Date.now() + MATCH_PROFILE_POLICY.cleanupTimeoutMs;
  let stableAbsent = 0;
  while (Date.now() < deadline) {
    const verification = await runCleanupCommand(cleanup.verifyAbsent);
    if (verification.code === 0) {
      stableAbsent = 0;
      const retry = await runCleanupCommand(cleanup.remove);
      if (retry.code !== 0 && !explicitlyAbsent(retry) && !removalInProgress(retry)) {
        throw new MatchProfileError("NON_ZERO_EXIT", `无法强制清理竞态创建的 Match Profile 容器 ${cleanup.identity}（退出码 ${retry.code ?? "未知"}）`);
      }
    }
    else if (explicitlyAbsent(verification)) stableAbsent += 1;
    else throw new MatchProfileError("NON_ZERO_EXIT", `无法确认 Match Profile 容器已清理（退出码 ${verification.code ?? "未知"}）`);
    if (stableAbsent >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new MatchProfileError("NON_ZERO_EXIT", `Match Profile 容器未在时限内稳定消失：${cleanup.identity}`);
}

function runCleanupCommand(command: MatchProfileCleanupCommand): Promise<CleanupResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.executable, command.args, { env: command.environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, command.timeoutMs ?? MATCH_PROFILE_POLICY.cleanupTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }); });
  });
}

function explicitlyAbsent(result: CleanupResult): boolean {
  return /no such (?:container|object)/i.test(`${result.stdout}\n${result.stderr}`);
}

function removalInProgress(result: CleanupResult): boolean {
  return /removal of container .+ is already in progress/i.test(`${result.stdout}\n${result.stderr}`);
}

function readCpuUsageUsec(cpuStatPath: string): number {
  const value = readFileSync(cpuStatPath, "utf8").split(/\r?\n/)
    .find((line) => line.startsWith("usage_usec "))?.slice("usage_usec ".length);
  const usage = Number(value);
  if (!Number.isSafeInteger(usage) || usage < 0) throw new Error("cgroup v2 cpu.stat 缺少合法 usage_usec");
  return usage;
}

function readDockerCpuUsageUsec(socketPath: string, containerIdentity: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      socketPath,
      path: `/containers/${encodeURIComponent(containerIdentity)}/stats?stream=false&one-shot=true`,
      method: "GET",
      timeout: MATCH_PROFILE_POLICY.cleanupTimeoutMs,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("Docker stats 响应超过 1 MiB"));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Docker stats 返回 HTTP ${response.statusCode}`));
        try {
          const value = JSON.parse(body) as { cpu_stats?: { cpu_usage?: { total_usage?: unknown } } };
          const nanoseconds = value.cpu_stats?.cpu_usage?.total_usage;
          if (typeof nanoseconds !== "number" || !Number.isSafeInteger(nanoseconds) || nanoseconds < 0) {
            throw new Error("Docker stats 缺少合法 cpu_stats.cpu_usage.total_usage");
          }
          resolvePromise(Math.floor(nanoseconds / 1_000));
        } catch (error) { reject(error); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("Docker stats 读取超时")));
    request.once("error", reject);
    request.end();
  });
}

function combineErrors(original: Error | undefined, cleanup: Error): Error {
  return original ? new AggregateError([original, cleanup], `${original.message}；且清理失败：${cleanup.message}`) : cleanup;
}

function hashDirectory(root: string): string {
  const digest = createHash("sha256");
  for (const path of walk(root).sort()) {
    digest.update(relative(root, path).split(sep).join("/")).update("\0").update(readFileSync(path));
  }
  return digest.digest("hex");
}

function validateProfilePatches(home: string, profile: string, expected: string[]): void {
  const profilePatch = parseDocument(readFileSync(join(resolve(home), "profiles", profile, "cordis.patch.yml"), "utf8")).toJS();
  if (!Array.isArray(profilePatch) || profilePatch.length !== 0) throw new Error(`${profile} 不得叠加 Profile 级贡献项`);
  try {
    const homePatch = parseDocument(readFileSync(join(resolve(home), "cordis.patch.yml"), "utf8")).toJS();
    if (!Array.isArray(homePatch) || homePatch.length !== 0) throw new Error("Harness home 不得叠加额外贡献项");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (expected.length !== 2) throw new Error("Profile bundle 数量非法");
}

function walk(root: string, optional = false): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  } catch (error) { if (optional) return []; throw error; }
}
function measure(paths: string[]) { return { files: paths.length, bytes: paths.reduce((sum, path) => sum + statSync(path).size, 0) }; }
function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function profileName(role: MatchPluginRole): string { return `maze-match-${role}`; }
function packageName(root: string): string {
  const name = (JSON.parse(readFileSync(join(resolve(root), "package.json"), "utf8")) as { name?: unknown }).name;
  if (typeof name !== "string" || !name) throw new Error(`bundle 清单缺少包名：${root}`);
  return name;
}
function readProfile(home: string, profile: string): Record<string, any> {
  return JSON.parse(readFileSync(join(resolve(home), "profiles", profile, "package.json"), "utf8")) as Record<string, any>;
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, any>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function coordinate(value: unknown): value is { x: number; y: number } {
  return record(value) && exactKeys(value, ["x", "y"]) && Number.isInteger(value.x) && Number.isInteger(value.y)
    && value.x >= 0 && value.x < 31 && value.y >= 0 && value.y < 31;
}
function invalidPayload(): never { throw new MatchProfileError("PROTOCOL_INVALID", "插件输出领域模式非法"); }

function request(role: MatchPluginRole, sequence: number, payload: MatchProtocolRequest["payload"]): MatchProtocolRequest {
  return { protocolVersion: 1, requestId: `${role}-${sequence}`, sequence, role, payload };
}
function same(left: Coordinate, right: Coordinate): boolean { return left.x === right.x && left.y === right.y; }
function passageKey(from: Coordinate, to: Coordinate): string {
  return [`${from.x},${from.y}`, `${to.x},${to.y}`].sort().join("|");
}
function moved(position: Coordinate, direction: "north" | "east" | "south" | "west"): Coordinate {
  const delta: readonly [number, number] = {
    north: [0, -1] as const, east: [1, 0] as const, south: [0, 1] as const, west: [-1, 0] as const,
  }[direction];
  return { x: position.x + delta[0], y: position.y + delta[1] };
}
function openDirections(maze: MazeSnapshot, position: Coordinate): Array<"north" | "east" | "south" | "west"> {
  const directions: Array<"north" | "east" | "south" | "west"> = [];
  for (const direction of ["north", "east", "south", "west"] as const) {
    if (maze.passages.some(({ from, to }) => passageKey(from, to) === passageKey(position, moved(position, direction)))) directions.push(direction);
  }
  return directions;
}

export function generatorPayload(response: MatchProtocolResponse): GeneratorResponse { return response.payload as GeneratorResponse; }
export function solverPayload(response: MatchProtocolResponse): SolverResponse { return response.payload as SolverResponse; }
