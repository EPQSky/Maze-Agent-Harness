import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import type {
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
  EvolutionRole,
  GenerationRoleResult,
  LineageHistoryResponse,
  MatchEvent,
} from "@maze-arena/contracts";
import {
  DeterministicFakeHarnessAdapter,
  HARNESS_EVOLUTION_ALLOWED_TOOLS,
  HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS,
  HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES,
  HARNESS_EVOLUTION_MAX_REQUEST_BYTES,
  HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES,
  HARNESS_EVOLUTION_MAX_TRACE_EVENTS,
  harnessEvolutionTrustedInputBytes,
  hashHarnessRuntimePayload,
  ModelProfileValidationError,
  type HarnessEvolutionRequest,
} from "@maze-arena/dsh-integration";
import { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { afterEach, describe, expect, it } from "vitest";
import { createArenaServer as createArenaServerImpl, installPersistentShutdownHandlers, type ArenaServerOptions } from "./app.js";
import { createProductionHarnessAdapter } from "./production-harness.js";
import { HarnessInvocationError } from "./harness-invocation-error.js";
import { runBaselineMatch } from "@maze-arena/engine";
import type { PairedEvaluationRunner } from "@maze-arena/match-profile";
import type { AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import { assembleTrustedEvolutionFeedback } from "./trusted-evolution-feedback.js";

const servers: ReturnType<typeof createArenaServer>[] = [];
const deterministicMatchRunner = {
  run: async (seed: string, onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void) => {
    const result = runBaselineMatch(seed);
    for (const event of result.events) await onEvents?.([event]);
    return result;
  },
};
const trustedCandidateTestRunner = {
  // 集成夹具模拟权威测试结论；生产接线必须使用 DockerTrustedCandidateTestRunner。
  run: () => undefined,
};
const deterministicPairedEvaluationRunner: PairedEvaluationRunner = {
  async evaluate(input) {
    if (input.role === "generator") {
      const score = { gateFailures: 0, failedCases: 0, extraActions: 0, structuralNovelty: input.cases.length };
      return {
        candidateVersion: input.candidate.commit, championVersion: input.champion.commit,
        solverVersion: input.opponent.commit, context: { ...input.context },
        publicCases: input.cases.filter(({ visibility }) => visibility === "public").map(({ id, seed }) => ({
          caseId: id, seed,
          candidate: { failed: false, extraActions: 0, topologyHash: id, gateFailure: null,
            trace: [{ type: "maze.carved", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }] },
          champion: { failed: false, extraActions: 0, topologyHash: id, gateFailure: null, trace: [] },
        })),
        hidden: { caseCount: input.cases.filter(({ visibility }) => visibility === "hidden").length,
          candidate: score, champion: score },
        total: { candidate: score, champion: score }, publicPrimaryRegressed: false, promote: false,
      };
    }
    const score = { solvedCases: input.cases.length, extraActions: 0, illegalActions: 0 };
    return {
      candidateVersion: input.candidate.commit, championVersion: input.champion.commit,
      generatorVersion: input.opponent.commit, context: { ...input.context },
      publicCases: input.cases.filter(({ visibility }) => visibility === "public").map(({ id, seed }) => ({
        caseId: id, seed,
        candidate: { solved: true, extraActions: 0, illegalActions: 0, trace: [{
          observation: { position: { x: 0, y: 0 }, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 },
            openDirections: ["east" as const], remainingSteps: 4096, previousAction: null },
          action: { direction: "east" as const, kind: "move" as const },
        }] },
        champion: { solved: true, extraActions: 0, illegalActions: 0, trace: [] },
      })),
      hidden: { caseCount: input.cases.filter(({ visibility }) => visibility === "hidden").length,
        candidate: score, champion: score },
      total: { candidate: score, champion: score }, publicPrimaryRegressed: false, promote: false,
    };
  },
};
function createArenaServer(options: ArenaServerOptions) {
  return createArenaServerImpl({
    candidateTestRunner: trustedCandidateTestRunner,
    pairedEvaluationRunner: deterministicPairedEvaluationRunner,
    matchImageDigest: "test-match-image",
    resourcePolicyDigest: "test-resource-policy",
    versionedMatchRunner: {
      runVersioned: async (input) => {
        await new Promise((resolveStart) => setTimeout(resolveStart, 100));
        return deterministicMatchRunner.run(input.seed, input.onEvents);
      },
    },
    ...options,
  });
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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createTestServer(databasePath: string, autonomousEvolutionAdapter?: AutonomousEvolutionAdapter) {
  const server = createArenaServer({
    databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter(), matchRunner: deterministicMatchRunner,
    autonomousEvolutionAdapter,
  });
  servers.push(server);
  return server;
}

function createLineageCandidate(directory: string, suffix: string): string {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/generator-plugin");
  const candidateRoot = join(directory, `candidate-${suffix}`);
  cpSync(sourceRoot, candidateRoot, {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes("/dist"),
  });
  const source = join(candidateRoot, "src/index.ts");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n// API 谱系候选 ${suffix}\n`);
  return candidateRoot;
}

function productionEvolutionRequest(
  request: Omit<HarnessEvolutionRequest, "sessionId" | "home" | "input" | "allowedTools">,
): HarnessEvolutionRequest {
  const home = mkdtempSync(join(tmpdir(), "maze-harness-session-"));
  return {
    ...request,
    sessionId: randomUUID(),
    home,
    input: {
      role: request.role,
      championRoot: request.workspace,
      lineagePlans: [],
      trustedResults: [],
      publicTraces: [],
      hiddenAggregate: {
        completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
        promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
        evaluatedHiddenCaseCount: 0, metricTotals: {},
      },
    },
    allowedTools: HARNESS_EVOLUTION_ALLOWED_TOOLS,
  };
}

async function createExperiment(server: ReturnType<typeof createArenaServer>, name: string, costLimit?: number) {
  const payload: CreateExperimentRequest = {
    name,
    ...(costLimit === undefined ? {} : { costLimit }),
    modelProfile: {
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      temperature: 0.4,
      topP: 0.9,
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
      providerOptions: { deterministicSeed: 42 },
    },
  };
  const response = await server.inject({
    method: "POST",
    url: "/api/experiments",
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Experiment>();
}

async function validateAndConfirm(server: ReturnType<typeof createArenaServer>, id: string): Promise<void> {
  expect((await server.inject({ method: "POST", url: `/api/experiments/${id}/baseline-validation/run`, payload: {} })).statusCode).toBe(200);
  expect((await server.inject({ method: "POST", url: `/api/experiments/${id}/baseline-validation/confirm`, payload: {} })).statusCode).toBe(200);
}

const abortableBlockingAdapter: AutonomousEvolutionAdapter = {
  runRole: ({ signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(new Error("已取消")); return; }
    signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
  }),
};

describe("实验工作台 API", () => {
  it("持久关闭处理器合并交错信号风暴且仅在关闭成功后卸载", async () => {
    const signals = new EventEmitter();
    let closeCalls = 0;
    let holdCalls = 0;
    let releaseCalls = 0;
    let resolveClose: (() => void) | undefined;
    const closing = new Promise<void>((resolveClosing) => { resolveClose = resolveClosing; });
    const shutdown = installPersistentShutdownHandlers(
      () => { closeCalls += 1; return closing; },
      () => { throw new Error("关闭不应失败"); },
      signals,
      () => { holdCalls += 1; return () => { releaseCalls += 1; }; },
    );

    for (let index = 0; index < 1_000; index += 1) signals.emit(index % 2 === 0 ? "SIGTERM" : "SIGINT");
    await Promise.resolve();
    expect(closeCalls).toBe(1);
    expect(holdCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(shutdown.begin()).toBe(shutdown.begin());

    resolveClose!();
    await shutdown.begin();
    expect(releaseCalls).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("关闭拒绝后保持持久监听与唯一关闭 Promise", async () => {
    const signals = new EventEmitter();
    const failure = new Error("close rejected");
    let closeCalls = 0;
    let failureCalls = 0;
    let releaseCalls = 0;
    const shutdown = installPersistentShutdownHandlers(
      async () => { closeCalls += 1; throw failure; },
      (error) => { expect(error).toBe(failure); failureCalls += 1; },
      signals,
      () => () => { releaseCalls += 1; },
    );

    signals.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (let index = 0; index < 1_000; index += 1) signals.emit(index % 2 === 0 ? "SIGINT" : "SIGTERM");
    await Promise.resolve();
    expect(closeCalls).toBe(1);
    expect(failureCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(shutdown.begin()).toBe(shutdown.begin());
  });

  it("生产健康端点携带实例身份并从构建目录交付 Web", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-production-web-"));
    const webRoot = join(root, "web");
    mkdirSync(join(webRoot, "assets"), { recursive: true });
    writeFileSync(join(webRoot, "index.html"), "<title>Maze Arena Production</title>");
    writeFileSync(join(webRoot, "assets/app.js"), "globalThis.mazeArena = true;");
    const previousInstance = process.env.ARENA_INSTANCE_ID;
    process.env.ARENA_INSTANCE_ID = "instance-test";
    const server = createArenaServer({
      databasePath: ":memory:", harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: deterministicMatchRunner, webRoot,
    });
    servers.push(server);
    try {
      expect((await server.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({
        status: "ok", instanceId: "instance-test", pid: process.pid,
      });
      expect((await server.inject({ method: "GET", url: "/" })).body).toContain("Maze Arena Production");
      expect((await server.inject({ method: "GET", url: "/assets/app.js" })).headers["content-type"]).toContain("text/javascript");
      expect((await server.inject({ method: "GET", url: "/workbench/deep-link" })).body).toContain("Maze Arena Production");
      expect((await server.inject({ method: "GET", url: "/api/not-found" })).statusCode).toBe(404);
    } finally {
      if (previousInstance === undefined) delete process.env.ARENA_INSTANCE_ID;
      else process.env.ARENA_INSTANCE_ID = previousInstance;
    }
  });

  it("监督基线验收通过并确认后才创建就绪运行时，重启仍保持冻结事实", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-baseline-api-"));
    const databasePath = join(directory, "arena.sqlite");
    const first = createTestServer(databasePath);
    const experiment = await createExperiment(first, "监督基线实验");
    const before = await first.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` });
    expect(before.statusCode).toBe(404);

    const validation = await first.inject({
      method: "POST", url: `/api/experiments/${experiment.id}/baseline-validation/run`, payload: { smokeProvider: true },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toMatchObject({ status: "passed", operatorConfirmed: false, smoke: { attempted: true, passed: true } });
    expect(validation.json().steps).toHaveLength(10);
    expect((await first.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).statusCode).toBe(404);

    const confirmed = await first.inject({ method: "POST", url: `/api/experiments/${experiment.id}/baseline-validation/confirm`, payload: {} });
    expect(confirmed.json()).toMatchObject({ status: "ready", operatorConfirmed: true, frozenConfiguration: { compatibilityFingerprint: "maze-arena-v1" } });
    const readyRuntime = (await first.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    expect(readyRuntime).toMatchObject({ state: "ready", generation: 0, sealed: true });
    expect(readyRuntime.champions.generator).toMatch(/^[0-9a-f]{40}$/);
    expect(readyRuntime.champions.solver).toMatch(/^[0-9a-f]{40}$/);

    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const restarted = createTestServer(databasePath);
    expect((await restarted.inject({ method: "GET", url: `/api/experiments/${experiment.id}/baseline-validation` })).json())
      .toMatchObject({ status: "ready", frozenConfiguration: { compatibilityFingerprint: "maze-arena-v1" } });
  });

  it("谱系 API 透传真实 Repository 的可信基线、中间候选与最终结果分类", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-lineage-api-"));
    const databasePath = join(directory, "arena.sqlite");
    const server = createTestServer(databasePath);
    const experiment = await createExperiment(server, "可信谱系 API 实验");
    await validateAndConfirm(server, experiment.id);

    const repository = new PluginLineageRepository(join(directory, "lineages"), databasePath);
    const intermediate = await repository.createCandidate({
      experimentId: experiment.id,
      role: "generator",
      sourceRoot: createLineageCandidate(directory, "intermediate"),
      attemptId: "g0001-generator",
      hypothesis: "先冻结中间修复候选",
    });
    const final = await repository.createCandidate({
      experimentId: experiment.id,
      role: "generator",
      sourceRoot: createLineageCandidate(directory, "final"),
      attemptId: "g0001-generator",
      hypothesis: "再冻结最终评测候选",
    });
    repository.recordCandidateResult({
      experimentId: experiment.id,
      role: "generator",
      attemptId: "g0001-generator",
      commit: final.commit,
      hypothesis: "再冻结最终评测候选",
      resultSummary: "与当前冠军平局",
      outcome: "tie",
    });
    repository.close();

    const response = await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/lineages` });
    expect(response.statusCode).toBe(200);
    const history = response.json<LineageHistoryResponse>();
    expect(history.generator).toEqual([
      expect.objectContaining({ kind: "baseline", attemptId: null, candidateStage: null, outcome: null, generation: null }),
      expect.objectContaining({ commit: intermediate.commit, kind: "candidate", attemptId: "g0001-generator",
        candidateStage: "intermediate", outcome: null, generation: null }),
      expect.objectContaining({ commit: final.commit, kind: "candidate", attemptId: "g0001-generator",
        candidateStage: "final", outcome: "tie", generation: null }),
    ]);
    expect(history.solver).toEqual([
      expect.objectContaining({ kind: "baseline", attemptId: null, candidateStage: null, outcome: null, generation: null }),
    ]);
  });

  it("运行 API 通过取消信号立即暂停活动会话并释放单实验锁", async () => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: ({ signal }) => new Promise((_resolve, reject) => {
        if (signal.aborted) { reject(new Error("自治会话已取消")); return; }
        signal.addEventListener("abort", () => reject(new Error("自治会话已取消")), { once: true });
      }),
    };
    const server = createTestServer(":memory:", adapter);
    const first = await createExperiment(server, "运行实验一");
    const second = await createExperiment(server, "运行实验二");
    for (const experiment of [first, second]) {
      await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/baseline-validation/run`, payload: {} });
      await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/baseline-validation/confirm`, payload: {} });
    }
    expect((await server.inject({ method: "POST", url: `/api/experiments/${first.id}/runtime/start` })).statusCode).toBe(200);
    const conflict = await server.inject({ method: "POST", url: `/api/experiments/${second.id}/runtime/start` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<DomainErrorResponse>().error.message).toMatch(/已有运行中的实验/);
    const paused = await server.inject({ method: "POST", url: `/api/experiments/${first.id}/runtime/pause` });
    expect(paused.json()).toMatchObject({ state: "paused", generation: 0, usage: { tokens: 0, cost: 0 } });
    expect((await server.inject({ method: "POST", url: `/api/experiments/${second.id}/runtime/start` })).statusCode).toBe(200);
  });

  it("可编程假 Harness 穿过真实本地适配器完成一代 8/24 配对评测", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-local-evolution-"));
    const databasePath = join(directory, "arena.sqlite");
    const delegate = new DeterministicFakeHarnessAdapter();
    const providerCalls = { generator: 0, solver: 0 };
    const pairCalls: Array<Parameters<PairedEvaluationRunner["evaluate"]>[0]> = [];
    const secondGenerationInput = new Map<EvolutionRole, HarnessEvolutionRequest["input"]>();
    const server = createArenaServer({
      databasePath,
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => delegate.validateModelProfile(input),
        smokeModel: (profile) => delegate.smokeModel(profile),
        evolvePlugin: async (request) => {
          if (request.generation > 1) {
            secondGenerationInput.set(request.role, structuredClone(request.input));
            if (request.role === "solver") {
              await new Promise((_resolve, reject) => {
                if (request.signal?.aborted) { reject(new Error("自治任务已取消")); return; }
                request.signal?.addEventListener("abort", () => reject(new Error("自治任务已取消")), { once: true });
              });
            }
          }
          providerCalls[request.role] += 1;
          const response = await delegate.evolvePlugin(request);
          return { ...response, strategyPlan: `允许的己方策略-${request.role}`, reasoning: "forbidden-reasoning-secret",
            toolActivity: "forbidden-tool-activity-secret" };
        },
      },
      pairedEvaluationRunner: {
        evaluate: async (input) => {
          pairCalls.push(structuredClone(input));
          return deterministicPairedEvaluationRunner.evaluate(input);
        },
      },
    });
    servers.push(server);
    const experiment = await createExperiment(server, "真实本地适配器实验");
    await validateAndConfirm(server, experiment.id);
    expect((await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` })).statusCode).toBe(200);

    let snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` }))
      .json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    for (let attempt = 0; attempt < 400 && snapshot.generation === 0 && snapshot.state !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    }
    for (let attempt = 0; attempt < 400 && secondGenerationInput.size < 2 && snapshot.state !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    }
    expect(secondGenerationInput.size).toBe(2);
    await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/pause` });
    snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    expect(snapshot).toMatchObject({ state: "paused", generation: 1, usage: { tokens: 300, cost: 0 } });
    expect(providerCalls).toEqual({ generator: 2, solver: 1 });
    expect(pairCalls.length).toBeGreaterThanOrEqual(4);
    for (const role of ["generator", "solver"] as const) {
      const roleCalls = pairCalls.filter((call) => call.role === role);
      expect(roleCalls.length).toBeGreaterThanOrEqual(2);
      expect(roleCalls[0]?.cases.map(({ id }) => id)).toEqual(Array.from({ length: 8 }, (_, index) => `public-${String(index + 1).padStart(2, "0")}`));
      expect(roleCalls[1]?.cases).toHaveLength(32);
      expect(roleCalls[1]?.cases.map(({ id }) => id)).toEqual(
        [...roleCalls[1]!.cases].map(({ id }) => id).sort((left, right) => left.localeCompare(right)),
      );
      expect(roleCalls[1]?.cases.filter(({ visibility }) => visibility === "public")).toEqual(roleCalls[0]?.cases);
      expect(roleCalls[0]).toMatchObject({
        candidate: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), root: expect.stringContaining("/evaluation-candidate") },
        champion: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), root: expect.stringContaining("/champion") },
        opponent: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), root: expect.stringContaining("/opponent") },
        context: { opponentVersion: roleCalls[0]!.opponent.commit, imageDigest: "test-match-image", resourcePolicyDigest: "test-resource-policy" },
      });
      expect(roleCalls.slice(0, 2).every(({ candidate }) => candidate.commit === roleCalls[0]!.candidate.commit)).toBe(true);
      expect(roleCalls[0]!.candidate.commit).toBe(snapshot.generations[0]![role]!.candidateCommit);
      expect(roleCalls[0]!.candidate.root).not.toBe(roleCalls[0]!.champion.root);
    }
    expect(snapshot.generations[0]).toMatchObject({
      generator: { outcome: "tie", publicProgress: 8, hiddenProgress: 24 },
      solver: { outcome: "tie", publicProgress: 8, hiddenProgress: 24 },
    });
    for (const role of ["generator", "solver"] as const) {
      const feedback = secondGenerationInput.get(role);
      expect(feedback).toBeDefined();
      expect(feedback?.lineagePlans).toEqual([{ attemptId: `g0001-${role}`, strategyPlan: `允许的己方策略-${role}` }]);
      expect(feedback?.trustedResults).toEqual([expect.objectContaining({
        attemptId: `g0001-${role}`, generation: 1, role, outcome: "tie", publicCaseCount: 8, hiddenCaseCount: 24,
        totalCandidateAggregate: expect.any(Object),
      })]);
      expect(feedback?.publicTraces).toHaveLength(8);
      expect(feedback?.publicTraces.every((trace) => trace.attemptId === `g0001-${role}`
        && trace.generation === 1 && trace.events.length > 0)).toBe(true);
      expect(feedback?.hiddenAggregate).toMatchObject({
        completedAttemptCount: 1, promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 1,
        evaluatedHiddenCaseCount: 24,
      });
      const serialized = JSON.stringify(feedback);
      const opponentRole = role === "generator" ? "solver" : "generator";
      for (const forbidden of [
        "hidden-", "sealed:", "forbidden-reasoning-secret", "forbidden-tool-activity-secret",
        `允许的己方策略-${opponentRole}`, `g0001-${opponentRole}`,
        "opponent", "opponentSource", "opponentStderr", "prompt", "reasoning", "toolActivity", "comments",
      ]) expect(serialized).not.toContain(forbidden);
    }
    const audit = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/audit-events` }))
      .json<import("@maze-arena/contracts").ExperimentAuditEventPage>();
    const allHarnessEvents = audit.events.filter(({ type }) => type === "harness.activity");
    const harnessEvents = allHarnessEvents.filter(({ details }) => details.outcome === "succeeded");
    expect(harnessEvents).toHaveLength(3);
    expect(harnessEvents.every(({ details }) => details.executionKind === "fake" && details.protocolVersion === 1)).toBe(true);
    expect(new Set(harnessEvents.map(({ details }) => details.sessionId)).size).toBe(3);
    expect(new Set(harnessEvents.filter(({ details }) => details.role === "generator").map(({ details }) => details.sessionId)).size).toBe(2);
    expect(new Set(harnessEvents.filter(({ details }) => details.role === "solver").map(({ details }) => details.sessionId)).size).toBe(1);
    expect(allHarnessEvents.some(({ details }) => details.outcome === "failed" && details.failureKind === "unknown")).toBe(true);
    const prepared = audit.events.filter(({ type }) => type === "candidate.prepared");
    const evaluated = audit.events.filter(({ type }) => type === "candidate.evaluated");
    expect(prepared).toHaveLength(3);
    expect(prepared.every(({ details }) => details.payloadChanged === true && details.trustedBuild === "passed"
      && typeof details.candidateCommit === "string" && typeof details.trustedBuildSha256 === "string")).toBe(true);
    expect(evaluated).toHaveLength(3);
    expect(evaluated.every(({ details }) => details.publicCaseCount === 8 && details.hiddenCaseCount === 24
      && details.isolation === "docker-match-profile" && details.scope === "public-and-hidden")).toBe(true);
    expect(snapshot.generations[0]?.generator).toMatchObject({
      attemptId: "g0001-generator", evidenceLevel: "fake", candidateStatus: "evaluated",
      trustedBuildSha256: expect.stringMatching(/^[0-9a-f]{64}$/), isolatedEvaluation: true,
    });
    expect(JSON.stringify(audit)).not.toContain("hidden-");
    expect(JSON.stringify(audit)).not.toContain("sealed:");
  }, 20_000);

  it("Harness 返回未提交时审计明确记录调用成功与候选无效且不进入评测", async () => {
    const delegate = new DeterministicFakeHarnessAdapter();
    const server = createArenaServer({
      databasePath: ":memory:", matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => delegate.validateModelProfile(input),
        smokeModel: (profile) => delegate.smokeModel(profile),
        evolvePlugin: async (request) => {
          if (request.generation > 1) {
            await new Promise((_resolve, reject) => {
              const stop = () => reject(new Error("自治任务已取消"));
              if (request.signal?.aborted) stop();
              else request.signal?.addEventListener("abort", stop, { once: true });
            });
          }
          return { ...(await delegate.evolvePlugin(request)), submitted: false };
        },
      },
      pairedEvaluationRunner: { evaluate: async () => { throw new Error("无效候选不得进入评测"); } },
    });
    servers.push(server);
    const experiment = await createExperiment(server, "无效候选审计实验");
    await validateAndConfirm(server, experiment.id);
    await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });
    let snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` }))
      .json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    for (let attempt = 0; attempt < 200 && snapshot.generation === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    }
    await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/pause` });
    const audit = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/audit-events` }))
      .json<import("@maze-arena/contracts").ExperimentAuditEventPage>();
    expect(audit.events.filter(({ type, details }) => type === "harness.activity" && details.outcome === "succeeded").length).toBeGreaterThanOrEqual(2);
    expect(audit.events.filter(({ type }) => type === "candidate.invalid").length).toBeGreaterThanOrEqual(2);
    expect(audit.events.filter(({ type }) => type === "candidate.evaluated")).toHaveLength(0);
    expect(audit.events.filter(({ type }) => type === "candidate.promoted")).toHaveLength(0);
    expect(audit.events.filter(({ type }) => type === "candidate.invalid").every(({ details }) => details.reason === "not-submitted")).toBe(true);
  });

  it("恢复 Ticket 05 旧检查点时向第二代 Harness 传递公开事实并标记隐藏指标不可用", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-legacy-feedback-"));
    const databasePath = join(directory, "arena.sqlite");
    const first = createArenaServer({ databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter(), matchRunner: deterministicMatchRunner });
    servers.push(first);
    const experiment = await createExperiment(first, "旧检查点恢复实验");
    await validateAndConfirm(first, experiment.id);
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const runtime = new ExperimentRuntimeRepository(databasePath);
    const ready = runtime.get(experiment.id)!;
    runtime.start(experiment.id);
    const legacyResult = (role: EvolutionRole): import("@maze-arena/contracts").GenerationRoleResult => ({
      candidateCommit: ready.champions[role], championBefore: ready.champions[role], championAfter: ready.champions[role],
      outcome: "tie", promotionTag: null, publicProgress: 8, hiddenProgress: 24, aggregate: { legacyTotal: 32 },
    });
    const generator = legacyResult("generator");
    const solver = legacyResult("solver");
    runtime.saveRoleCheckpoint({ experimentId: experiment.id, generation: 1, role: "generator",
      attemptId: "g0001-generator", result: generator, tokens: 100, cost: 0 });
    runtime.saveRoleCheckpoint({ experimentId: experiment.id, generation: 1, role: "solver",
      attemptId: "g0001-solver", result: solver, tokens: 100, cost: 0 });
    runtime.requestPause(experiment.id);
    runtime.commitGeneration({ experimentId: experiment.id, generator, solver, checkpointKey: "generation-1" });
    runtime.close();

    const observed = new Map<EvolutionRole, HarnessEvolutionRequest["input"]>();
    const delegate = new DeterministicFakeHarnessAdapter();
    const restarted = createArenaServer({
      databasePath, matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => delegate.validateModelProfile(input),
        smokeModel: (profile) => delegate.smokeModel(profile),
        evolvePlugin: (request) => new Promise((_resolve, reject) => {
          observed.set(request.role, structuredClone(request.input));
          if (request.signal?.aborted) { reject(new Error("自治任务已取消")); return; }
          request.signal?.addEventListener("abort", () => reject(new Error("自治任务已取消")), { once: true });
        }),
      },
    });
    servers.push(restarted);
    expect((await restarted.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/resume` })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 200 && !observed.has("generator"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observed.get("generator")).toMatchObject({
      trustedResults: [{ attemptId: "g0001-generator", outcome: "tie", totalCandidateAggregate: { legacyTotal: 32 } }],
      publicTraces: [],
      hiddenAggregate: {
        completedAttemptCount: 1, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 1,
        evaluatedHiddenCaseCount: 24, metricTotals: {},
      },
    });
    expect((await restarted.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json())
      .toMatchObject({ state: "running", generation: 1, compatibilityFingerprint: "maze-arena-v1" });
    await restarted.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/pause` });
  }, 15_000);

  it.each([
    ["protocol", 2, 107, 0.27],
    ["transient-provider", 4, 121, 0.81],
  ] as const)("本地适配器在前次成功、后续 %s 失败时合并可信用量且不双计", async (kind, expectedCalls, tokens, cost) => {
    const directory = mkdtempSync(join(tmpdir(), `maze-local-usage-${kind}-`));
    const databasePath = join(directory, "arena.sqlite");
    const delegate = new DeterministicFakeHarnessAdapter();
    let providerCalls = 0;
    const server = createArenaServer({
      databasePath,
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => delegate.validateModelProfile(input),
        smokeModel: (modelProfile) => delegate.smokeModel(modelProfile),
        evolvePlugin: async (request) => {
          providerCalls += 1;
          if (providerCalls === 1) return delegate.evolvePlugin(request);
          throw new HarnessInvocationError("受控失败", kind, { tokens: 7, cost: 0.27 }, {
            kind: "fake",
            protocolVersion: 1,
            sessionId: request.sessionId,
            harnessVersion: "fake",
            providerId: request.modelProfile.providerId,
            modelId: request.modelProfile.modelId,
          });
        },
      },
    });
    servers.push(server);
    const experiment = await createExperiment(server, `${kind} 用量合并`);
    await validateAndConfirm(server, experiment.id);
    await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });
    let snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` }))
      .json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    for (let attempt = 0; attempt < 500 && snapshot.state !== "paused"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    }

    expect(providerCalls).toBe(expectedCalls);
    expect(snapshot).toMatchObject({ state: "paused", generation: 0, usage: { tokens, cost } });
  }, 20_000);

  it.each([
    ["deterministic-fixture", "2026.09.fixture"],
    ["real-provider", "2026.09.real"],
  ] as const)("失败审计保留 %s 的结构化执行身份且不记录模型自由文本", async (kind, harnessVersion) => {
    const delegate = new DeterministicFakeHarnessAdapter();
    const server = createArenaServer({
      databasePath: ":memory:",
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => delegate.validateModelProfile(input),
        smokeModel: (modelProfile) => delegate.smokeModel(modelProfile),
        evolvePlugin: async (request) => {
          throw new HarnessInvocationError("sk-secret-value-must-not-persist", "protocol", { tokens: 37, cost: 0.25 }, {
            kind,
            protocolVersion: 1,
            sessionId: request.sessionId,
            harnessVersion,
            providerId: request.modelProfile.providerId,
            modelId: request.modelProfile.modelId,
          });
        },
      },
    });
    servers.push(server);
    const experiment = await createExperiment(server, `${kind} 失败审计`);
    await validateAndConfirm(server, experiment.id);
    await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });
    let snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` }))
      .json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    for (let attempt = 0; attempt < 300 && snapshot.state !== "paused"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      snapshot = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/runtime` })).json();
    }

    expect(snapshot).toMatchObject({ state: "paused", usage: { tokens: 37, cost: 0.25 } });
    const audit = await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/audit-events` });
    const activity = audit.json<import("@maze-arena/contracts").ExperimentAuditEventPage>().events
      .find(({ type }) => type === "harness.activity");
    expect(activity?.details).toMatchObject({
      executionKind: kind,
      protocolVersion: 1,
      harnessVersion,
      providerId: "fake-basic",
      modelId: "compact-v1",
      outcome: "failed",
      failureKind: "protocol",
      usageTokens: 37,
      usageCost: 0.25,
    });
    expect(audit.body).not.toContain("sk-secret-value-must-not-persist");
    expect(audit.body).not.toContain("reasoning");
    expect(audit.body).not.toContain("toolActivity");
  });

  it("比较克隆继承密封套件且展示局不改变代次、冠军或用量", async () => {
    const server = createTestServer(":memory:");
    const source = await createExperiment(server, "源实验");
    await server.inject({ method: "POST", url: `/api/experiments/${source.id}/baseline-validation/run`, payload: {} });
    await server.inject({ method: "POST", url: `/api/experiments/${source.id}/baseline-validation/confirm`, payload: {} });
    const sourceRuntime = (await server.inject({ method: "GET", url: `/api/experiments/${source.id}/runtime` })).json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
    const {
      providerLabel: _providerLabel,
      modelLabel: _modelLabel,
      catalogIdentity: _catalogIdentity,
      catalogCapabilities: _catalogCapabilities,
      ...modelProfile
    } = source.modelProfile!;
    const cloned = await server.inject({
      method: "POST", url: `/api/experiments/${source.id}/comparison-clones`, payload: { name: "公平比较克隆", modelProfile, costLimit: 0.75 },
    });
    expect(cloned.statusCode).toBe(200);
    expect(cloned.json()).toMatchObject({
      evaluationSuiteId: sourceRuntime.evaluationSuiteId, sealGroupId: sourceRuntime.sealGroupId,
      compatibilityFingerprint: sourceRuntime.compatibilityFingerprint, sealed: true,
      budget: { tokenLimit: modelProfile.totalTokenLimit, costLimit: 0.75 },
    });
    const childId = cloned.json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>().experimentId;
    expect((await server.inject({ method: "GET", url: `/api/experiments/${childId}/baseline-validation` })).json())
      .toMatchObject({ status: "ready", frozenConfiguration: {
        modelProfile: { providerId: modelProfile.providerId }, tokenLimit: modelProfile.totalTokenLimit, costLimit: 0.75,
      } });

    const experimentCount = (await server.inject({ method: "GET", url: "/api/experiments" })).json<ExperimentListResponse>().experiments.length;
    const failedFork = await server.inject({
      method: "POST", url: `/api/experiments/${source.id}/continuation-forks`,
      payload: { name: "不完整分支", modelProfile, generatorCommit: sourceRuntime.champions.generator, solverCommit: "0".repeat(40) },
    });
    expect(failedFork.statusCode).toBe(409);
    expect((await server.inject({ method: "GET", url: "/api/experiments" })).json<ExperimentListResponse>().experiments)
      .toHaveLength(experimentCount);

    const before = (await server.inject({ method: "GET", url: `/api/experiments/${source.id}/runtime` })).json();
    const exhibition = await server.inject({
      method: "POST", url: `/api/experiments/${source.id}/exhibitions`,
      payload: { generatorCommit: sourceRuntime.champions.generator, solverCommit: sourceRuntime.champions.solver, publicSeed: "public-demo" },
    });
    expect(exhibition.statusCode).toBe(202);
    const after = (await server.inject({ method: "GET", url: `/api/experiments/${source.id}/runtime` })).json();
    expect(after).toEqual(before);
  });

  it("密封期间隐藏比赛列表只显示聚合元数据且所有单场事件入口拒绝读取", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-hidden-api-"));
    const databasePath = join(directory, "arena.sqlite");
    const server = createTestServer(databasePath);
    const experiment = await createExperiment(server, "隐藏评测实验");
    await validateAndConfirm(server, experiment.id);
    const started = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: { seed: "hidden-secret" } });
    const match = started.json<import("@maze-arena/contracts").ArenaMatch>();
    let completed = match;
    for (let attempt = 0; attempt < 100 && completed.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` })).json();
    }
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE matches SET observation_json = ? WHERE id = ?").run(JSON.stringify({
      id: match.id, generation: 1, role: "generator", opponent: "sealed-opponent",
      evaluationType: "hidden", result: "won", replayable: true,
    }), match.id);
    database.close();
    const list = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/matches` })).json<import("@maze-arena/contracts").MatchListResponse>();
    expect(list.matches[0]).toMatchObject({ seed: "[sealed]", observation: { evaluationType: "hidden", replayable: false } });
    expect((await server.inject({ method: "GET", url: `/api/matches/${match.id}/events` })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: `/api/matches/${match.id}/raw-events` })).statusCode).toBe(403);
    const hiddenSocket = await server.injectWS(`/api/matches/${match.id}/live`);
    const closeCode = await new Promise<number>((resolve) => hiddenSocket.once("close", resolve));
    expect(closeCode).toBe(1008);
  });
  it("后台分批提交比赛事件，轮询可观察真实缓冲且不等待动画", async () => {
    const server = createArenaServer({
      databasePath: ":memory:", harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: deterministicMatchRunner,
      matchBatchSize: 40, matchBatchDelayMs: 15,
    });
    servers.push(server);
    const experiment = await createExperiment(server, "基线比赛实验");
    const response = await server.inject({
      method: "POST",
      url: `/api/experiments/${experiment.id}/matches/baseline`,
      payload: { seed: "api-seed" },
    });

    expect(response.statusCode).toBe(202);
    const match = response.json<import("@maze-arena/contracts").ArenaMatch>();
    expect(match).toMatchObject({ status: "running", committedEventCount: 0, score: null });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstPage = await server.inject({ method: "GET", url: `/api/matches/${match.id}/events?after=0&limit=256` });
    const partial = firstPage.json<import("@maze-arena/contracts").MatchEventPage>();
    expect(partial.match.committedEventCount).toBeGreaterThan(0);
    expect(partial.match.status).toBe("running");
    expect(partial.events[0]?.sequence).toBe(1);

    let metadata = partial.match;
    for (let attempt = 0; attempt < 60 && metadata.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      metadata = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` })).json();
    }
    expect(metadata).toMatchObject({ status: "completed", score: { solved: true } });
    expect(metadata.committedEventCount).toBe(metadata.totalEventCount);
  });

  it("延迟 runner 在完成前返回 202，并在运行中递增提交事件", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = {
      run: async (seed: string, onEvents?: (events: readonly import("@maze-arena/contracts").MatchEvent[]) => Promise<void> | void) => {
        const result = runBaselineMatch(seed);
        await onEvents?.(result.events.slice(0, 1));
        await gate;
        await onEvents?.(result.events.slice(1));
        return result;
      },
    };
    const server = createArenaServer({
      databasePath: ":memory:", harnessAdapter: new DeterministicFakeHarnessAdapter(), matchRunner: runner,
      matchBatchDelayMs: 0,
    });
    servers.push(server);
    const experiment = await createExperiment(server, "延迟原生比赛");

    const response = await Promise.race([
      server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: { seed: "slow-seed" } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("202 未在 runner 完成前返回")), 200)),
    ]);
    expect(response.statusCode).toBe(202);
    const match = response.json<import("@maze-arena/contracts").ArenaMatch>();
    const partial = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` }))
      .json<import("@maze-arena/contracts").ArenaMatch>();
    expect(partial).toMatchObject({ status: "running", committedEventCount: 1, totalEventCount: 1 });

    release();
    let completed = partial;
    for (let attempt = 0; attempt < 40 && completed.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` })).json();
    }
    expect(completed.status).toBe("completed");
    expect(completed.committedEventCount).toBeGreaterThan(partial.committedEventCount);
  });

  it("runner 失败后保留已提交事件并写入稳定 failed 终态", async () => {
    const runner = {
      run: async (seed: string, onEvents?: (events: readonly import("@maze-arena/contracts").MatchEvent[]) => Promise<void> | void) => {
        await onEvents?.(runBaselineMatch(seed).events.slice(0, 1));
        throw new Error("受控 runner 故障");
      },
    };
    const server = createArenaServer({
      databasePath: ":memory:", harnessAdapter: new DeterministicFakeHarnessAdapter(), matchRunner: runner,
    });
    servers.push(server);
    const experiment = await createExperiment(server, "失败原生比赛");
    const started = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: {} });
    const match = started.json<import("@maze-arena/contracts").ArenaMatch>();

    let failed = match;
    for (let attempt = 0; attempt < 40 && failed.status !== "failed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      failed = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` })).json();
    }
    expect(failed).toMatchObject({ status: "failed", committedEventCount: 1, totalEventCount: 1, score: null });
  });

  it("WebSocket 断线后以最后确认序号从 SQLite 补齐且不重不漏", async () => {
    const server = createArenaServer({
      databasePath: ":memory:", harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: deterministicMatchRunner, matchBatchSize: 12, matchBatchDelayMs: 5,
    });
    servers.push(server);
    const experiment = await createExperiment(server, "断线恢复比赛");
    const started = await server.inject({
      method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: { seed: "reconnect-seed" },
    });
    const match = started.json<import("@maze-arena/contracts").ArenaMatch>();
    await server.ready();

    const firstSocket = await server.injectWS(`/api/matches/${match.id}/live?after=0`);
    const firstDelivery = await new Promise<import("@maze-arena/contracts").MatchEventDelivery>((resolve) => {
      firstSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    expect(firstDelivery.page.events[0]?.sequence).toBe(1);
    const acknowledged = firstDelivery.page.nextSequence;
    firstSocket.send(JSON.stringify({ type: "match.ack", sequence: acknowledged }));
    firstSocket.close();

    const secondSocket = await server.injectWS(`/api/matches/${match.id}/live?after=${acknowledged}`);
    const received = [...firstDelivery.page.events];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("断线恢复未收到完成事件")), 2_000);
      secondSocket.on("message", (data) => {
        const delivery = JSON.parse(data.toString()) as import("@maze-arena/contracts").MatchEventDelivery;
        received.push(...delivery.page.events);
        secondSocket.send(JSON.stringify({ type: "match.ack", sequence: delivery.page.nextSequence }));
        if (delivery.page.match.status === "completed") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    secondSocket.close();
    expect(received.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: received.length }, (_, index) => index + 1),
    );
    expect(received.at(-1)?.type).toBe("match.completed");
  });

  it("比赛事件与带真实时间的审计事件分表读取", async () => {
    const server = createTestServer(":memory:");
    const experiment = await createExperiment(server, "审计分离实验");
    const started = await server.inject({
      method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: { seed: "audit-seed" },
    });
    const match = started.json<import("@maze-arena/contracts").ArenaMatch>();
    let metadata = match;
    for (let attempt = 0; attempt < 60 && metadata.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      metadata = (await server.inject({ method: "GET", url: `/api/matches/${match.id}` })).json();
    }
    const events = (await server.inject({ method: "GET", url: `/api/matches/${match.id}/events` }))
      .json<import("@maze-arena/contracts").MatchEventPage>();
    const audit = (await server.inject({ method: "GET", url: `/api/experiments/${experiment.id}/audit-events` }))
      .json<import("@maze-arena/contracts").ExperimentAuditEventPage>();
    const remoteAudit = await server.inject({
      method: "GET", url: `/api/experiments/${experiment.id}/audit-events`, remoteAddress: "203.0.113.10",
    });
    expect(events.events.every((event) => !("occurredAt" in event))).toBe(true);
    expect(audit.events.map(({ type }) => type)).toEqual(["match.started", "match.completed"]);
    expect(audit.events.every(({ occurredAt }) => /^\d{4}-\d{2}-\d{2}T/.test(occurredAt))).toBe(true);
    expect(remoteAudit.statusCode).toBe(403);
  });

  it.each(["paused", "completed", "failed", "cancelled"] as const)("%s 实验拒绝运行基线比赛", async (status) => {
    const directory = mkdtempSync(join(tmpdir(), "maze-terminal-match-"));
    const databasePath = join(directory, "arena.sqlite");
    const server = createTestServer(databasePath);
    const experiment = await createExperiment(server, `${status} 实验`);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE experiments SET status = ? WHERE id = ?").run(status, experiment.id);
    database.close();

    const response = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json<DomainErrorResponse>()).toEqual({
      error: { code: "INVALID_EXPERIMENT_STATE", message: `实验当前状态 ${status} 不允许运行基线比赛` },
    });
  });

  it("权威数据损坏时 API 返回稳定错误而不泄漏冲突事实", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-corrupt-api-"));
    const databasePath = join(directory, "arena.sqlite");
    const server = createArenaServer({
      databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter(), matchRunner: deterministicMatchRunner, matchBatchDelayMs: 25,
    });
    servers.push(server);
    const experiment = await createExperiment(server, "损坏读取实验");
    const started = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/matches/baseline`, payload: {} });
    const match = started.json<import("@maze-arena/contracts").ArenaMatch>();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE matches SET protocol_version = 9 WHERE id = ?").run(match.id);
    database.close();

    const response = await server.inject({ method: "GET", url: `/api/matches/${match.id}` });
    expect(response.statusCode).toBe(500);
    expect(response.json<DomainErrorResponse>()).toEqual({
      error: { code: "MATCH_DATA_CORRUPT", message: "比赛权威数据损坏：比赛元数据非法" },
    });
  });

  it("创建草稿并通过列表和详情读取公共实验字段", async () => {
    const server = createTestServer(":memory:");

    const created = await createExperiment(server, "生成器基线实验");
    const list = await server.inject({ method: "GET", url: "/api/experiments" });
    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });

    expect(created).toMatchObject({ name: "生成器基线实验", status: "draft" });
    expect(created.modelProfile).toMatchObject({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      providerLabel: "确定性基础提供方",
    });
    expect(created.harnessEnvironments.generator.home).not.toBe(created.harnessEnvironments.solver.home);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list.json<ExperimentListResponse>()).toEqual({ experiments: [created] });
    expect(detail.json<Experiment>()).toEqual(created);
  });

  it("可选成本上限随实验冻结并进入可信运行时预算", async () => {
    const server = createTestServer(":memory:");
    const created = await createExperiment(server, "成本预算实验", 0.5);
    await validateAndConfirm(server, created.id);

    expect(created.costLimit).toBe(0.5);
    expect((await server.inject({ method: "GET", url: `/api/experiments/${created.id}/baseline-validation` })).json())
      .toMatchObject({ frozenConfiguration: { tokenLimit: 5_000, costLimit: 0.5 } });
    expect((await server.inject({ method: "GET", url: `/api/experiments/${created.id}/runtime` })).json())
      .toMatchObject({ budget: { tokenLimit: 5_000, costLimit: 0.5 } });

    const invalid = await server.inject({
      method: "POST", url: "/api/experiments", payload: {
        name: "非法成本预算", costLimit: 0, modelProfile: {
          providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
          contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
        },
      },
    });
    expect(invalid).toMatchObject({ statusCode: 400 });
    expect(invalid.json<DomainErrorResponse>().error.code).toBe("EXPERIMENT_BUDGET_INVALID");
  });

  it("暴露 Harness 模型能力，并在保存前返回逐字段配置错误", async () => {
    const server = createTestServer(":memory:");
    const catalog = await server.inject({ method: "GET", url: "/api/harness/models" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ credentialRefs: ["dsh-credential://basic", "dsh-credential://reasoning"], providers: [
      { id: "fake-basic", models: [{ id: "compact-v1", capabilities: { reasoningEfforts: [] } }] },
      { id: "fake-reasoning", models: [{ id: "reasoner-v1", capabilities: { reasoningEfforts: ["low", "medium", "high"] } }] },
    ] });

    const response = await server.inject({
      method: "POST",
      url: "/api/experiments",
      payload: {
        name: "无效配置",
        modelProfile: {
          providerId: "fake-basic",
          modelId: "compact-v1",
          credentialRef: "dsh-credential://basic",
          reasoningEffort: "high",
          contextTokens: 20_000,
          outputTokens: 1_000,
          totalTokenLimit: 21_000,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "MODEL_PROFILE_INVALID",
        message: "模型配置档无效",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "reasoningEffort" }),
          expect.objectContaining({ path: "contextTokens" }),
        ]),
      },
    });
  });

  it("草稿可替换模型配置，启动后拒绝修改并保持原配置", async () => {
    const server = createTestServer(":memory:");
    const created = await createExperiment(server, "冻结配置实验");
    const replacement = {
      providerId: "fake-reasoning",
      modelId: "reasoner-v1",
      credentialRef: "dsh-credential://reasoning",
      reasoningEffort: "medium" as const,
      contextTokens: 16_000,
      outputTokens: 2_000,
      totalTokenLimit: 20_000,
      providerOptions: { thinkingBudget: 4_000 },
    };
    const updated = await server.inject({
      method: "PUT",
      url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: replacement },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<Experiment>().modelProfile).toMatchObject(replacement);

    await validateAndConfirm(server, created.id);
    const rejected = await server.inject({
      method: "PUT",
      url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: { ...replacement, reasoningEffort: "high" } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<DomainErrorResponse>()).toEqual({
      error: { code: "MODEL_PROFILE_FROZEN", message: "实验启动后模型配置档已冻结；修改配置必须创建新实验" },
    });

    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });
    expect(detail.json<Experiment>().modelProfile?.reasoningEffort).toBe("medium");
  });

  it("创建时冻结目录能力快照，后续目录删除不影响基线与启动", async () => {
    const delegate = new DeterministicFakeHarnessAdapter();
    let enabled = true;
    const server = createArenaServer({
      databasePath: ":memory:",
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => {
          if (!enabled) {
            throw new ModelProfileValidationError([{ path: "providerId", message: "提供方已停用" }]);
          }
          return delegate.validateModelProfile(input);
        },
      },
    });
    servers.push(server);
    const created = await createExperiment(server, "能力漂移实验");
    expect(created.modelProfile).toMatchObject({
      catalogIdentity: expect.stringMatching(/^sha256:/),
      catalogCapabilities: { maxContextTokens: 8_000, maxOutputTokens: 2_000 },
    });
    enabled = false;

    const edited = await server.inject({
      method: "PUT",
      url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: {
        providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
        contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
      } },
    });
    expect(edited.statusCode).toBe(400);

    await validateAndConfirm(server, created.id);
    const response = await server.inject({ method: "POST", url: `/api/experiments/${created.id}/start` });

    expect(response.statusCode).toBe(200);
    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });
    expect(detail.json<Experiment>()).toMatchObject({ status: "paused", modelProfile: created.modelProfile });
  });

  it("基线冻结后目录变化不改变实验模型配置且不阻止启动", async () => {
    const delegate = new DeterministicFakeHarnessAdapter();
    let enabled = true;
    const server = createArenaServer({
      databasePath: ":memory:",
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => enabled ? delegate.listModels() : { credentialRefs: [], providers: [] },
        validateModelProfile: (input) => {
          if (!enabled) throw new ModelProfileValidationError([{ path: "providerId", message: "目录已更新" }]);
          return delegate.validateModelProfile(input);
        },
      },
    });
    servers.push(server);
    const created = await createExperiment(server, "冻结目录实验");
    await validateAndConfirm(server, created.id);
    enabled = false;

    const response = await server.inject({ method: "POST", url: `/api/experiments/${created.id}/start` });

    expect(response.statusCode).toBe(200);
    expect(response.json<Experiment>()).toMatchObject({
      status: "running",
      modelProfile: created.modelProfile,
    });
  });

  it("服务关闭并重新打开后仍能从 SQLite 恢复实验", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-"));
    const databasePath = join(directory, "arena.sqlite");
    const firstServer = createTestServer(databasePath);
    const created = await createExperiment(firstServer, "重启恢复实验");
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restartedServer = createTestServer(databasePath);
    const response = await restartedServer.inject({ method: "GET", url: "/api/experiments" });

    expect(response.json<ExperimentListResponse>()).toEqual({ experiments: [created] });
  });

  it("从 Ticket 01 schema 事务迁移且重启后保留旧实验", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-migration-"));
    const databasePath = join(directory, "arena.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_running_experiment ON experiments ((status = 'running')) WHERE status = 'running';`);
    legacy.prepare("INSERT INTO experiments (id, name, status, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy-id", "Ticket 01 实验", "draft", "2026-09-01T00:00:00.000Z");
    legacy.close();

    const firstServer = createTestServer(databasePath);
    const migrated = await firstServer.inject({ method: "GET", url: "/api/experiments/legacy-id" });
    expect(migrated.json<Experiment>()).toMatchObject({
      id: "legacy-id",
      name: "Ticket 01 实验",
      modelProfile: null,
      harnessEnvironments: {
        generator: { home: expect.stringContaining("legacy-id/generator/home") },
        solver: { home: expect.stringContaining("legacy-id/solver/home") },
      },
    });
    const blocked = await firstServer.inject({ method: "POST", url: "/api/experiments/legacy-id/start" });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<DomainErrorResponse>().error.issues).toContainEqual(expect.objectContaining({ path: "modelProfile" }));
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restarted = createTestServer(databasePath);
    const restored = await restarted.inject({ method: "GET", url: "/api/experiments/legacy-id" });
    expect(restored.json<Experiment>()).toMatchObject({ id: "legacy-id", name: "Ticket 01 实验", modelProfile: null });
  });

  it("基线确认后冻结配置并拒绝另一连接通过公共 API 替换", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-freeze-"));
    const databasePath = join(directory, "arena.sqlite");
    const delegate = new DeterministicFakeHarnessAdapter();
    let attack = false;
    const server = createArenaServer({
      databasePath,
      matchRunner: deterministicMatchRunner,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => {
          const validated = delegate.validateModelProfile(input);
          return validated;
        },
      },
    });
    servers.push(server);
    const createdResponse = await server.inject({
      method: "POST",
      url: "/api/experiments",
      payload: {
        name: "原子冻结",
        modelProfile: {
          providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
          contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
        },
      },
    });
    const created = createdResponse.json<Experiment>();
    await validateAndConfirm(server, created.id);
    attack = true;
    const rejected = await server.inject({
      method: "PUT", url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: { ...created.modelProfile, providerId: "tampered" } },
    });
    expect(rejected.statusCode).toBe(409);
    expect((await server.inject({ method: "GET", url: `/api/experiments/${created.id}` })).json<Experiment>())
      .toMatchObject({ status: "draft", modelProfile: { providerId: "fake-basic" } });
  });

  it("生产入口只读取版本化 Harness 导出且不会暴露 fake catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-harness-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{
        id: "configured-provider", label: "Configured", models: [{
          id: "configured-model", label: "Configured Model", capabilities: {
            reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
            maxTotalTokens: 9_000, providerOptions: {},
          },
        }],
      }],
    }));

    const production = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath,
      DSH_HARNESS_VERSION: "2026.09-preview.1",
      DSH_EVOLUTION_COMMAND: "/bin/false",
      DSH_SMOKE_COMMAND: "/bin/false",
    });
    expect(production.listModels().providers.map(({ id }) => id)).toEqual(["configured-provider"]);
    const updated = JSON.parse(readFileSync(exportPath, "utf8"));
    updated.credentialRefs = ["dsh-credential://replacement"];
    updated.providers[0].id = "replacement-provider";
    writeFileSync(exportPath, JSON.stringify(updated));
    expect(production.listModels()).toMatchObject({
      credentialRefs: ["dsh-credential://replacement"],
      providers: [{ id: "replacement-provider" }],
    });
    expect(() => createProductionHarnessAdapter({})).toThrow(/必须配置/);
    expect(() => createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath,
      DSH_HARNESS_VERSION: "2026.09-preview.1",
      DSH_EVOLUTION_COMMAND: "/bin/false",
    })).toThrow(/DSH_SMOKE_COMMAND/);
  });

  it("API 拒绝目录中的敏感 provider option 且响应不回显", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-secret-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{
        id: "model", label: "Model", capabilities: {
          reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
          maxTotalTokens: 9_000, providerOptions: { apiKey: { type: "string" } },
        },
      }] }],
    }));
    const server = createArenaServer({
      databasePath: ":memory:",
      matchRunner: deterministicMatchRunner,
      harnessAdapter: createProductionHarnessAdapter({
        ARENA_MODEL_CATALOG_PATH: exportPath,
        DSH_HARNESS_VERSION: "2026.09-preview.1",
        DSH_EVOLUTION_COMMAND: "/bin/false",
        DSH_SMOKE_COMMAND: "/bin/false",
      }),
    });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/harness/models" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("provider");
    expect(response.body).not.toContain("apiKey");
  });

  it("生产 Harness 通过无 shell JSON 进程桥接返回可信用量与实际 reasoning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-evolve-"));
    const exportPath = join(directory, "models.json");
    const commandPath = join(directory, "evolve.mjs");
    const smokePath = join(directory, "smoke.mjs");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, `#!/usr/bin/env node\nlet input="";for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);process.stdout.write(JSON.stringify({type:"maze-arena.harness-evolution.response",protocolVersion:1,sessionId:request.session.id,result:{hypothesis:request.attempt.attemptId,strategyPlan:"plan",submitted:true,reasoning:"provider reasoning",toolActivity:"read,test"},usage:{tokens:321,cost:0.12}}));\n`);
    writeFileSync(smokePath, `#!/usr/bin/env node\nlet input="";for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);process.stdout.write(JSON.stringify({providerText:request.modelProfile.modelId+":"+process.env.DSH_HARNESS_OPERATION}));\n`);
    chmodSync(commandPath, 0o755);
    chmodSync(smokePath, 0o755);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: smokePath,
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model", credentialRef: "dsh-credential://production",
      contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ experimentId: "exp", generation: 1, role: "generator", attemptId: "attempt-1",
      modelProfile, workspace: directory, repairAttempt: 0, diagnostics: [] }))).resolves.toMatchObject({
      hypothesis: "attempt-1", usage: { tokens: 321, cost: 0.12 }, reasoning: "provider reasoning",
      execution: { kind: "real-provider", protocolVersion: 1, providerId: "provider", modelId: "model" },
    });
    await expect(adapter.smokeModel!(modelProfile)).resolves.toMatchObject({ providerText: "model:smoke" });
  });

  it("生产 Harness 每次调用前复核实例快照，依赖载荷漂移后关闭失败", async () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), "maze-frozen-harness-"));
    const exportPath = join(runtimeRoot, "models.json");
    const commandPath = join(runtimeRoot, "harness.mjs");
    const dependencyPath = join(runtimeRoot, "runtime-dependency.txt");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(dependencyPath, "A\n");
    writeFileSync(commandPath, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ providerText: readFileSync(${JSON.stringify(dependencyPath)}, "utf8").trim() })));
`);
    chmodSync(commandPath, 0o755);
    const payloadSha256 = hashHarnessRuntimePayload(runtimeRoot);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath,
      DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath,
      DSH_SMOKE_COMMAND: commandPath,
      DSH_HARNESS_RUNTIME_ROOT: runtimeRoot,
      DSH_HARNESS_RUNTIME_SHA256: payloadSha256,
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });

    await expect(adapter.smokeModel!(modelProfile)).resolves.toEqual({ providerText: "A" });
    writeFileSync(dependencyPath, "B\n");
    await expect(adapter.smokeModel!(modelProfile)).rejects.toThrow(/Harness runtime 冻结载荷身份已漂移/);
  });

  it("确定性 Harness 夹具通过生产会话协议在空 home 和净化工作区中实际编辑源码", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-deterministic-protocol-"));
    const exportPath = join(directory, "models.json");
    const workspace = join(directory, "workspace");
    const globalHome = join(directory, "global-home");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(globalHome);
    writeFileSync(join(globalHome, "readonly.txt"), "locked");
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0" }));
    writeFileSync(join(workspace, "src/index.ts"), "export const baseline = true;\n");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    const commandPath = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/deterministic-evolution-harness.mjs");
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: "/bin/false",
      DSH_EVOLUTION_EXECUTION_KIND: "deterministic-fixture",
      DSH_HOME: globalHome,
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });

    const request = productionEvolutionRequest({
      experimentId: "exp", generation: 1, role: "generator", attemptId: "deterministic-1",
      modelProfile, workspace, repairAttempt: 0, diagnostics: [],
    });
    const response = await adapter.evolvePlugin!(request);

    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toContain("deterministicEvolutionAttempt");
    expect(existsSync(join(workspace, "dist"))).toBe(false);
    expect(readFileSync(join(globalHome, "readonly.txt"), "utf8")).toBe("locked");
    expect(readFileSync(join(request.home, "session-write.txt"), "utf8")).toBe("allowed");
    expect(response).toMatchObject({
      submitted: true,
      usage: { tokens: 64, cost: 0 },
      execution: { kind: "deterministic-fixture", protocolVersion: 1, harnessVersion: "2026.09.2" },
    });
    expect(response.execution.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const forbidden = productionEvolutionRequest({
      experimentId: "exp", generation: 2, role: "generator", attemptId: "deterministic-2",
      modelProfile, workspace, repairAttempt: 0, diagnostics: [],
    });
    forbidden.input = { ...forbidden.input, opponentSource: "forbidden-opponent-source" } as never;
    await expect(adapter.evolvePlugin!(forbidden)).rejects.toThrow(/反馈协议字段非法/);
  });

  it.each(["generator", "solver"] as const)("生产 Harness 严格校验 %s 反馈身份与隐藏聚合不变量", async (role) => {
    const directory = mkdtempSync(join(tmpdir(), `maze-feedback-protocol-${role}-`));
    const exportPath = join(directory, "models.json");
    const workspace = join(directory, `workspace-${role}-临界`);
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0" }));
    writeFileSync(join(workspace, "src/index.ts"), "export const baseline = true;\n");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/deterministic-evolution-harness.mjs"),
      DSH_SMOKE_COMMAND: "/bin/false", DSH_EVOLUTION_EXECUTION_KIND: "deterministic-fixture",
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    const attemptId = `g0001-${role}`;
    const hiddenMetrics: Record<string, number> = role === "generator"
      ? { gateFailures: 0, failedCases: 1, extraActions: 2, structuralNovelty: 3 }
      : { solvedCases: 1, extraActions: 2, illegalActions: 0 };
    const validInput: HarnessEvolutionRequest["input"] = {
      role, championRoot: workspace,
      lineagePlans: [{ attemptId, strategyPlan: `己方策略-${role}` }],
      trustedResults: [{ attemptId, generation: 1, role, outcome: "tie", publicCaseCount: 8, hiddenCaseCount: 24,
        totalCandidateAggregate: { primary: 1 }, hiddenCandidateAggregate: hiddenMetrics }],
      publicTraces: [{ attemptId, generation: 1, traceId: "public-01", outcome: "success", metrics: { primary: 1 },
        events: [{ type: "maze.completed", passageCount: 960 }] }],
      hiddenAggregate: { completedAttemptCount: 1, metricAvailableAttemptCount: 1, metricUnavailableAttemptCount: 0,
        promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 1,
        evaluatedHiddenCaseCount: 24, metricTotals: hiddenMetrics },
    };
    const request = (input: unknown, generation = 3) => {
      const value = productionEvolutionRequest({ experimentId: "exp", generation, role,
        attemptId: `protocol-${role}`, modelProfile, workspace, repairAttempt: 0, diagnostics: [] });
      value.input = input as HarnessEvolutionRequest["input"];
      return value;
    };
    const otherRole = role === "generator" ? "solver" : "generator";
    const foreignHiddenMetric = role === "generator" ? { solvedCases: 1 } : { failedCases: 1 };
    await expect(adapter.evolvePlugin!(request({
      ...validInput,
      lineagePlans: [{ attemptId, strategyPlan: `${"策".repeat(2_730)}ab` }],
    }))).resolves.toMatchObject({ submitted: true });
    const invalidInputs: unknown[] = [
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], unknownNested: { opponentText: "禁止的对手文本" } }] },
      { ...validInput, publicTraces: [{ ...validInput.publicTraces[0], events: [{ ...validInput.publicTraces[0]!.events[0], opponentComments: "禁止的对手注释" }] }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], attemptId: `g0001-${otherRole}` }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], role: otherRole }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], generation: 3, attemptId: `g0003-${role}` }] },
      { ...validInput, publicTraces: [{ ...validInput.publicTraces[0], attemptId: `g0001-${otherRole}` }] },
      { ...validInput, hiddenAggregate: { ...validInput.hiddenAggregate,
        metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 1, metricTotals: { forgedHiddenTotal: 1 } } },
      { ...validInput, hiddenAggregate: { ...validInput.hiddenAggregate,
        promotedAttemptCount: 1, failedAttemptCount: 0, tieAttemptCount: 1 } },
      { ...validInput, hiddenAggregate: { ...validInput.hiddenAggregate, completedAttemptCount: 0,
        metricAvailableAttemptCount: 0, promotedAttemptCount: 0, tieAttemptCount: 0,
        evaluatedHiddenCaseCount: 0, metricTotals: {} } },
      { ...validInput, hiddenAggregate: { ...validInput.hiddenAggregate, evaluatedHiddenCaseCount: 23 } },
      { ...validInput, hiddenAggregate: { ...validInput.hiddenAggregate, metricTotals: { ...hiddenMetrics, extraActions: 3 } } },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], hiddenCandidateAggregate: { caseId: 12345 } }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], hiddenCandidateAggregate: foreignHiddenMetric }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], hiddenCandidateAggregate: { extraActions: 0.1 } }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], hiddenCaseCount: 0 }],
        hiddenAggregate: { completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
          promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0, evaluatedHiddenCaseCount: 0, metricTotals: {} } },
      { ...validInput, publicTraces: [validInput.publicTraces[0], { ...validInput.publicTraces[0] }] },
      { ...validInput, trustedResults: [validInput.trustedResults[0], { ...validInput.trustedResults[0] }] },
      { ...validInput, lineagePlans: [{ attemptId, strategyPlan: "策".repeat(HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES / 3 + 1) }] },
      { ...validInput, trustedResults: [{ ...validInput.trustedResults[0], totalCandidateAggregate: Object.fromEntries(
        Array.from({ length: HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS + 1 }, (_, index) => [`metric${index}`, index]),
      ) }] },
      { ...validInput, publicTraces: [{ ...validInput.publicTraces[0], events: Array.from(
        { length: HARNESS_EVOLUTION_MAX_TRACE_EVENTS + 1 }, () => ({ type: "maze.completed", passageCount: 960 }),
      ) }] },
      { ...validInput, trustedResults: [], lineagePlans: [], publicTraces: [] },
      { ...validInput, role: otherRole },
    ];

    for (const input of invalidInputs) {
      await expect(adapter.evolvePlugin!(request(input))).rejects.toThrow(/反馈协议字段非法|输入角色或冠军工作区/);
    }

    await expect(adapter.evolvePlugin!(request({
      ...validInput,
      trustedResults: validInput.trustedResults.map(({ hiddenCandidateAggregate: _hidden, ...legacy }) => legacy),
      hiddenAggregate: { ...validInput.hiddenAggregate,
        metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 1, metricTotals: {} },
    }))).resolves.toMatchObject({ submitted: true });
    await expect(adapter.evolvePlugin!(request({
      ...validInput, trustedResults: [], lineagePlans: [], publicTraces: [],
      hiddenAggregate: { completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
        promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
        evaluatedHiddenCaseCount: 0, metricTotals: {} },
    }))).resolves.toMatchObject({ submitted: true });
    const mixedResults = [
      validInput.trustedResults[0],
      { attemptId: `g0002-${role}`, generation: 2, role, outcome: "failed" as const,
        publicCaseCount: 8, hiddenCaseCount: 4, totalCandidateAggregate: { primary: 0 } },
    ];
    await expect(adapter.evolvePlugin!(request({
      ...validInput, trustedResults: mixedResults,
      hiddenAggregate: { completedAttemptCount: 2, metricAvailableAttemptCount: 1, metricUnavailableAttemptCount: 1,
        promotedAttemptCount: 0, failedAttemptCount: 1, tieAttemptCount: 1,
        evaluatedHiddenCaseCount: 28, metricTotals: hiddenMetrics },
    }))).resolves.toMatchObject({ submitted: true });
    await expect(adapter.evolvePlugin!(request({
      ...validInput, trustedResults: mixedResults,
      hiddenAggregate: { completedAttemptCount: 2, metricAvailableAttemptCount: 1, metricUnavailableAttemptCount: 1,
        promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 2,
        evaluatedHiddenCaseCount: 28, metricTotals: hiddenMetrics },
    }))).rejects.toThrow(/反馈协议字段非法/);
    await expect(adapter.evolvePlugin!(request({
      ...validInput, trustedResults: [...mixedResults].reverse(),
      hiddenAggregate: { completedAttemptCount: 2, metricAvailableAttemptCount: 1, metricUnavailableAttemptCount: 1,
        promotedAttemptCount: 0, failedAttemptCount: 1, tieAttemptCount: 1,
        evaluatedHiddenCaseCount: 28, metricTotals: hiddenMetrics },
    }))).rejects.toThrow(/反馈协议字段非法/);
    await expect(adapter.evolvePlugin!(request({
      ...validInput,
      trustedResults: [
        { ...validInput.trustedResults[0], hiddenCaseCount: Number.MAX_SAFE_INTEGER },
        { ...mixedResults[1], hiddenCaseCount: 1 },
      ],
    }))).rejects.toThrow(/反馈协议字段非法/);
    const nonAssociativeValues = [10 ** 16, 1, -(10 ** 16)];
    const nonAssociativeResults = nonAssociativeValues.map((value, index) => ({
      attemptId: `g${String(index + 1).padStart(4, "0")}-${role}`,
      generation: index + 1, role, outcome: "tie" as const, publicCaseCount: 8, hiddenCaseCount: 1,
      totalCandidateAggregate: {}, hiddenCandidateAggregate: { extraActions: value },
    }));
    const nonAssociativeAggregate = {
      completedAttemptCount: 3, metricAvailableAttemptCount: 3, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 3,
      evaluatedHiddenCaseCount: 3, metricTotals: { extraActions: 0 },
    };
    await expect(adapter.evolvePlugin!(request({ ...validInput, lineagePlans: [], publicTraces: [],
      trustedResults: nonAssociativeResults, hiddenAggregate: nonAssociativeAggregate }, 4)))
      .rejects.toThrow(/反馈协议字段非法/);
    await expect(adapter.evolvePlugin!(request({ ...validInput, lineagePlans: [], publicTraces: [],
      trustedResults: [...nonAssociativeResults].reverse(), hiddenAggregate: nonAssociativeAggregate }, 4)))
      .rejects.toThrow(/反馈协议字段非法/);
    const overWindowResults = Array.from({ length: 65 }, (_, index) => ({
      attemptId: `g${String(index + 1).padStart(4, "0")}-${role}`,
      generation: index + 1, role, outcome: "failed" as const,
      publicCaseCount: 0, hiddenCaseCount: 0, totalCandidateAggregate: {},
    }));
    const emptyHiddenAggregate = {
      completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
      evaluatedHiddenCaseCount: 0, metricTotals: {},
    };
    await expect(adapter.evolvePlugin!(request({
      ...validInput, lineagePlans: [], publicTraces: [], trustedResults: overWindowResults.slice(0, 64),
      hiddenAggregate: emptyHiddenAggregate,
    }, 66))).resolves.toMatchObject({ submitted: true });
    await expect(adapter.evolvePlugin!(request({
      ...validInput, lineagePlans: [], publicTraces: [], trustedResults: overWindowResults,
      hiddenAggregate: emptyHiddenAggregate,
    }, 66))).rejects.toThrow(/反馈协议字段非法/);

    const boundaryMetrics = Object.fromEntries(Array.from(
      { length: HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS },
      (_, index) => [`m${String(index).padStart(2, "0")}${"x".repeat(51)}`, Number.MAX_VALUE],
    ));
    const boundaryCheckpoints = Array.from({ length: 64 }, (_, index) => {
      const generation = index + 1;
      const checkpointAttemptId = `g${String(generation).padStart(4, "0")}-${role}`;
      const result: GenerationRoleResult = {
        candidateCommit: `${checkpointAttemptId}-candidate`, championBefore: "g0", championAfter: "g0",
        outcome: "tie", promotionTag: null, publicProgress: 8, hiddenProgress: 0, aggregate: boundaryMetrics,
        trustedPublicTraces: [{
          attemptId: checkpointAttemptId, generation, traceId: `public-${generation}`, outcome: "tie",
          metrics: boundaryMetrics,
          events: Array.from({ length: HARNESS_EVOLUTION_MAX_TRACE_EVENTS },
            () => ({ type: "maze.completed" as const, passageCount: 960 })),
        }],
      };
      return { generation, attemptId: checkpointAttemptId, result };
    });
    const strategyRecords = boundaryCheckpoints.slice(-16).map(({ attemptId: checkpointAttemptId }) => ({
      attemptId: checkpointAttemptId, strategyPlan: "",
    }));
    const assembleBoundary = () => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 65, role, championRoot: workspace, frozenChampion: "g0",
      runtime: {
        get: () => ({ champions: { generator: "g0", solver: "g0" } }) as never,
        listRoleCheckpoints: () => boundaryCheckpoints,
      },
      lineage: { listStrategyRecords: () => strategyRecords },
    });
    const emptyBoundary = assembleBoundary();
    let remainingBytes = HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES
      - harnessEvolutionTrustedInputBytes({ role, championRoot: workspace, ...emptyBoundary });
    expect(remainingBytes).toBeGreaterThan(0);
    for (const record of strategyRecords) {
      const bytes = Math.min(remainingBytes, HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES);
      record.strategyPlan = "x".repeat(bytes);
      remainingBytes -= bytes;
    }
    expect(remainingBytes).toBe(0);
    const exactBoundary = assembleBoundary();
    const exactBoundaryInput = { role, championRoot: workspace, ...exactBoundary };
    expect(harnessEvolutionTrustedInputBytes(exactBoundaryInput)).toBe(HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES);
    await expect(adapter.evolvePlugin!(request(exactBoundaryInput, 65))).resolves.toMatchObject({ submitted: true });

    strategyRecords.at(-1)!.strategyPlan += "x";
    expect(assembleBoundary).toThrow(/反馈超过协议字节预算/);
    const overBoundaryInput = structuredClone(exactBoundaryInput);
    overBoundaryInput.lineagePlans.at(-1)!.strategyPlan += "x";
    await expect(adapter.evolvePlugin!(request(overBoundaryInput, 65))).rejects.toThrow(/反馈协议字段非法/);

    const oversizedRequest = request(validInput);
    oversizedRequest.diagnostics = ["x".repeat(HARNESS_EVOLUTION_MAX_REQUEST_BYTES)];
    await expect(adapter.evolvePlugin!(oversizedRequest)).rejects.toThrow(/请求超过 1 MiB 限制/);
  });

  it("生产 Harness 隐藏宿主运行时 socket 且仍允许 Session 目录读写", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-ipc-"));
    const exportPath = join(directory, "models.json");
    const commandPath = join(directory, "ipc-check.mjs");
    const hostSocket = resolve(dirname(fileURLToPath(import.meta.url)), `../../../.maze-host-${randomUUID()}.sock`);
    const abstractSocket = `\0maze-ticket05-${randomUUID()}`;
    const mountedSocket = "/mnt/wslg/runtime-dir/wayland-0";
    const workspace = join(directory, "workspace");
    const globalHome = join(directory, "global-home");
    mkdirSync(workspace);
    mkdirSync(globalHome);
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "ipc-fixture", version: "1.0.0" }));
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
let input="";for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);
const connectable=(path)=>new Promise((resolve)=>{const socket=createConnection(path);const finish=(value)=>{socket.destroy();resolve(value)};socket.once("connect",()=>finish({connected:true}));socket.once("error",(error)=>finish({connected:false,code:error.code}));socket.setTimeout(200,()=>finish({connected:false,code:"TIMEOUT"}));});
const tcpLoopback=()=>new Promise((resolve)=>{const server=createServer((socket)=>socket.end());server.once("error",()=>resolve(false));server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string"){server.close();return resolve(false)}const client=createConnection({host:"127.0.0.1",port:address.port});client.once("connect",()=>{client.end();server.close(()=>resolve(true))});client.once("error",()=>{server.close();resolve(false)})})});
const dockerPaths=["/run/docker.sock","/var/run/docker.sock"];
const writable=(path)=>{try{writeFileSync(path,"forbidden");return true}catch{return false}};
const mountedSocket=${JSON.stringify(mountedSocket)};
const dockerConnections=await Promise.all(dockerPaths.map(connectable));
const result={dockerVisible:dockerPaths.some(existsSync),dockerConnect:dockerConnections.some((value)=>value.connected),homeVisible:existsSync(${JSON.stringify(hostSocket)}),homeConnect:(await connectable(${JSON.stringify(hostSocket)})).connected,mountVisible:existsSync(mountedSocket),mountConnect:(await connectable(mountedSocket)).connected,abstractConnect:await connectable(${JSON.stringify(abstractSocket)}),tcpLoopback:await tcpLoopback(),tmpWritable:writable("/tmp/unscoped-write"),runWritable:writable("/run/unscoped-write")};
writeFileSync(request.session.home+"/ipc-session-write.txt","allowed");
writeFileSync(request.session.workspace+"/ipc-workspace-write.txt","allowed");
process.stdout.write(JSON.stringify({type:"maze-arena.harness-evolution.response",protocolVersion:1,sessionId:request.session.id,result:{hypothesis:JSON.stringify(result),strategyPlan:"ipc boundary",submitted:false},usage:{tokens:1,cost:0}}));
`);
    chmodSync(commandPath, 0o755);
    const listener = createNetServer();
    const abstractListener = createNetServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once("error", rejectListen);
      listener.listen(hostSocket, () => resolveListen());
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      abstractListener.once("error", rejectListen);
      abstractListener.listen(abstractSocket, () => resolveListen());
    });
    try {
      const adapter = createProductionHarnessAdapter({
        ARENA_MODEL_CATALOG_PATH: exportPath,
        DSH_HARNESS_VERSION: "2026.09.2",
        DSH_EVOLUTION_COMMAND: commandPath,
        DSH_SMOKE_COMMAND: "/bin/false",
        DSH_HOME: globalHome,
      });
      const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
        credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
      const request = productionEvolutionRequest({
        experimentId: "exp", generation: 1, role: "generator", attemptId: "ipc-check",
        modelProfile, workspace, repairAttempt: 0, diagnostics: [],
      });

      const response = await adapter.evolvePlugin!(request);

      expect(JSON.parse(response.hypothesis)).toEqual({
        dockerVisible: false,
        dockerConnect: false,
        homeVisible: false,
        homeConnect: false,
        mountVisible: false,
        mountConnect: false,
        abstractConnect: { connected: false, code: "EAFNOSUPPORT" },
        tcpLoopback: true,
        tmpWritable: false,
        runWritable: false,
      });
      expect(readFileSync(join(request.home, "ipc-session-write.txt"), "utf8")).toBe("allowed");
      expect(readFileSync(join(workspace, "ipc-workspace-write.txt"), "utf8")).toBe("allowed");
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) => abstractListener.close((error) => error ? rejectClose(error) : resolveClose()));
      rmSync(hostSocket, { force: true });
    }
  });

  it("生产 Harness 模型调用失败不回显第三方 stderr", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-stderr-"));
    const exportPath = join(directory, "models.json");
    const commandPath = join(directory, "fail.mjs");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, "#!/usr/bin/env node\nprocess.stderr.write('opaque-e9f31c64\\n');process.exit(7);\n");
    chmodSync(commandPath, 0o755);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: commandPath,
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    let message = "";
    try {
      await adapter.evolvePlugin!(productionEvolutionRequest({ experimentId: "exp", generation: 1, role: "generator", attemptId: "attempt",
        modelProfile, workspace: directory, repairAttempt: 0, diagnostics: [] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("退出码 7");
    expect(message).not.toContain("opaque-e9f31c64");
  });

  it("生产 Harness 无法建立 PID namespace 时关闭失败且不执行目标命令", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-no-namespace-"));
    const exportPath = join(directory, "models.json");
    const markerPath = join(directory, "executed");
    const commandPath = join(directory, "must-not-run.mjs");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(markerPath)}, "1");\n`);
    chmodSync(commandPath, 0o755);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: commandPath,
      DSH_UNSHARE_EXECUTABLE: "/bin/false",
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    await expect(adapter.smokeModel!(modelProfile)).rejects.toThrow(/无法建立受控 PID namespace/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("生产 Harness 拒绝扩展响应字段并可取消活动子进程", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-guard-"));
    const exportPath = join(directory, "models.json");
    const commandPath = join(directory, "evolve.mjs");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, `#!/usr/bin/env node
let input="";for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);
const mode=request.attempt.attemptId;
if(mode==="block"){setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode==="non-json"){process.stdout.write("not-json");process.exit(0);}
if(mode==="transient-provider"){process.stdout.write(JSON.stringify({
  type:"maze-arena.harness-evolution.response",protocolVersion:1,sessionId:request.session.id,
  error:{kind:"transient-provider",code:"RATE_LIMITED"},usage:{tokens:7,cost:0.02},
}));process.exit(0);}
if(mode==="unknown-field"){process.stdout.write(JSON.stringify({
  type:"maze-arena.harness-evolution.response",protocolVersion:1,sessionId:request.session.id,
  result:{hypothesis:"h",strategyPlan:"p",submitted:true},usage:{tokens:37,cost:0.25},unexpected:true,
}));process.exit(0);}
process.stdout.write(JSON.stringify({
  type:"maze-arena.harness-evolution.response",
  protocolVersion:mode==="future-version"?2:1,
  sessionId:request.session.id,
  result:{hypothesis:"h",strategyPlan:"p",submitted:true},
  usage:mode==="excessive-usage"?{tokens:5001,cost:0}:{tokens:1,cost:0,untrusted:true},
}));
`);
    chmodSync(commandPath, 0o755);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: "/bin/false",
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model", credentialRef: "dsh-credential://production",
      contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    const request = productionEvolutionRequest({ experimentId: "exp", generation: 1, role: "generator" as const,
      attemptId: "invalid", modelProfile, workspace: directory, repairAttempt: 0, diagnostics: [] });
    await expect(adapter.evolvePlugin!({ ...request, attemptId: "invalid" })).rejects.toThrow(/响应字段非法/);
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ ...request, attemptId: "future-version" })))
      .rejects.toThrow(/响应字段非法/);
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ ...request, attemptId: "excessive-usage" })))
      .rejects.toMatchObject({ name: "HarnessInvocationError", kind: "protocol", usage: undefined });
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ ...request, attemptId: "non-json" })))
      .rejects.toThrow(/未返回合法 JSON/);
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ ...request, attemptId: "transient-provider" })))
      .rejects.toMatchObject({ name: "HarnessInvocationError", kind: "transient-provider", usage: { tokens: 7, cost: 0.02 } });
    await expect(adapter.evolvePlugin!(productionEvolutionRequest({ ...request, attemptId: "unknown-field" })))
      .rejects.toMatchObject({
        name: "HarnessInvocationError",
        kind: "protocol",
        usage: { tokens: 37, cost: 0.25 },
        execution: { kind: "real-provider", harnessVersion: "2026.09.2", providerId: "provider", modelId: "model" },
      });

    const controller = new AbortController();
    const blocked = adapter.evolvePlugin!({ ...request, attemptId: "block", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(blocked).rejects.toThrow(/已取消/);
  });

  it("生产 Harness 在取消、超时和输出超限时终止并确认整个派生工具进程组退出", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-tree-stop-"));
    const exportPath = join(directory, "models.json");
    const commandPath = join(directory, "process-tree.mjs");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09.2", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000, maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    }));
    writeFileSync(commandPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const marker = ${JSON.stringify(directory)} + ":" + request.attempt.attemptId;
spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", marker], {
  stdio: "ignore",
  detached: true,
});
writeFileSync(${JSON.stringify(directory)} + "/" + request.attempt.attemptId + ".ready", marker);
process.on("SIGTERM", () => {});
setTimeout(() => {
  if (request.attempt.attemptId === "stdout-limit") process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x78));
  if (request.attempt.attemptId === "stderr-limit") process.stderr.write(Buffer.alloc(1024 * 1024 + 1, 0x78));
  if (request.attempt.attemptId === "error") process.exit(7);
  if (request.attempt.attemptId === "success") {
    process.stdout.write(JSON.stringify({ type: "maze-arena.harness-evolution.response", protocolVersion: 1,
      sessionId: request.session.id, result: { hypothesis: "h", strategyPlan: "p", submitted: true }, usage: { tokens: 1, cost: 0 } }));
    process.exit(0);
  }
}, 100);
setInterval(() => {}, 1000);
`);
    chmodSync(commandPath, 0o755);
    const adapter = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: exportPath, DSH_HARNESS_VERSION: "2026.09.2",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: commandPath,
      DSH_EVOLUTION_TIMEOUT_MS: "1000",
    });
    const modelProfile = adapter.validateModelProfile({ providerId: "provider", modelId: "model",
      credentialRef: "dsh-credential://production", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000 });
    const assertTreeStopped = async (attemptId: "success" | "cancel" | "timeout" | "stdout-limit" | "stderr-limit" | "error") => {
      const controller = new AbortController();
      const running = adapter.evolvePlugin!(productionEvolutionRequest({ experimentId: "exp", generation: 1, role: "generator", attemptId,
        modelProfile, workspace: directory, repairAttempt: 0, diagnostics: [], signal: controller.signal }));
      const readyPath = join(directory, `${attemptId}.ready`);
      for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(existsSync(readyPath)).toBe(true);
      const marker = readFileSync(readyPath, "utf8");
      let escapedPid: number | undefined;
      for (let attempt = 0; attempt < 100 && escapedPid === undefined; attempt += 1) {
        escapedPid = findHostProcess(marker);
        if (escapedPid === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(escapedPid).toBeDefined();
      if (attemptId === "cancel") controller.abort();
      const expected = attemptId === "cancel" ? /已取消/
        : attemptId === "timeout" ? /超时限制/
          : attemptId === "error" ? /退出码 7/
            : new RegExp(`${attemptId.replace("-limit", "")} 超过`);
      if (attemptId === "success") await expect(running).resolves.toMatchObject({ hypothesis: "h", submitted: true });
      else await expect(running).rejects.toThrow(expected);
      expect(existsSync(`/proc/${escapedPid}`)).toBe(false);
    };

    await assertTreeStopped("success");
    await assertTreeStopped("cancel");
    await assertTreeStopped("timeout");
    await assertTreeStopped("stdout-limit");
    await assertTreeStopped("stderr-limit");
    await assertTreeStopped("error");
  }, 15_000);

  it("服务器兼容性指纹变化后拒绝恢复已冻结实验", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-fingerprint-restart-"));
    const databasePath = join(directory, "arena.sqlite");
    const first = createArenaServer({ databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: deterministicMatchRunner, compatibilityFingerprint: "compat-v1" });
    servers.push(first);
    const experiment = await createExperiment(first, "指纹冻结实验");
    await validateAndConfirm(first, experiment.id);
    await first.close();
    servers.splice(servers.indexOf(first), 1);
    const restarted = createArenaServer({ databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: deterministicMatchRunner, compatibilityFingerprint: "compat-v2" });
    servers.push(restarted);
    const response = await restarted.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });
    expect(response.statusCode).toBe(409);
    expect(response.json<DomainErrorResponse>().error.message).toMatch(/兼容性指纹已变化/);
  });

  it("已有运行实验时拒绝启动第二个实验并返回领域错误", async () => {
    const server = createTestServer(":memory:", abortableBlockingAdapter);
    const first = await createExperiment(server, "实验一");
    const second = await createExperiment(server, "实验二");

    await validateAndConfirm(server, first.id);
    await validateAndConfirm(server, second.id);
    expect((await server.inject({ method: "POST", url: `/api/experiments/${first.id}/runtime/start` })).statusCode).toBe(200);
    const rejected = await server.inject({ method: "POST", url: `/api/experiments/${second.id}/runtime/start` });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<DomainErrorResponse>().error.message).toMatch(/已有运行中的实验/);
  });

  it("重复启动同一实验返回稳定的非法状态转换错误", async () => {
    const server = createTestServer(":memory:", abortableBlockingAdapter);
    const experiment = await createExperiment(server, "重复启动实验");
    await validateAndConfirm(server, experiment.id);
    const first = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });
    const repeated = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/runtime/start` });

    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "RUNTIME_STATE_INVALID",
        message: "状态 running 不允许启动或恢复",
      },
    });
  });
});
