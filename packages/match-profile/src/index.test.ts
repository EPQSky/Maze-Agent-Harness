import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchPluginRole, MatchProtocolRequest } from "@maze-arena/contracts";
import { hashHarnessRuntimePayload } from "@maze-arena/dsh-integration";
import {
  DockerMatchProfileCommandFactory,
  DockerPairedEvaluationRunner,
  DockerTrustedCandidateTestRunner,
  HarnessMatchProfileInstaller,
  MATCH_PROFILE_POLICY_DIGEST,
  MatchProfileError,
  MatchProfileProcess,
  NativePluginMatchRunner,
  rebuildTrustedPluginCandidate,
  validatePluginPackage,
  verifyTrustedPluginCandidate,
  withPrivateGitCommitSnapshot,
  type TrustedCandidateTestRunner,
} from "./index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const peer = join(packageRoot, "test/fixtures/protocol-peer.mjs");
const fakeDsh = join(packageRoot, "test/fixtures/fake-dsh/dsh.mjs");
const fakeHarnessRuntime = {
  runtimeRoot: dirname(fakeDsh),
  runtimePayloadSha256: hashHarnessRuntimePayload(dirname(fakeDsh)),
} as const;
const cleanupFixture = join(packageRoot, "test/fixtures/container-cleanup.mjs");
const fakeCandidateDocker = join(packageRoot, "test/fixtures/fake-candidate-docker.mjs");
const fakePairedDocker = join(packageRoot, "test/fixtures/fake-paired-docker.mjs");
const realDockerTestImage = process.env.MAZE_TEST_DOCKER_IMAGE;
const realDockerImageAvailable = Boolean(realDockerTestImage)
  && spawnSync("docker", ["image", "inspect", realDockerTestImage!], { stdio: "ignore" }).status === 0;
const stubCandidateTestRunner: TrustedCandidateTestRunner = {
  run: ({ packageRoot: candidateRoot }) => {
    // 单元测试只模拟权威测试结论，避免在 Vitest 宿主进程导入候选模块。
    if (readFileSync(join(candidateRoot, "src/index.ts"), "utf8").includes("invalidCandidate")) {
      throw new Error("候选测试失败：权威断言未通过");
    }
  },
};
const createdDshHomes = new Set<string>();

function createDshHome(prefix = "maze-dsh-home-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  createdDshHomes.add(home);
  return home;
}

interface DshHomeCleanupOperations {
  chmodSync(path: string, mode: number): void;
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  rmSync(path: string, options: { recursive: true; force: true }): void;
}

const dshHomeCleanupOperations: DshHomeCleanupOperations = {
  chmodSync,
  lstatSync,
  readdirSync: (path) => readdirSync(path),
  rmSync,
};

function cleanupCreatedDshHomes(overrides: Partial<DshHomeCleanupOperations> = {}): void {
  const operations = { ...dshHomeCleanupOperations, ...overrides };
  const cleanupErrors: unknown[] = [];
  for (const home of [...createdDshHomes]) {
    const homeErrors: unknown[] = [];
    const restoreAccess = (path: string): void => {
      let stat: Stats;
      try { stat = operations.lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") homeErrors.push(error);
        return;
      }
      if (stat.isSymbolicLink()) return;
      try { operations.chmodSync(path, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600)); }
      catch (error) { homeErrors.push(error); }
      if (!stat.isDirectory()) return;
      let entries: string[];
      try { entries = operations.readdirSync(path); }
      catch (error) { homeErrors.push(error); return; }
      for (const entry of entries) restoreAccess(join(path, entry));
    };
    restoreAccess(home);
    try { operations.rmSync(home, { recursive: true, force: true }); }
    catch (error) { homeErrors.push(error); }
    let exists = true;
    try { operations.lstatSync(home); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else homeErrors.push(error);
    }
    if (exists) homeErrors.push(new Error(`测试 DSH home 清理后仍存在：${home}`));
    else createdDshHomes.delete(home);
    cleanupErrors.push(...homeErrors);
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "测试 DSH home 清理失败");
}

afterEach(() => { cleanupCreatedDshHomes(); });

describe("Match 测试 DSH home 清理", () => {
  it("逐 home 收敛权限和删除，首个失败不阻断后续且保留跟踪供重试", () => {
    const first = createDshHome();
    const second = createDshHome();
    const external = mkdtempSync(join(tmpdir(), "maze-dsh-external-"));
    for (const home of [first, second]) {
      mkdirSync(join(home, "nested", "deep"), { recursive: true });
      writeFileSync(join(home, "nested", "deep", "locked"), "locked");
      chmodSync(join(home, "nested", "deep", "locked"), 0o000);
      chmodSync(join(home, "nested", "deep"), 0o000);
      chmodSync(join(home, "nested"), 0o000);
      chmodSync(home, 0o000);
    }
    writeFileSync(join(external, "outside"), "outside");
    chmodSync(external, 0o000);
    chmodSync(first, 0o700);
    symlinkSync(external, join(first, "external-link"), "dir");
    chmodSync(first, 0o000);
    let failedOnce = false;
    let caught: unknown;
    try {
      cleanupCreatedDshHomes({
        rmSync: (path, options) => {
          if (path === first && !failedOnce) {
            failedOnce = true;
            throw new Error("injected-first-home-remove-failure");
          }
          rmSync(path, options);
        },
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(String((caught as AggregateError).errors[0])).toContain("injected-first-home-remove-failure");
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
    expect(createdDshHomes.has(first)).toBe(true);
    expect(createdDshHomes.has(second)).toBe(false);
    expect(statSync(external).mode & 0o777).toBe(0o000);

    cleanupCreatedDshHomes();
    expect(createdDshHomes.has(first)).toBe(false);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(external)).toBe(true);
    chmodSync(external, 0o700);
    expect(readFileSync(join(external, "outside"), "utf8")).toBe("outside");
    rmSync(external, { recursive: true, force: true });
  });
});

function command(mode: string, role: MatchPluginRole = "solver") {
  return { executable: process.execPath, args: [peer, mode], environment: { PATH: process.env.PATH, MAZE_MATCH_ROLE: role } };
}
function cleanupCommand(mode: string, marker: string, cleanupMode?: string) {
  writeFileSync(marker, "running");
  return {
    ...command(mode),
    cleanup: {
      identity: `trusted-${mode}`,
      remove: { executable: process.execPath, args: [cleanupFixture, "remove", marker, cleanupMode ?? ""], timeoutMs: 1_000 },
      verifyAbsent: { executable: process.execPath, args: [cleanupFixture, "inspect", marker, cleanupMode ?? ""], timeoutMs: 1_000 },
    },
  };
}
function startRequest(role: MatchPluginRole = "solver"): MatchProtocolRequest {
  return {
    protocolVersion: 1, requestId: "request-1", sequence: 1, role,
    payload: role === "solver"
      ? { type: "solver.start", start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } }
      : { type: "generator.start", seed: "seed", rules: { size: 31, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } } },
  };
}
async function installProfiles(roleBundles = {
  generator: join(workspaceRoot, "packages/generator-plugin"),
  solver: join(workspaceRoot, "packages/solver-plugin"),
}, environment?: NodeJS.ProcessEnv) {
  const home = createDshHome();
  const installer = new HarnessMatchProfileInstaller({
    executable: fakeDsh, ...fakeHarnessRuntime,
    expectedVersion: "2026.09-preview.1", home,
    protocolBundle: packageRoot, roleBundles, environment,
  });
  await installer.prepare();
  return { home, installer };
}
function pluginWithRuntimeSource(source: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "maze-module-analysis-")), "solver-plugin");
  cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
  writeFileSync(join(root, "dist/index.js"), `${source}\n`);
  return root;
}
function candidateCopy(role: "generator" | "solver" = "generator"): { champion: string; candidate: string; trusted: string } {
  const trusted = join(workspaceRoot, `packages/${role}-plugin`);
  const root = mkdtempSync(join(tmpdir(), "maze-real-candidate-"));
  const champion = join(root, "champion");
  const candidate = join(root, "candidate");
  cpSync(trusted, champion, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
  cpSync(trusted, candidate, { recursive: true, filter: (path) => !path.split("/").includes("node_modules") });
  return { champion, candidate, trusted };
}
function versionedPluginCopy(role: "generator" | "solver", marker: string): { root: string; commit: string } {
  const root = join(mkdtempSync(join(tmpdir(), `maze-versioned-${role}-`)), `${role}-plugin`);
  cpSync(join(workspaceRoot, `packages/${role}-plugin`), root, {
    recursive: true, filter: (path) => !path.split("/").includes("node_modules"),
  });
  writeFileSync(join(root, ".version-marker"), marker);
  spawnSync("git", ["init", "--initial-branch=main"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Maze Test"], { cwd: root });
  spawnSync("git", ["config", "user.email", "test@localhost"], { cwd: root });
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-m", `fixture: ${marker}`], { cwd: root });
  return { root, commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() };
}
function fakeGit(mode: "archive-fail" | "malicious-tree"): string {
  const root = mkdtempSync(join(tmpdir(), "maze-fake-git-"));
  const executable = join(root, "git.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const command = args[2];
if (${JSON.stringify(mode)} === "archive-fail" && command === "archive") process.exit(23);
if (${JSON.stringify(mode)} === "malicious-tree" && command === "ls-tree") {
  process.stdout.write("100644 blob " + "a".repeat(40) + " 4\\t../escape\\0");
  process.exit(0);
}
const result = spawnSync("git", args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  chmodSync(executable, 0o755);
  return executable;
}
function dshCommand(home: string, role: MatchPluginRole, marker?: string) {
  return {
    executable: fakeDsh,
    args: ["--profile", `maze-match-${role}`],
    environment: { ...process.env, DSH_HOME: home, MAZE_MATCH_ROLE: role, DSH_UNLOAD_MARKER: marker },
  };
}
function statsResponse(response: ServerResponse, usageUsec: number): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ cpu_stats: { cpu_usage: { total_usage: usageUsec * 1_000 } } }));
}
function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function findHostProcess(marker: string): number | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`).toString("utf8").includes(marker)) return Number(entry);
    } catch { /* 进程可能在枚举期间退出。 */ }
  }
  return undefined;
}
async function listenStatsServer(handler: (call: number, response: ServerResponse) => void) {
  const socket = join(mkdtempSync(join(tmpdir(), "maze-docker-stats-")), "docker.sock");
  let calls = 0;
  const server = createServer((_request, response) => handler(++calls, response));
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socket, resolvePromise);
  });
  return { socket, server, calls: () => calls };
}

describe("Match Profile 进程协议", () => {
  it("权威候选测试通过摘要锁定的一次性 Docker 执行并确认清理", async () => {
    chmodSync(fakeCandidateDocker, 0o700);
    const marker = join(mkdtempSync(join(tmpdir(), "maze-candidate-docker-")), "calls.jsonl");
    await new DockerTrustedCandidateTestRunner(`sha256:${"a".repeat(64)}`, fakeCandidateDocker, {
      MAZE_FAKE_DOCKER_LOG: marker,
    }).run({ packageRoot, trustedToolRoot: join(workspaceRoot, "packages/generator-plugin") });
    const calls = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const args = calls[0]!;
    expect(calls.map((call) => call[0])).toEqual(["run", "rm", "inspect", "inspect"]);
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--name", expect.stringMatching(/^maze-candidate-test-[0-9a-f]{24}$/), "--network=none"]);
    for (const expected of ["--network=none", "--read-only", "--user=65532:65532", "--cap-drop=ALL", "--pids-limit=64"]) {
      expect(args).toContain(expected);
    }
    expect(args).toEqual(expect.arrayContaining([
      "--memory=128m", "--memory-swap=128m", "--cpus=1", "--ulimit=cpu=2:2",
      "--security-opt=no-new-privileges", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    ]));
    expect(args).toContain(`sha256:${"a".repeat(64)}`);
    const mounts = args.filter((arg) => arg.startsWith("--mount=type=bind,"));
    expect(mounts).toHaveLength(4);
    expect(mounts.every((mount) => mount.endsWith(",readonly"))).toBe(true);
    expect(mounts.some((mount) => mount.includes(`src=${workspaceRoot},`))).toBe(false);
    expect(args).toContain("--entrypoint=node");
    expect(args.at(-4)).toMatch(/node_modules\/vitest\/vitest\.mjs$/);
    expect(args.slice(-3)).toEqual(["run", "--root", packageRoot]);
  });

  it("Docker 候选测试保留有界诊断，且清理不可确认时关闭失败", async () => {
    chmodSync(fakeCandidateDocker, 0o700);
    const root = mkdtempSync(join(tmpdir(), "maze-candidate-docker-failure-"));
    const input = { packageRoot, trustedToolRoot: join(workspaceRoot, "packages/generator-plugin") };
    await expect(new DockerTrustedCandidateTestRunner(`sha256:${"b".repeat(64)}`, fakeCandidateDocker, {
      MAZE_FAKE_DOCKER_LOG: join(root, "test-failure.jsonl"), MAZE_FAKE_DOCKER_MODE: "test-failure",
    }).run(input)).rejects.toThrow(/候选测试失败.*candidate test sentinel failure/s);
    await expect(new DockerTrustedCandidateTestRunner(`sha256:${"c".repeat(64)}`, fakeCandidateDocker, {
      MAZE_FAKE_DOCKER_LOG: join(root, "cleanup-failure.jsonl"), MAZE_FAKE_DOCKER_MODE: "cleanup-failure",
    }).run(input)).rejects.toThrow(/隔离容器清理未确认/);
  });

  it.skipIf(!realDockerImageAvailable)("真实 Docker 以 UID 65532 读取只读构建根并执行 Vitest JavaScript 入口", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "maze-candidate-docker-uid-"));
    mkdirSync(join(isolatedRoot, "src"));
    symlinkSync(join(workspaceRoot, "packages/generator-plugin/node_modules"), join(isolatedRoot, "node_modules"), "dir");
    writeFileSync(join(isolatedRoot, "src/uid.test.ts"), `
      import { writeFileSync } from "node:fs";
      import { expect, test } from "vitest";
      test("容器身份和只读挂载", () => {
        expect(process.getuid?.()).toBe(65532);
        expect(() => writeFileSync(new URL("../forbidden", import.meta.url), "blocked")).toThrow();
      });
    `);
    chmodSync(join(isolatedRoot, "src/uid.test.ts"), 0o444);
    chmodSync(join(isolatedRoot, "src"), 0o555);
    chmodSync(isolatedRoot, 0o555);
    const realRunner = new DockerTrustedCandidateTestRunner(realDockerTestImage!, "docker", {}, process.execPath);
    await expect(realRunner.run({
      packageRoot: isolatedRoot,
      trustedToolRoot: join(workspaceRoot, "packages/generator-plugin"),
    })).resolves.toBeUndefined();

    const fixture = candidateCopy();
    const sourcePath = join(fixture.candidate, "src/index.ts");
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nexport const dockerUidCandidate = true;\n`);
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion,
      candidateRoot: fixture.candidate,
      trustedToolRoot: fixture.trusted,
      testRunner: realRunner,
    })).resolves.toMatchObject({ changedSourcePaths: ["src/index.ts"] });
  }, 30_000);
  it.each(["generator", "solver"] as const)("%s 候选可信重建丢弃模型产物，并固定评测内容身份", async (role) => {
    const fixture = candidateCopy(role);
    const sourcePath = join(fixture.candidate, "src/index.ts");
    const marker = `ticket07${role[0]!.toUpperCase()}${role.slice(1)}Candidate`;
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nexport const ${marker} = true;\n`);
    writeFileSync(join(fixture.candidate, "dist/index.js"), "throw new Error('untrusted');\n");
    const report = await rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner,
    });
    expect(report.changedSourcePaths).toEqual(["src/index.ts"]);
    expect(report.runtime.files).toBeGreaterThan(0);
    expect(readFileSync(join(fixture.candidate, "dist/index.js"), "utf8")).toContain(marker);
    expect(readFileSync(join(fixture.candidate, "dist/index.js"), "utf8")).not.toContain("untrusted");
    await expect(verifyTrustedPluginCandidate(fixture.candidate, report.contentSha256)).resolves.toBeUndefined();
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nexport const lateMutation = true;\n`);
    await expect(verifyTrustedPluginCandidate(fixture.candidate, report.contentSha256)).rejects.toThrow(/偏离可信重建内容身份/);
  }, 30_000);

  it.each([
    ["完全无变化", (root: string) => root, /没有可安装运行源码变化/],
    ["只改测试", (root: string) => writeFileSync(join(root, "src/index.test.ts"), `${readFileSync(join(root, "src/index.test.ts"), "utf8")}\n// test only\n`), /没有可安装运行源码变化/],
    ["只追加策略", (root: string) => { mkdirSync(join(root, "lineage")); writeFileSync(join(root, "lineage/plan.md"), "plan\n"); }, /没有可安装运行源码变化/],
    ["只改 dist", (root: string) => writeFileSync(join(root, "dist/index.js"), "export const fake = true;\n"), /没有可安装运行源码变化/],
    ["只写缓存", (root: string) => { mkdirSync(join(root, ".cache")); writeFileSync(join(root, ".cache/result"), "cached\n"); }, /冻结保护边界/],
    ["只写临时文件", (root: string) => writeFileSync(join(root, "candidate.tmp"), "temporary\n"), /冻结保护边界/],
    ["依赖漂移", (root: string) => { const path = join(root, "package.json"); const value = JSON.parse(readFileSync(path, "utf8")); value.dependencies.evil = "1.0.0"; writeFileSync(path, JSON.stringify(value)); }, /package.json/],
    ["保护文件变化", (root: string) => writeFileSync(join(root, "cordis.patch.yml"), "[]\n"), /保护边界/],
  ])("拒绝无效候选：%s", async (_label, mutate, expected) => {
    const fixture = candidateCopy();
    mutate(fixture.candidate);
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner,
    })).rejects.toThrow(expected);
  });

  it("拒绝构建失败和源码配额超限，且不采用旧 dist", async () => {
    const broken = candidateCopy();
    writeFileSync(join(broken.candidate, "src/index.ts"), "export const broken: = true;\n");
    await expect(rebuildTrustedPluginCandidate({
      championRoot: broken.champion, candidateRoot: broken.candidate, trustedToolRoot: broken.trusted,
      testRunner: stubCandidateTestRunner,
    })).rejects.toThrow(/类型检查失败/);

    const oversized = candidateCopy();
    writeFileSync(join(oversized.candidate, "src/oversized.ts"), `export const payload = "${"x".repeat(300 * 1024)}";\n`);
    await expect(rebuildTrustedPluginCandidate({
      championRoot: oversized.champion, candidateRoot: oversized.candidate, trustedToolRoot: oversized.trusted,
      testRunner: stubCandidateTestRunner,
    })).rejects.toThrow(/候选源码超过冻结配额/);
  }, 30_000);

  it("始终使用冻结工具根中的权威测试，拒绝冠军弱化测试后的候选", async () => {
    const fixture = candidateCopy();
    writeFileSync(join(fixture.champion, "src/index.test.ts"), "import { test } from 'vitest'; test('weak', () => {});\n");
    writeFileSync(join(fixture.candidate, "src/index.test.ts"), "import { test } from 'vitest'; test('weak', () => {});\n");
    writeFileSync(join(fixture.candidate, "src/index.ts"), "export const invalidCandidate = true;\n");
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner,
    })).rejects.toThrow(/候选测试失败/);
  }, 30_000);

  it("运行源码变化可伴随一份新增策略记录及配额内文档和测试", async () => {
    const fixture = candidateCopy();
    const sourcePath = join(fixture.candidate, "src/index.ts");
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nexport const accompaniedCandidate = true;\n`);
    writeFileSync(join(fixture.candidate, "src/index.test.ts"), `${readFileSync(join(fixture.candidate, "src/index.test.ts"), "utf8")}\n// candidate test note\n`);
    mkdirSync(join(fixture.candidate, "docs"));
    writeFileSync(join(fixture.candidate, "docs/approach.md"), "候选设计说明\n");
    mkdirSync(join(fixture.candidate, "lineage"));
    writeFileSync(join(fixture.candidate, "lineage/attempt-1.md"), "候选策略");
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner, strategyRecord: { attemptId: "attempt-1", strategyPlan: "候选策略" },
    })).resolves.toMatchObject({ changedSourcePaths: ["src/index.ts"] });
  }, 30_000);

  it.each([
    ["非标准路径", (root: string) => writeFileSync(join(root, "lineage/other.md"), "候选策略")],
    ["两份记录", (root: string) => {
      writeFileSync(join(root, "lineage/attempt-1.md"), "候选策略");
      writeFileSync(join(root, "lineage/other.md"), "候选策略");
    }],
    ["响应不一致", (root: string) => writeFileSync(join(root, "lineage/attempt-1.md"), "另一策略")],
  ])("运行源码变化仍拒绝%s的新增 lineage", async (_label, writeLineage) => {
    const fixture = candidateCopy();
    writeFileSync(join(fixture.candidate, "src/index.ts"), `${readFileSync(join(fixture.candidate, "src/index.ts"), "utf8")}\nexport const invalidLineageCandidate = true;\n`);
    mkdirSync(join(fixture.candidate, "lineage"));
    writeLineage(fixture.candidate);
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner, strategyRecord: { attemptId: "attempt-1", strategyPlan: "候选策略" },
    })).rejects.toThrow(/非标准策略记录|策略记录与 Harness 响应不一致/);
  });

  it("运行源码变化仍拒绝修改既有 lineage", async () => {
    const fixture = candidateCopy();
    for (const root of [fixture.champion, fixture.candidate]) {
      mkdirSync(join(root, "lineage"));
      writeFileSync(join(root, "lineage/existing.md"), "既有策略");
    }
    writeFileSync(join(fixture.candidate, "src/index.ts"), `${readFileSync(join(fixture.candidate, "src/index.ts"), "utf8")}\nexport const changedExistingLineage = true;\n`);
    writeFileSync(join(fixture.candidate, "lineage/existing.md"), "篡改策略");
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner, strategyRecord: { attemptId: "attempt-1", strategyPlan: "候选策略" },
    })).rejects.toThrow(/修改或删除了既有策略记录/);
  });

  it("完整安装载荷变化会使可信候选内容身份失效", async () => {
    const fixture = candidateCopy();
    const sourcePath = join(fixture.candidate, "src/index.ts");
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\nexport const installIdentityCandidate = true;\n`);
    const report = await rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner,
    });
    writeFileSync(join(fixture.candidate, "dist/unreferenced.js"), "export const hiddenMutation = true;\n");
    await expect(verifyTrustedPluginCandidate(fixture.candidate, report.contentSha256)).rejects.toThrow(/偏离可信重建内容身份/);
  }, 30_000);

  it("整文件读取前通过 lstat 预检拒绝稀疏超大文件", async () => {
    const fixture = candidateCopy();
    const sourcePath = join(fixture.candidate, "src/index.ts");
    truncateSync(sourcePath, 64 * 1024 * 1024);
    await expect(rebuildTrustedPluginCandidate({
      championRoot: fixture.champion, candidateRoot: fixture.candidate, trustedToolRoot: fixture.trusted,
      testRunner: stubCandidateTestRunner,
    })).rejects.toThrow(/配额/);
  });

  it("启动 ready 握手独立于单次响应预算", async () => {
    const client = new MatchProfileProcess(command("slow-ready"), "solver", 100, 500);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    await client.close();
  });

  it("启动 ready 握手有独立有界超时", async () => {
    const client = new MatchProfileProcess(command("never-ready"), "solver", 100, 50);
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "TIMEOUT" });
    await client.close();
  });

  it("CPU 初始化期间的第二个 ready 帧关闭失败且只初始化一次", async () => {
    const stats = await listenStatsServer((_call, response) => {
      setTimeout(() => statsResponse(response, 0), 50);
    });
    try {
      const client = new MatchProfileProcess({
        ...command("double-ready-initializing"),
        cpuMonitor: { dockerSocketPath: stats.socket, containerIdentity: "controlled", sampleIntervalMs: 1_000 },
      }, "solver", 100);
      await expect(client.request(startRequest())).rejects.toMatchObject({ code: "OUTPUT_OUT_OF_ORDER" });
      expect(stats.calls()).toBe(1);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => stats.server.close(() => resolvePromise()));
    }
  });

  it.each([
    ["stdout 污染", "pollution", ["PROTOCOL_INVALID", "OUTPUT_MULTIPLE"]],
    ["额外输出", "multiple", ["OUTPUT_MULTIPLE"]],
    ["跨 chunk 延迟追加输出", "delayed-extra", ["PROTOCOL_INVALID", "OUTPUT_MULTIPLE", "OUTPUT_OUT_OF_ORDER"]],
    ["超限输出", "oversize", ["OUTPUT_LIMIT"]],
    ["错误关联", "wrong-id", ["OUTPUT_OUT_OF_ORDER"]],
    ["未来协议版本", "future-version", ["OUTPUT_OUT_OF_ORDER"]],
    ["非法领域动作", "illegal-domain", ["PROTOCOL_INVALID"]],
    ["超时", "timeout", ["TIMEOUT"]],
    ["非零退出", "exit", ["NON_ZERO_EXIT"]],
    ["OOM", "oom", ["OOM"]],
  ])("%s 时关闭失败", async (_label, mode, expected) => {
    const client = new MatchProfileProcess(command(mode), "solver", 250);
    await expect(client.request(startRequest())).rejects.toSatisfy((error: MatchProfileError) => expected.includes(error.code));
    await client.close();
  });

  it("生成器 complete 后跨 chunk 污染仍关闭失败", async () => {
    const client = new MatchProfileProcess(command("delayed-extra", "generator"), "generator", 250);
    await expect(client.request(startRequest("generator"))).rejects.toBeInstanceOf(MatchProfileError);
    await client.close();
  });

  it("插件重复注册在黑盒 Harness 主机中拒绝加载", async () => {
    const { home } = await installProfiles({
      generator: join(workspaceRoot, "packages/generator-plugin"),
      solver: join(packageRoot, "test/fixtures/duplicate-package"),
    });
    const client = new MatchProfileProcess(dshCommand(home, "solver"), "solver", 500);
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "NON_ZERO_EXIT" });
    await client.close();
  });

  it("插件入口缺失时报告加载失败且不产生权威比赛事实", async () => {
    const client = new MatchProfileProcess({
      executable: "/definitely-missing/maze-match-profile",
      args: [],
    }, "solver", 500);
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "PLUGIN_LOAD_FAILED" });
    await client.close();
  });

  it("候选修改进程全局状态不会影响 Arena 权威进程", async () => {
    const { home } = await installProfiles({
      generator: join(workspaceRoot, "packages/generator-plugin"),
      solver: join(packageRoot, "test/fixtures/global-package"),
    });
    const client = new MatchProfileProcess(dshCommand(home, "solver"), "solver", 500);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    await client.finalize();
    expect((globalThis as Record<string, unknown>).__candidatePollution).toBeUndefined();
    await client.close();
  });

  it.each(["timeout", "pollution"])("%s 故障会显式清理并确认容器身份消失", async (mode) => {
    const marker = join(mkdtempSync(join(tmpdir(), "maze-cleanup-")), "container");
    const client = new MatchProfileProcess(cleanupCommand(mode, marker), "solver", 100);
    await expect(client.request(startRequest())).rejects.toBeInstanceOf(MatchProfileError);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.removed`)).toBe(true);
  });

  it("等待清理命令的 stderr 管道关闭后再判定容器已不存在", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "maze-cleanup-late-output-")), "container");
    const client = new MatchProfileProcess(cleanupCommand("hold-open", marker, "late-no-such"), "solver", 100);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    await expect(client.close()).resolves.toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.removed`)).toBe(true);
  });

  it("close 与 spawn 异常路径也执行可信清理", async () => {
    for (const executable of [process.execPath, "/definitely-missing/maze-match-profile"]) {
      const marker = join(mkdtempSync(join(tmpdir(), "maze-close-cleanup-")), "container");
      const commandWithCleanup = cleanupCommand("hold-open", marker);
      commandWithCleanup.executable = executable;
      const client = new MatchProfileProcess(commandWithCleanup, "solver", 100);
      if (executable === process.execPath) await client.close();
      else await expect(client.request(startRequest())).rejects.toBeInstanceOf(MatchProfileError);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.removed`)).toBe(true);
    }
  });

  it("清理权限错误不会被误判为容器已不存在", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "maze-cleanup-permission-")), "container");
    const client = new MatchProfileProcess(cleanupCommand("timeout", marker, "permission"), "solver", 50);
    await expect(client.request(startRequest())).rejects.toSatisfy((error: AggregateError) =>
      error instanceof AggregateError && error.errors.some((nested) => String(nested).includes("退出码 2"))
        && !String(error).includes("permission denied"));
  });

  it("create 与首次 rm 竞态时会再次强制清理并稳定确认消失", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "maze-cleanup-race-")), "container");
    const client = new MatchProfileProcess(cleanupCommand("timeout", marker, "race"), "solver", 50);
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.attempted`)).toBe(true);
  });

  it("Docker --rm 已开始自动删除时继续确认容器稳定消失", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "maze-cleanup-removing-")), "container");
    const client = new MatchProfileProcess(cleanupCommand("timeout", marker, "removing"), "solver", 50);
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(`${marker}.attempted`)).toBe(true);
  });

  it("可信宿主按 cgroup 汇总值监管全部子进程累计 CPU", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-cgroup-cpu-"));
    const procRoot = join(root, "proc");
    const cgroupRoot = join(root, "cgroup");
    mkdirSync(join(procRoot, "4242"), { recursive: true });
    mkdirSync(join(cgroupRoot, "maze-match"), { recursive: true });
    writeFileSync(join(procRoot, "4242/cgroup"), "0::/maze-match\n");
    const cpuStat = join(cgroupRoot, "maze-match/cpu.stat");
    writeFileSync(cpuStat, "usage_usec 100\nuser_usec 60\nsystem_usec 40\n");
    const client = new MatchProfileProcess({
      ...command("hold-open"),
      cpuMonitor: {
        resolvePid: { executable: process.execPath, args: [cleanupFixture, "pid", "4242"] },
        procRoot, cgroupRoot, sampleIntervalMs: 5, limitUsec: 200,
      },
    }, "solver", 100);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    writeFileSync(cpuStat, "usage_usec 201\nuser_usec 120\nsystem_usec 81\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "TIMEOUT" });
    await client.close();
  });

  it("ready 前已消耗的整容器 CPU 直接计入生命周期上限", async () => {
    const stats = await listenStatsServer((_call, response) => statsResponse(response, 3_000_000));
    try {
      const client = new MatchProfileProcess({
        ...command("hold-open"),
        cpuMonitor: { dockerSocketPath: stats.socket, containerIdentity: "controlled", sampleIntervalMs: 1_000 },
      }, "solver", 100);
      await expect(client.request(startRequest())).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(stats.calls()).toBe(1);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => stats.server.close(() => resolvePromise()));
    }
  });

  it("cgroup CPU 监管读取异常时关闭失败", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-cgroup-error-"));
    const procRoot = join(root, "proc");
    const cgroupRoot = join(root, "cgroup");
    mkdirSync(join(procRoot, "4242"), { recursive: true });
    mkdirSync(join(cgroupRoot, "maze-match"), { recursive: true });
    writeFileSync(join(procRoot, "4242/cgroup"), "0::/maze-match\n");
    const cpuStat = join(cgroupRoot, "maze-match/cpu.stat");
    writeFileSync(cpuStat, "usage_usec 100\n");
    const client = new MatchProfileProcess({
      ...command("hold-open"),
      cpuMonitor: {
        resolvePid: { executable: process.execPath, args: [cleanupFixture, "pid", "4242"] },
        procRoot, cgroupRoot, sampleIntervalMs: 5,
      },
    }, "solver", 100);
    await expect(client.request(startRequest())).resolves.toBeDefined();
    writeFileSync(cpuStat, "usage_usec invalid\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(client.request(startRequest())).rejects.toMatchObject({ code: "NON_ZERO_EXIT" });
    await client.close();
  });

  it("finalize 等待在途 CPU 采样并拒绝采样中发现的超限", async () => {
    let release!: () => void;
    let samplingStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { samplingStarted = resolvePromise; });
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const stats = await listenStatsServer((call, response) => {
      if (call === 1) return statsResponse(response, 0);
      samplingStarted();
      void gate.then(() => statsResponse(response, 250));
    });
    try {
      const client = new MatchProfileProcess({
        ...command("hold-open"),
        cpuMonitor: { dockerSocketPath: stats.socket, containerIdentity: "controlled", sampleIntervalMs: 5, limitUsec: 200 },
      }, "solver", 100);
      await expect(client.request(startRequest())).resolves.toBeDefined();
      await started;
      let settled = false;
      const finalizing = client.finalize().finally(() => { settled = true; });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(settled).toBe(false);
      release();
      await expect(finalizing).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => stats.server.close(() => resolvePromise()));
    }
  });

  it("finalize 不会用成功终态读数覆盖在途 CPU 采样错误", async () => {
    let release!: () => void;
    let samplingStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { samplingStarted = resolvePromise; });
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const stats = await listenStatsServer((call, response) => {
      if (call === 1) return statsResponse(response, 0);
      if (call === 2) {
        samplingStarted();
        return void gate.then(() => response.writeHead(500).end("daemon failure"));
      }
      statsResponse(response, 100);
    });
    const marker = join(mkdtempSync(join(tmpdir(), "maze-inflight-stats-cleanup-")), "container");
    try {
      const client = new MatchProfileProcess({
        ...cleanupCommand("hold-open", marker),
        cpuMonitor: { dockerSocketPath: stats.socket, containerIdentity: "controlled", sampleIntervalMs: 5 },
      }, "solver", 100);
      await expect(client.request(startRequest())).resolves.toBeDefined();
      await started;
      let settled = false;
      const finalizing = client.finalize().finally(() => { settled = true; });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(settled).toBe(false);
      release();
      await expect(finalizing).rejects.toMatchObject({ code: "NON_ZERO_EXIT" });
      expect(stats.calls()).toBeGreaterThanOrEqual(3);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.removed`)).toBe(true);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => stats.server.close(() => resolvePromise()));
    }
  });

  it("finalize 的可信终态 stats 错误先清理再传播", async () => {
    const stats = await listenStatsServer((call, response) => {
      if (call === 1) return statsResponse(response, 0);
      response.writeHead(500).end("daemon failure");
    });
    const marker = join(mkdtempSync(join(tmpdir(), "maze-final-stats-cleanup-")), "container");
    try {
      const client = new MatchProfileProcess({
        ...cleanupCommand("hold-open", marker),
        cpuMonitor: { dockerSocketPath: stats.socket, containerIdentity: "controlled", sampleIntervalMs: 1_000 },
      }, "solver", 100);
      await expect(client.request(startRequest())).resolves.toBeDefined();
      await expect(client.finalize()).rejects.toMatchObject({ code: "NON_ZERO_EXIT" });
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.removed`)).toBe(true);
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolvePromise) => stats.server.close(() => resolvePromise()));
    }
  });
});

describe("原生插件与正式隔离策略", () => {
  it("两个 dsh.bundle 仅挂载一个角色入口且分别通过冻结配额", async () => {
    for (const name of ["generator-plugin", "solver-plugin"] as const) {
      const root = join(workspaceRoot, "packages", name);
      const report = await validatePluginPackage(root);
      expect(report.runtime.files).toBeGreaterThan(0);
      expect(report.runtime.bytes).toBeLessThanOrEqual(256 * 1024);
      expect(report.auxiliary.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(report.buildBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });

  it("真实 dsh CLI 语义安装并启动冻结 Profile，apply 单能力且卸载无残留", async () => {
    const { home, installer } = await installProfiles();
    for (const role of ["generator", "solver"] as const) {
      const manifest = JSON.parse(readFileSync(join(home, "profiles", `maze-match-${role}`, "package.json"), "utf8"));
      expect(manifest.dsh.profile.bundles).toEqual([
        "@maze-arena/match-profile", `@maze-arena/${role}-plugin`,
      ]);
      expect(manifest.dsh.profile.patchReload).toBe("startup");
      for (const name of manifest.dsh.profile.bundles) {
        const installed = join(home, "profiles", `maze-match-${role}`, "node_modules", ...name.split("/"));
        expect(realpathSync(installed).startsWith(join(home, "profiles", `maze-match-${role}`, "node_modules/.pnpm"))).toBe(true);
        const artifactManifest = readFileSync(join(installed, "package.json"), "utf8");
        expect(artifactManifest).not.toContain("workspace:");
        expect(JSON.parse(artifactManifest).dependencies).toEqual({});
      }
    }
    const marker = join(home, "solver-unloaded.json");
    const client = new MatchProfileProcess(dshCommand(home, "solver", marker), "solver", 500);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    await client.finalize();
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["provide"]);
    await installer.uninstall();
    for (const role of ["generator", "solver"] as const) {
      const manifest = JSON.parse(readFileSync(join(home, "profiles", `maze-match-${role}`, "package.json"), "utf8"));
      expect(manifest.dsh.profile.bundles).toEqual([]);
      expect(manifest.dependencies).toEqual({});
    }
  });

  it("接受官方 dsh 将 dependencies 与 bundles 反序写回", async () => {
    const { home } = await installProfiles(undefined, { DSH_PROFILE_MANIFEST_MODE: "reverse" });
    const manifest = JSON.parse(readFileSync(join(home, "profiles/maze-match-generator/package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toEqual([
      "@maze-arena/generator-plugin", "@maze-arena/match-profile",
    ]);
    expect(manifest.dsh.profile.bundles).toEqual([
      "@maze-arena/generator-plugin", "@maze-arena/match-profile",
    ]);
  });

  it.each([
    ["dependency-extra", "dependencies"],
    ["dependency-missing", "dependencies"],
    ["bundle-extra", "bundles"],
    ["bundle-missing", "bundles"],
    ["bundle-duplicate", "bundles"],
  ] as const)("拒绝 Profile 精确成员集合漂移：%s", async (mode, field) => {
    await expect(installProfiles(undefined, { DSH_PROFILE_MANIFEST_MODE: mode }))
      .rejects.toThrow(new RegExp(`${field} 必须且只能包含`));
  });

  it.each(["patch-reload-live", "patch-reload-missing"])("拒绝 Profile patchReload 漂移：%s", async (mode) => {
    await expect(installProfiles(undefined, { DSH_PROFILE_MANIFEST_MODE: mode }))
      .rejects.toThrow(/固定 patchReload=startup/);
  });

  it.each([
    ["package-source-mismatch", /package\.json dependencies 来源与已验证产物不一致/],
    ["lock-source-mismatch", /pnpm-lock\.yaml importer 来源错配/],
    ["installed-content-tamper", /安装载荷与已验证内容寻址产物不一致/],
    ["virtual-store-escape", /越出当前 Profile 的 pnpm virtual store/],
  ] as const)("拒绝 pnpm isolated 安装信任链漂移：%s", async (mode, expected) => {
    await expect(installProfiles(undefined, { DSH_PROFILE_MANIFEST_MODE: mode })).rejects.toThrow(expected);
  });

  it("重复准备正式 Profile 会安全替换上一轮只读快照", async () => {
    const { home, installer } = await installProfiles();
    const before = readFileSync(join(home, "snapshots/solver.sha256"), "utf8");
    await expect(installer.prepare()).resolves.toBeUndefined();
    expect(readFileSync(join(home, "snapshots/solver.sha256"), "utf8")).toBe(before);
    expect(statSync(join(home, "snapshots/solver")).mode & 0o222).toBe(0);
  });

  it("Profile 安装与清理只写 profile home，阻断外部写、Unix socket 和后台进程", async () => {
    const home = mkdtempSync(join(tmpdir(), "maze-profile-isolation-home-"));
    const externalMarker = join(mkdtempSync(join(tmpdir(), "maze-profile-external-")), "escaped");
    const daemonMarker = join(mkdtempSync(join(tmpdir(), "maze-profile-daemon-")), "escaped");
    const socketRoot = mkdtempSync(join(tmpdir(), "maze-profile-socket-"));
    const socketPath = join(socketRoot, "host.sock");
    const socketMarker = join(socketRoot, "connected");
    const daemonIdentity = `maze-profile-daemon-${home}`;
    const runtimeMarker = join(fakeHarnessRuntime.runtimeRoot, "runtime-write-must-fail");
    const listener = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const net = require("node:net");
      const server = net.createServer(() => fs.writeFileSync(${JSON.stringify(socketMarker)}, "connected"));
      server.listen(${JSON.stringify(socketPath)});
      setInterval(() => {}, 1_000);
    `], { stdio: "ignore" });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt += 1) wait(10);
      expect(existsSync(socketPath)).toBe(true);
      const installer = new HarnessMatchProfileInstaller({
        executable: fakeDsh,
        ...fakeHarnessRuntime,
        expectedVersion: "2026.09-preview.1",
        home,
        protocolBundle: packageRoot,
        roleBundles: {
          generator: join(workspaceRoot, "packages/generator-plugin"),
          solver: join(workspaceRoot, "packages/solver-plugin"),
        },
        environment: {
          DSH_ATTACK_EXTERNAL_PATH: externalMarker,
          DSH_ATTACK_RUNTIME_PATH: runtimeMarker,
          DSH_ATTACK_SOCKET_PATH: socketPath,
          DSH_ATTACK_DAEMON_MARKER: daemonMarker,
          DSH_ATTACK_DAEMON_IDENTITY: daemonIdentity,
        },
      });

      await expect(installer.prepare()).resolves.toBeUndefined();
      await expect(installer.uninstall()).resolves.toBeUndefined();
      wait(700);
      expect(existsSync(externalMarker)).toBe(false);
      expect(existsSync(runtimeMarker)).toBe(false);
      expect(existsSync(socketMarker)).toBe(false);
      expect(existsSync(daemonMarker)).toBe(false);
      expect(findHostProcess(daemonIdentity)).toBeUndefined();
    } finally {
      if (listener.exitCode === null && listener.signalCode === null) {
        const closed = new Promise<void>((resolveClosed) => listener.once("close", () => resolveClosed()));
        listener.kill("SIGKILL");
        await closed;
      }
    }
  }, 30_000);

  it("Profile 每次调用前重新验证冻结 runtime 载荷", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-profile-runtime-drift-"));
    const runtimeRoot = join(root, "runtime");
    cpSync(fakeHarnessRuntime.runtimeRoot, runtimeRoot, { recursive: true });
    const dependency = join(runtimeRoot, "runtime-dependency.txt");
    writeFileSync(dependency, "A\n");
    const installer = new HarnessMatchProfileInstaller({
      executable: join(runtimeRoot, "dsh.mjs"),
      runtimeRoot,
      runtimePayloadSha256: hashHarnessRuntimePayload(runtimeRoot),
      expectedVersion: "2026.09-preview.1",
      home: join(root, "home"),
      protocolBundle: packageRoot,
      roleBundles: {
        generator: join(workspaceRoot, "packages/generator-plugin"),
        solver: join(workspaceRoot, "packages/solver-plugin"),
      },
    });
    mkdirSync(join(root, "home"));
    await installer.prepare();
    writeFileSync(dependency, "B\n");

    await expect(installer.uninstall()).rejects.toThrow(/冻结载荷身份已漂移/);
    const manifest = JSON.parse(readFileSync(join(root, "home/profiles/maze-match-generator/package.json"), "utf8"));
    expect(Object.keys(manifest.dependencies)).toHaveLength(2);
  }, 30_000);

  it("结构化 pack 清单不执行生命周期并对可信 lineage 基线关闭失败", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "lineage"));
    writeFileSync(join(root, "docs/notes.md"), "辅助文档");
    writeFileSync(join(root, "lineage/0001.md"), "既有策略");
    const baseline = {
      "lineage/0001.md": createHash("sha256").update(readFileSync(join(root, "lineage/0001.md"))).digest("hex"),
    };
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scripts = { prepack: "node -e \"require('fs').writeFileSync('PWNED','x')\"" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await validatePluginPackage(root, baseline)).lineageEntries).toHaveLength(1);
    expect(existsSync(join(root, "PWNED"))).toBe(false);
    writeFileSync(join(root, "lineage/0001.md"), "篡改策略");
    await expect(validatePluginPackage(root, baseline)).rejects.toThrow(/修改或删除/);
    unlinkSync(join(root, "lineage/0001.md"));
    await expect(validatePluginPackage(root, baseline)).rejects.toThrow(/修改或删除/);
    writeFileSync(join(root, "lineage/0001.md"), "x".repeat(64 * 1024 + 1));
    await expect(validatePluginPackage(root, {})).rejects.toThrow(/超过冻结配额/);
    writeFileSync(join(root, "lineage/0001.md"), "既有策略");
    writeFileSync(join(root, "lineage/0002.md"), "新增一");
    writeFileSync(join(root, "lineage/0003.md"), "新增二");
    await expect(validatePluginPackage(root, baseline)).rejects.toThrow(/最多新增一份/);
    expect(existsSync(join(root, "dist/index.test.js"))).toBe(false);
  });

  it("生产 Docker 命令锁定摘要并应用无网络、只读、非 root 和资源边界", async () => {
    const { home: root } = await installProfiles();
    const factory = new DockerMatchProfileCommandFactory("maze-match@sha256:" + "a".repeat(64), root);
    const first = factory.create("solver");
    const second = factory.create("solver");
    expect(first).toMatchObject({
      executable: "docker",
      args: expect.arrayContaining([
        "run", "--interactive", "--rm", "--name", expect.stringMatching(/^maze-match-solver-[a-f0-9]{24}$/), "--network=none", "--read-only", "--user=65532:65532", "--memory=128m",
        "--memory-swap=128m", "--ulimit=cpu=2:2", "--security-opt=no-new-privileges", "--cap-drop=ALL",
        "--tmpfs=/arena:rw,noexec,nosuid,size=32m,mode=0700,uid=65532,gid=65532",
        expect.stringContaining("src=" + join(root, "snapshots", "solver") + ",dst=/arena-source,readonly"),
        "--env=MAZE_MATCH_PROFILE_SOURCE=/arena-source",
        "node", "/opt/maze-arena/packages/match-profile/dist/container-launcher.js",
        "dsh", "--profile", "maze-match-solver",
      ]),
      cleanup: {
        identity: expect.stringMatching(/^maze-match-solver-[a-f0-9]{24}$/),
        remove: { executable: "docker", args: ["rm", "-f", expect.stringMatching(/^maze-match-solver-/)] },
        verifyAbsent: { executable: "docker", args: ["inspect", expect.stringMatching(/^maze-match-solver-/)] },
      },
    });
    expect(first.cleanup?.identity).not.toBe(second.cleanup?.identity);

    const frozenRoot = join(root, "snapshots", "solver");
    const pending = [frozenRoot];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const mode = statSync(current).mode & 0o777;
      expect(mode & 0o222).toBe(0);
      if (statSync(current).isDirectory()) pending.push(...readdirSync(current).map((entry) => join(current, entry)));
    }

    const mutableProfile = join(root, "profiles/maze-match-solver/package.json");
    writeFileSync(mutableProfile, `${readFileSync(mutableProfile, "utf8")} `);
    expect(() => factory.create("solver")).not.toThrow();
    const frozenProfile = join(root, "snapshots/solver/profiles/maze-match-solver/package.json");
    chmodSync(frozenProfile, 0o644);
    writeFileSync(frozenProfile, `${readFileSync(frozenProfile, "utf8")} `);
    expect(() => factory.create("solver")).toThrow(/摘要不匹配/);
  });

  it.each([
    "latest",
    "maze-match:latest",
    "maze-match:1.2.3",
    "maze-match@sha256:abcd",
    `maze-match:latest@sha256:${"A".repeat(64)}`,
    `maze-match:latest@sha256:${"a".repeat(64)}`,
    `maze-match:1.2.3@sha256:${"a".repeat(64)}`,
  ])("生产 Docker 命令拒绝浮动或不完整镜像引用 %s", (image) => {
    expect(() => new DockerMatchProfileCommandFactory(image, "/tmp/match-profile"))
      .toThrow(/完整 sha256 摘要/);
  });

  it("生产 Docker 命令允许 registry 端口和无 tag 名称的完整摘要", () => {
    const image = `localhost:5000/maze/match-profile@sha256:${"a".repeat(64)}`;
    expect(() => new DockerMatchProfileCommandFactory(image, "/tmp/match-profile")).not.toThrow();
  });

  it("候选与冠军从受验证版本树进入独立一次性容器并共享冻结输入身份", async () => {
    const { home } = await installProfiles();
    const log = join(mkdtempSync(join(tmpdir(), "maze-paired-docker-")), "calls.jsonl");
    const image = `maze-match@sha256:${"a".repeat(64)}`;
    const runner = new DockerPairedEvaluationRunner(image, home, fakePairedDocker, {
      MAZE_FAKE_DOCKER_LOG: log,
      MAZE_FAKE_DSH: fakeDsh,
    }, false);
    const candidate = versionedPluginCopy("generator", "candidate");
    const champion = versionedPluginCopy("generator", "champion");
    const opponent = versionedPluginCopy("solver", "opponent");
    const evaluation = await runner.evaluate({
      role: "generator",
      protocolVersion: 1,
      candidate,
      champion,
      opponent,
      cases: [{ id: "public-01", seed: "same-seed", visibility: "public" }],
      context: { opponentVersion: opponent.commit, imageDigest: image, resourcePolicyDigest: MATCH_PROFILE_POLICY_DIGEST },
    });
    expect(evaluation).toMatchObject({
      candidateVersion: candidate.commit, championVersion: champion.commit,
      context: { opponentVersion: opponent.commit, imageDigest: image, resourcePolicyDigest: MATCH_PROFILE_POLICY_DIGEST },
      publicPrimaryRegressed: false, promote: false,
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const runs = calls.filter(([command]) => command === "run");
    expect(runs).toHaveLength(8);
    const names = runs.map((args) => args[args.indexOf("--name") + 1]);
    expect(new Set(names).size).toBe(runs.length);
    for (const args of runs) {
      expect(args).toEqual(expect.arrayContaining([
        "--network=none", "--read-only", "--user=65532:65532", "--memory=128m", "--memory-swap=128m",
        "--cpus=1", "--ulimit=cpu=2:2", "--pids-limit=64", "--security-opt=no-new-privileges", "--cap-drop=ALL", image,
      ]));
    }
  }, 30_000);

  it("配对评测只读取提交对象，拒绝目录与提交错配且忽略同尺寸同 mtime 工作树漂移", async () => {
    const { home } = await installProfiles();
    const image = `maze-match@sha256:${"a".repeat(64)}`;
    const log = join(mkdtempSync(join(tmpdir(), "maze-binding-docker-")), "calls.jsonl");
    const runner = new DockerPairedEvaluationRunner(image, home, fakePairedDocker, {
      MAZE_FAKE_DSH: fakeDsh, MAZE_FAKE_DOCKER_LOG: log,
    }, false);
    const candidate = versionedPluginCopy("generator", "candidate-binding");
    const champion = versionedPluginCopy("generator", "champion-binding");
    const opponent = versionedPluginCopy("solver", "opponent-binding");
    const base = {
      role: "generator" as const, protocolVersion: 1 as const, candidate, champion, opponent,
      cases: [{ id: "public-01", seed: "same-seed", visibility: "public" as const }],
      context: { opponentVersion: opponent.commit, imageDigest: image, resourcePolicyDigest: MATCH_PROFILE_POLICY_DIGEST },
    };
    await expect(runner.evaluate({ ...base, candidate: { ...candidate, commit: champion.commit } }))
      .rejects.toThrow(/Git 对象|指定 Git 对象库/);
    await expect(runner.evaluate({ ...base, champion: { commit: champion.commit, root: candidate.root } }))
      .rejects.toThrow(/Git 对象|指定 Git 对象库/);
    const payload = join(candidate.root, "dist/index.js");
    const original = readFileSync(payload);
    const timestamps = statSync(payload);
    spawnSync("git", ["config", "core.trustctime", "false"], { cwd: candidate.root });
    writeFileSync(payload, Buffer.alloc(original.length, "E"));
    utimesSync(payload, timestamps.atime, timestamps.mtime);
    await expect(runner.evaluate(base)).resolves.toMatchObject({ candidateVersion: candidate.commit });
    expect(readFileSync(payload).subarray(0, 4).toString()).toBe("EEEE");
  }, 30_000);

  it("私有提交快照拒绝归档失败、非法路径、符号链接与 submodule，并确认清理失败", async () => {
    const valid = versionedPluginCopy("generator", "snapshot-boundary");
    await expect(withPrivateGitCommitSnapshot(valid, async () => undefined, { gitExecutable: fakeGit("archive-fail") }))
      .rejects.toThrow(/Git 对象：archive/);
    await expect(withPrivateGitCommitSnapshot(valid, async () => undefined, { gitExecutable: fakeGit("malicious-tree") }))
      .rejects.toThrow(/非法路径/);

    const linked = versionedPluginCopy("generator", "snapshot-link");
    symlinkSync("package.json", join(linked.root, "linked-package"));
    spawnSync("git", ["add", "linked-package"], { cwd: linked.root });
    spawnSync("git", ["commit", "-m", "fixture: symlink"], { cwd: linked.root });
    linked.commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: linked.root, encoding: "utf8" }).stdout.trim();
    await expect(withPrivateGitCommitSnapshot(linked, async () => undefined)).rejects.toThrow(/符号链接/);

    const submodule = versionedPluginCopy("generator", "snapshot-submodule");
    spawnSync("git", ["update-index", "--add", "--cacheinfo", `160000,${submodule.commit},nested-module`], { cwd: submodule.root });
    spawnSync("git", ["commit", "-m", "fixture: submodule"], { cwd: submodule.root });
    submodule.commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: submodule.root, encoding: "utf8" }).stdout.trim();
    await expect(withPrivateGitCommitSnapshot(submodule, async () => undefined)).rejects.toThrow(/子模块/);

    await expect(withPrivateGitCommitSnapshot(valid, async () => undefined, {
      remove: (root) => { rmSync(root, { recursive: true, force: true }); throw new Error("受控清理失败"); },
    })).rejects.toThrow(/受控清理失败/);
  });

  it("配对评测拒绝镜像、资源、对手或案例顺序身份漂移", async () => {
    const runner = new DockerPairedEvaluationRunner(`maze-match@sha256:${"a".repeat(64)}`, "/tmp/unused");
    const base = {
      role: "solver" as const,
      protocolVersion: 1 as const,
      candidate: { commit: "1".repeat(40), root: "/tmp/candidate" },
      champion: { commit: "2".repeat(40), root: "/tmp/champion" },
      opponent: { commit: "3".repeat(40), root: "/tmp/opponent" },
      cases: [{ id: "b", seed: "b", visibility: "public" as const }, { id: "a", seed: "a", visibility: "hidden" as const }],
      context: { opponentVersion: "3".repeat(40), imageDigest: `maze-match@sha256:${"a".repeat(64)}`,
        resourcePolicyDigest: MATCH_PROFILE_POLICY_DIGEST },
    };
    await expect(runner.evaluate(base)).rejects.toThrow(/严格有序/);
    await expect(runner.evaluate({ ...base, cases: [...base.cases].reverse(),
      context: { ...base.context, opponentVersion: "4".repeat(40) } })).rejects.toThrow(/对手提交/);
    await expect(runner.evaluate({ ...base, cases: [...base.cases].reverse(),
      context: { ...base.context, resourcePolicyDigest: "drift" } })).rejects.toThrow(/资源策略/);
  });

  it("真实子进程加载两个插件完成比赛，Solver 信封不含生成种子", async () => {
    const { home } = await installProfiles();
    const runner = new NativePluginMatchRunner({
      create: (role) => dshCommand(home, role),
    });
    const result = await runner.run("native-profile-seed");
    expect(result.score.solved).toBe(true);
    expect(result.events.at(-1)).toMatchObject({ type: "match.completed", score: result.score });
  }, 20_000);

  it("入口闭包第 65 个运行文件关闭失败", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-runtime-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    mkdirSync(join(root, "lib"));
    for (let index = 0; index < 64; index += 1) writeFileSync(join(root, `lib/extra-${index}.js`), "export {};\n");
    writeFileSync(join(root, "lib/entry.js"), Array.from({ length: 64 }, (_, index) => `import "./extra-${index}.js";`).join("\n"));
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "./lib/entry.js";
    manifest.files = ["lib", "cordis.patch.yml"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(validatePluginPackage(root)).rejects.toThrow(/运行载荷超过冻结配额/);
  });

  it("静态 require 的 66 个 cjs 入口闭包关闭失败", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-cjs-runtime-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    mkdirSync(join(root, "lib"));
    for (let index = 0; index < 65; index += 1) writeFileSync(join(root, `lib/required-${index}.cjs`), "module.exports = {};\n");
    writeFileSync(join(root, "lib/entry.cjs"), Array.from({ length: 65 }, (_, index) => `require("./required-${index}.cjs");`).join("\n"));
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "./lib/entry.cjs";
    manifest.files = ["lib", "cordis.patch.yml"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(validatePluginPackage(root)).rejects.toThrow(/运行载荷超过冻结配额/);
  });

  it.each([
    ["绝对路径 require", 'require("/tmp/outside.cjs");', /未封闭的运行依赖/],
    ["包外相对路径 require", 'require("../../outside.cjs");', /引用包外模块/],
    ["require 别名", "const load = require;", /无法静态分析的 require/],
    ["动态 require", 'const target = "./dep.cjs"; require(target);', /无法静态分析的 require/],
    ["动态 import", 'const target = "./dep.js"; import(target);', /无法静态分析的动态 import/],
    ["createRequire 识别符", "createRequire(import.meta.url);", /不得使用 createRequire/],
    ["module.require", 'module.require("/tmp/outside.cjs");', /成员式 Node 模块加载入口/],
    ["module 计算属性 require", 'module["require"]("/tmp/outside.cjs");', /成员式 Node 模块加载入口/],
    ["process.mainModule.require", 'process.mainModule.require("/tmp/outside.cjs");', /成员式 Node 模块加载入口/],
    ["静态导入 node:module", 'import * as loader from "node:module"; loader.createRequire(import.meta.url);', /不得导入 Node Module 加载器/],
    ["静态导入 module", 'import { createRequire as load } from "module"; load(import.meta.url);', /不得导入 Node Module 加载器/],
    ["静态再导出 node:module", 'export { createRequire } from "node:module";', /不得导入 Node Module 加载器/],
    ["静态 require node:module", 'const loader = require("node:module");', /不得导入 Node Module 加载器/],
    ["动态静态 import node:module", 'const loader = await import("node:module");', /不得导入 Node Module 加载器/],
    ["module.createRequire", "module.createRequire(import.meta.url);", /成员式 Node 模块加载入口/],
    ["module 计算属性 createRequire", 'module["createRequire"](import.meta.url);', /成员式 Node 模块加载入口/],
    ["Module._load", 'Module._load("/tmp/outside.cjs");', /成员式 Node 模块加载入口/],
    ["process.getBuiltinModule", 'process.getBuiltinModule("module");', /成员式 Node 模块加载入口/],
    ["module 加载器别名", 'const loader = module; const key = "require"; loader[key]("/tmp/outside.cjs");', /CommonJS module 加载器/],
    ["Module 加载器别名", 'const loader = Module; const key = "_load"; loader[key]("/tmp/outside.cjs");', /Node Module 加载器/],
    ["process 加载器别名", 'const loader = process; loader.getBuiltinModule("node:module");', /不得为 Node 进程全局对象创建别名/],
    ["globalThis.process 加载器", 'globalThis.process.getBuiltinModule("node:module");', /成员式 Node 模块加载入口/],
    ["global.process 加载器", 'global.process.getBuiltinModule("node:module");', /成员式 Node 模块加载入口/],
    ["globalThis 别名", 'const root = globalThis; root.process.getBuiltinModule("node:module");', /不得为 Node 全局对象创建别名/],
  ])("AST 闭包分析拒绝%s", async (_label, source, expected) => {
    await expect(validatePluginPackage(pluginWithRuntimeSource(source))).rejects.toThrow(expected);
  });

  it("AST 闭包分析忽略注释和字符串中的 require 文本", async () => {
    const root = pluginWithRuntimeSource(`
      const diagnostic = "require(variable)";
      // require(dynamicTarget)
      export default diagnostic;
    `);
    await expect(validatePluginPackage(root)).resolves.toBeDefined();
  });

  it("AST 闭包分析不误封普通对象的同名成员", async () => {
    const root = pluginWithRuntimeSource(`
      const loader = { createRequire: () => "business-value", require: () => "business-value", module: "NodeNext" };
      export default [loader.createRequire(), loader?.require(), loader.module];
    `);
    await expect(validatePluginPackage(root)).resolves.toBeDefined();
  });

  it("对抗运行可证明 module.require 能加载包外绝对路径，而闭包校验必须拒绝", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "maze-outside-module-")), "outside.cjs");
    writeFileSync(outside, 'module.exports = "OUTSIDE_LOADED";\n');
    const root = pluginWithRuntimeSource("export {};\n");
    writeFileSync(join(root, "dist/index.cjs"), `console.log(module.require(${JSON.stringify(outside)}));\n`);
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "./dist/index.cjs";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(spawnSync(process.execPath, [join(root, "dist/index.cjs")], { encoding: "utf8" }).stdout.trim()).toBe("OUTSIDE_LOADED");
    await expect(validatePluginPackage(root)).rejects.toThrow(/成员式 Node 模块加载入口/);
  });

  it("对抗运行可证明 node:module 别名的计算属性能加载包外代码，而闭包校验必须拒绝", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "maze-outside-create-require-")), "outside.cjs");
    writeFileSync(outside, 'module.exports = "OUTSIDE_LOADED";\n');
    const root = pluginWithRuntimeSource("export {};\n");
    writeFileSync(join(root, "dist/index.js"), `
      import * as loader from "node:module";
      const localRequire = loader["create" + "Require"](import.meta.url);
      console.log(localRequire(${JSON.stringify(outside)}));
    `);
    expect(spawnSync(process.execPath, [join(root, "dist/index.js")], { encoding: "utf8" }).stdout.trim()).toBe("OUTSIDE_LOADED");
    await expect(validatePluginPackage(root)).rejects.toThrow(/不得导入 Node Module 加载器/);
  });

  it("对抗运行可证明 globalThis.process 别名能加载包外代码，而闭包校验必须拒绝", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "maze-outside-global-process-")), "outside.cjs");
    writeFileSync(outside, 'module.exports = "OUTSIDE_LOADED";\n');
    const root = pluginWithRuntimeSource("export {};\n");
    writeFileSync(join(root, "dist/index.js"), `
      const processAlias = globalThis.process;
      const loader = processAlias.getBuiltinModule("node:module");
      const localRequire = loader.createRequire(import.meta.url);
      console.log(localRequire(${JSON.stringify(outside)}));
    `);
    expect(spawnSync(process.execPath, [join(root, "dist/index.js")], { encoding: "utf8" }).stdout.trim()).toBe("OUTSIDE_LOADED");
    await expect(validatePluginPackage(root)).rejects.toThrow(/成员式 Node 模块加载入口/);
  });

  it("src 下第 65 个未引用源码文件仍关闭失败", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-source-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    for (let index = 0; index < 65; index += 1) writeFileSync(join(root, `src/unreferenced-${index}.ts`), "export {};\n");
    await expect(validatePluginPackage(root)).rejects.toThrow(/候选源码超过冻结配额/);
  });

  it("lib/source 下未引用源码同样进入全部源码配额", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-named-source-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    mkdirSync(join(root, "lib/source"), { recursive: true });
    for (let index = 0; index < 65; index += 1) writeFileSync(join(root, `lib/source/unreferenced-${index}.js`), "export {};\n");
    await expect(validatePluginPackage(root)).rejects.toThrow(/候选源码超过冻结配额/);
  });

  it("pack 中 3 MiB dat 安装内容计入统一构建配额", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-build-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    writeFileSync(join(root, "dist/payload.dat"), "x".repeat(3 * 1024 * 1024));
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = ["dist", "cordis.patch.yml"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(validatePluginPackage(root)).rejects.toThrow(/构建产物超过冻结配额/);
  });

  it.each(["native.node", "module.wasm"])("显式拒绝禁止安装产物 %s", async (name) => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-forbidden-build-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    writeFileSync(join(root, `dist/${name}`), "forbidden");
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = ["dist", "cordis.patch.yml"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(validatePluginPackage(root)).rejects.toThrow(/二进制、原生或 WebAssembly/);
  });

  it("非 src/dist 的 300 KiB 实际入口仍按运行载荷拒绝", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-lib-quota-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib/entry.js"), `export const payload = "${"x".repeat(300 * 1024)}";\n`);
    const manifestPath = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "./lib/entry.js";
    manifest.files = ["lib", "cordis.patch.yml"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(validatePluginPackage(root)).rejects.toThrow(/运行载荷超过冻结配额/);
  });

  it("拒绝角色 bundle 内联额外 insert", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "maze-patch-")), "solver-plugin");
    cpSync(join(workspaceRoot, "packages/solver-plugin"), root, { recursive: true });
    writeFileSync(join(root, "cordis.patch.yml"), "- insert:\n    - { id: maze-solver, name: '@maze-arena/solver-plugin' }\n    - { id: extra, name: dangerous }\n");
    await expect(validatePluginPackage(root)).rejects.toThrow(/只能挂载自身一个能力入口/);
  });

  it("合法响应后保持事件循环时 finalize 有界超时", async () => {
    const client = new MatchProfileProcess(command("hold-open"), "solver", 250);
    await expect(client.request(startRequest())).resolves.toMatchObject({ payload: { type: "solver.ready" } });
    await expect(client.finalize()).rejects.toMatchObject({ code: "TIMEOUT" });
    await client.close();
  });

  it("拒绝 Harness home 叠加额外贡献项", async () => {
    const home = createDshHome("maze-dsh-home-patch-");
    writeFileSync(join(home, "cordis.patch.yml"), "- insert: [{ id: extra, name: dangerous }]\n");
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, ...fakeHarnessRuntime, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: join(workspaceRoot, "packages/generator-plugin"), solver: join(workspaceRoot, "packages/solver-plugin") },
    });
    await expect(installer.prepare()).rejects.toThrow(/不得叠加额外贡献项/);
  });

  it("非法 bundle 在调用 dsh 安装前被拒绝", async () => {
    const invalid = join(mkdtempSync(join(tmpdir(), "maze-invalid-install-")), "generator-plugin");
    cpSync(join(workspaceRoot, "packages/generator-plugin"), invalid, { recursive: true });
    writeFileSync(join(invalid, "cordis.patch.yml"), "- insert: [{ id: maze-generator, name: '@maze-arena/generator-plugin' }, { id: extra, name: dangerous }]\n");
    const home = mkdtempSync(join(tmpdir(), "maze-preinstall-home-"));
    const marker = join(home, "dsh-invoked");
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, ...fakeHarnessRuntime, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: invalid, solver: join(workspaceRoot, "packages/solver-plugin") },
      environment: { DSH_INVOCATION_MARKER: marker },
    });
    await expect(installer.prepare()).rejects.toThrow(/只能挂载自身一个能力入口/);
    expect(existsSync(marker)).toBe(false);
  });

  it("构建产物引用包外模块时在调用 dsh 安装前被拒绝", async () => {
    const invalid = join(mkdtempSync(join(tmpdir(), "maze-outside-install-")), "generator-plugin");
    cpSync(join(workspaceRoot, "packages/generator-plugin"), invalid, { recursive: true });
    writeFileSync(join(invalid, "dist/index.js"), "export { apply } from '../../../outside.mjs';\n");
    const home = mkdtempSync(join(tmpdir(), "maze-outside-home-"));
    const marker = join(home, "dsh-invoked");
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, ...fakeHarnessRuntime, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: invalid, solver: join(workspaceRoot, "packages/solver-plugin") },
      environment: { DSH_INVOCATION_MARKER: marker },
    });
    await expect(installer.prepare()).rejects.toThrow(/引用包外模块/);
    expect(existsSync(marker)).toBe(false);
  });

  it("dsh 篡改 pnpm 安装副本时由安装载荷复验关闭失败", async () => {
    const home = mkdtempSync(join(tmpdir(), "maze-postinstall-home-"));
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, ...fakeHarnessRuntime, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: join(workspaceRoot, "packages/generator-plugin"), solver: join(workspaceRoot, "packages/solver-plugin") },
      environment: { DSH_TAMPER_INSTALLED_PATCH: "1" },
    });
    await expect(installer.prepare()).rejects.toThrow(/角色 bundle 必须且只能挂载自身一个能力入口/);
  });
});
