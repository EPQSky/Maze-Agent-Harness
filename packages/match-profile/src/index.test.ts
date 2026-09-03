import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MatchPluginRole, MatchProtocolRequest } from "@maze-arena/contracts";
import {
  DockerMatchProfileCommandFactory,
  HarnessMatchProfileInstaller,
  MatchProfileError,
  MatchProfileProcess,
  NativePluginMatchRunner,
  validatePluginPackage,
} from "./index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const peer = join(packageRoot, "test/fixtures/protocol-peer.mjs");
const fakeDsh = join(packageRoot, "test/fixtures/fake-dsh/dsh.mjs");
const cleanupFixture = join(packageRoot, "test/fixtures/container-cleanup.mjs");

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
}) {
  const home = mkdtempSync(join(tmpdir(), "maze-dsh-home-"));
  const installer = new HarnessMatchProfileInstaller({
    executable: fakeDsh, expectedVersion: "2026.09-preview.1", home,
    protocolBundle: packageRoot, roleBundles,
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
      error instanceof AggregateError && error.errors.some((nested) => String(nested).includes("permission denied")));
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
      for (const name of manifest.dsh.profile.bundles) {
        const installed = join(home, "profiles", `maze-match-${role}`, "node_modules", ...name.split("/"));
        expect(realpathSync(installed).startsWith(join(home, "artifacts", "sha256-"))).toBe(true);
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
    installer.uninstall();
    for (const role of ["generator", "solver"] as const) {
      const manifest = JSON.parse(readFileSync(join(home, "profiles", `maze-match-${role}`, "package.json"), "utf8"));
      expect(manifest.dsh.profile.bundles).toEqual([]);
      expect(manifest.dependencies).toEqual({});
    }
  });

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
        "run", "--rm", "--name", expect.stringMatching(/^maze-match-solver-[a-f0-9]{24}$/), "--network=none", "--read-only", "--user=65532:65532", "--memory=128m",
        "--memory-swap=128m", "--ulimit=cpu=2:2", "--security-opt=no-new-privileges", "--cap-drop=ALL",
        expect.stringContaining("src=" + join(root, "snapshots", "solver")),
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
      const loader = { createRequire: () => "business-value", require: () => "business-value" };
      export default [loader.createRequire(), loader?.require()];
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
    const home = mkdtempSync(join(tmpdir(), "maze-dsh-home-patch-"));
    writeFileSync(join(home, "cordis.patch.yml"), "- insert: [{ id: extra, name: dangerous }]\n");
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
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
      executable: fakeDsh, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
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
      executable: fakeDsh, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: invalid, solver: join(workspaceRoot, "packages/solver-plugin") },
      environment: { DSH_INVOCATION_MARKER: marker },
    });
    await expect(installer.prepare()).rejects.toThrow(/引用包外模块/);
    expect(existsSync(marker)).toBe(false);
  });

  it("dsh 安装后篡改真实 node_modules 会被再次拒绝", async () => {
    const home = mkdtempSync(join(tmpdir(), "maze-postinstall-home-"));
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, expectedVersion: "2026.09-preview.1", home, protocolBundle: packageRoot,
      roleBundles: { generator: join(workspaceRoot, "packages/generator-plugin"), solver: join(workspaceRoot, "packages/solver-plugin") },
      environment: { DSH_TAMPER_INSTALLED_PATCH: "1" },
    });
    await expect(installer.prepare()).rejects.toThrow(/贡献项|内容哈希/);
  });
});
