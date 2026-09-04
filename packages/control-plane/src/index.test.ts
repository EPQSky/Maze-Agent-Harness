import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { baselineValidationSteps, CompatibilityFingerprintChangedError, ControlPlaneRepository, ExperimentRuntimeRepository, runSynchronousGeneration, withProviderRetry, type FrozenExperimentConfiguration } from "./index.js";

const configuration: FrozenExperimentConfiguration = {
  modelProfile: { provider: "fake", model: "deterministic" }, tokenLimit: 10_000, costLimit: 1.5,
  rulesDigest: "rules", seedPolicyDigest: "seeds",
  resourcePolicyDigest: "resources", scoringVersion: "score-v1", compatibilityFingerprint: "compat-v1",
};

describe("人工监督基线验收", () => {
  it("按固定顺序完成真实能力步骤，仍需操作员确认才就绪", async () => {
    const repository = new ControlPlaneRepository(":memory:");
    const observed: string[] = [];
    const record = await repository.runBaselineValidation("exp", {
      runStep: async (step) => { observed.push(step); return { step, passed: true, diagnostics: [`${step} 通过`] }; },
    });
    expect(observed).toEqual(baselineValidationSteps);
    expect(record).toMatchObject({ status: "passed", operatorConfirmed: false });
    expect(() => repository.requireReady("exp")).toThrow(/尚未通过人工监督/);
    const ready = repository.confirmBaseline("exp", configuration);
    expect(ready).toMatchObject({ status: "ready", operatorConfirmed: true, frozenConfiguration: configuration });
    repository.close();
  });

  it("任一步失败保留诊断且不解锁正式进化", async () => {
    const repository = new ControlPlaneRepository(":memory:");
    const record = await repository.runBaselineValidation("exp", {
      runStep: async (step) => ({ step, passed: step !== "determinism", diagnostics: step === "determinism" ? ["三次输出不一致"] : [] }),
    });
    expect(record.status).toBe("failed");
    expect(record.steps.at(-1)).toEqual({ step: "determinism", passed: false, diagnostics: ["三次输出不一致"] });
    expect(() => repository.confirmBaseline("exp", configuration)).toThrow(/尚未全部通过/);
    repository.close();
  });

  it("可选真实提供方冒烟只记录成败，不冻结返回文本", async () => {
    const repository = new ControlPlaneRepository(":memory:");
    const smokeProvider = vi.fn(async () => ({ passed: true, providerText: `随机文本 ${Math.random()}` }));
    const record = await repository.runBaselineValidation("exp", {
      runStep: async (step) => ({ step, passed: true, diagnostics: [] }), smokeProvider,
    }, { smokeProvider: true });
    expect(record.smoke).toEqual({ attempted: true, passed: true });
    expect(JSON.stringify(record)).not.toContain("随机文本");
    repository.close();
  });

  it("重启后冻结配置保持一致，指纹变化关闭失败", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-control-")), "arena.sqlite");
    const first = new ControlPlaneRepository(databasePath);
    await first.runBaselineValidation("exp", { runStep: async (step) => ({ step, passed: true, diagnostics: [] }) });
    const frozen = first.confirmBaseline("exp", configuration);
    first.close();
    const restarted = new ControlPlaneRepository(databasePath);
    expect(restarted.getBaselineValidation("exp")).toEqual(frozen);
    expect(() => restarted.requireReady("exp", "compat-v2")).toThrow(CompatibilityFingerprintChangedError);
    restarted.invalidateUnstarted("exp");
    expect(restarted.getBaselineValidation("exp")?.status).toBe("pending");
    restarted.close();
  });

  it("运行时注册失败后可回滚为验收通过且等待操作员重新确认", async () => {
    const repository = new ControlPlaneRepository(":memory:");
    await repository.runBaselineValidation("exp", {
      runStep: async (step) => ({ step, passed: true, diagnostics: [] }),
    });
    repository.confirmBaseline("exp", configuration);

    expect(repository.rollbackBaselineConfirmation("exp")).toMatchObject({
      status: "passed", operatorConfirmed: false, frozenConfiguration: null, frozenDigest: null,
    });
    expect(() => repository.requireReady("exp")).toThrow(/尚未通过人工监督/);
    repository.close();
  });
});

const roleResult = (role: "generator" | "solver", outcome: "promoted" | "failed" | "tie" = "failed") => ({
  candidateCommit: `${role}-candidate`, championBefore: `${role}-champion`,
  championAfter: outcome === "promoted" ? `${role}-candidate` : `${role}-champion`, outcome,
  promotionTag: outcome === "promoted" ? `promotion/exp/${role}/g0001` : null,
  publicProgress: 1, hiddenProgress: 1, aggregate: { primary: outcome === "promoted" ? 2 : 1 },
  hiddenCandidateAggregate: { primary: outcome === "promoted" ? 2 : 1 },
});

describe("同步进化运行控制", () => {
  it("独立判定双方并原子提交冠军，重复检查点不重复代次", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    repository.registerReady({ experimentId: "exp", champions: { generator: "g0", solver: "s0" }, tokenLimit: 10_000, compatibilityFingerprint: "compat" });
    repository.start("exp");
    const first = repository.commitGeneration({
      experimentId: "exp", generator: roleResult("generator", "promoted"), solver: roleResult("solver", "failed"), checkpointKey: "g1",
    });
    expect(first).toMatchObject({ generation: 1, stagnationCount: 0, champions: { generator: "generator-candidate", solver: "solver-champion" } });
    const repeated = repository.commitGeneration({
      experimentId: "exp", generator: roleResult("generator", "promoted"), solver: roleResult("solver", "failed"), checkpointKey: "g1",
    });
    expect(repeated.generation).toBe(1);
    repository.close();
  });

  it("五个正常代无晋级自动结束，基础设施失败不消耗代次或停滞计数", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    repository.registerReady({ experimentId: "exp", champions: { generator: "g0", solver: "s0" }, tokenLimit: 10_000, compatibilityFingerprint: "compat" });
    repository.start("exp");
    for (let generation = 1; generation <= 4; generation += 1) {
      repository.commitGeneration({ experimentId: "exp", generator: roleResult("generator"), solver: roleResult("solver", "tie"), checkpointKey: `g${generation}` });
    }
    const failed = repository.recordInfrastructureFailure("exp", "提供方断线");
    expect(failed).toMatchObject({ generation: 4, stagnationCount: 4, state: "paused" });
    repository.start("exp");
    const completed = repository.commitGeneration({ experimentId: "exp", generator: roleResult("generator"), solver: roleResult("solver"), checkpointKey: "g5" });
    expect(completed).toMatchObject({ generation: 5, stagnationCount: 5, state: "completed" });
    repository.close();
  });

  it("预算和安全暂停在代边界生效，同一 Arena 只允许一个运行实验", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    for (const id of ["a", "b"]) repository.registerReady({ experimentId: id, champions: { generator: "g", solver: "s" }, tokenLimit: 100, costLimit: 1, compatibilityFingerprint: "compat" });
    repository.start("a");
    expect(() => repository.start("b")).toThrow(/已有运行中的实验/);
    repository.recordUsage("a", 100, 0.5);
    const paused = repository.commitGeneration({ experimentId: "a", generator: roleResult("generator"), solver: roleResult("solver"), checkpointKey: "boundary" });
    expect(paused).toMatchObject({ state: "paused", usage: { tokens: 100, cost: 0.5 } });
    repository.close();
  });

  it("比较克隆共享密封组，运行成员阻止解封，解封原子传播且永久禁用进化", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    const source = repository.registerReady({ experimentId: "source", champions: { generator: "g", solver: "s" }, tokenLimit: 100, compatibilityFingerprint: "compat" });
    const clone = repository.cloneComparison("source", "clone", "compat");
    expect(clone).toMatchObject({ evaluationSuiteId: source.evaluationSuiteId, sealGroupId: source.sealGroupId, sealed: true });
    repository.start("clone");
    expect(() => repository.unsealGroup("source")).toThrow(/运行中的实验/);
    repository.cancel("clone");
    expect(repository.unsealGroup("source")).toHaveLength(2);
    expect(repository.get("source")).toMatchObject({ sealed: false, evolutionPermitted: false });
    expect(() => repository.start("source")).toThrow(/永久禁止/);
    const fork = repository.forkContinuation("source", "fork", "compat-v2");
    expect(fork.evaluationSuiteId).not.toBe(source.evaluationSuiteId);
    expect(fork.compatibilityFingerprint).toBe("compat-v2");
    expect(repository.deriveHiddenSeed("source", 1, "case-a")).toBe(repository.deriveHiddenSeed("source", 1, "case-a"));
    expect(repository.deriveHiddenSeed("fork", 1, "case-a")).not.toBe(repository.deriveHiddenSeed("source", 1, "case-a"));
    repository.close();
  });

  it("比较克隆可固定回原始基线，延续分支只接受保留冠军", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    repository.registerReady({ experimentId: "source", champions: { generator: "g0", solver: "s0" }, tokenLimit: 100, compatibilityFingerprint: "compat" });
    repository.start("source");
    repository.commitGeneration({
      experimentId: "source", checkpointKey: "g1",
      generator: { ...roleResult("generator", "promoted"), candidateCommit: "g1", championBefore: "g0", championAfter: "g1" },
      solver: { ...roleResult("solver", "failed"), candidateCommit: "s-failed", championBefore: "s0", championAfter: "s0" },
    });
    const clone = repository.cloneComparison("source", "clone", "compat", undefined, { generator: "g0", solver: "s0" });

    expect(clone.champions).toEqual({ generator: "g0", solver: "s0" });
    expect(repository.isRetainedChampion("source", "generator", "g0")).toBe(true);
    expect(repository.isRetainedChampion("source", "generator", "g1")).toBe(true);
    expect(repository.isRetainedChampion("source", "solver", "s-failed")).toBe(false);
    repository.close();
  });

  it("角色检查点与可信用量原子持久化，重启后不会重复计费", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-role-checkpoint-")), "arena.sqlite");
    const first = new ExperimentRuntimeRepository(databasePath);
    first.registerReady({ experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000, compatibilityFingerprint: "compat" });
    first.start("exp");
    const result = roleResult("generator", "tie");
    first.saveRoleCheckpoint({ experimentId: "exp", generation: 1, role: "generator", attemptId: "g1-generator", result, tokens: 123, cost: 0.25 });
    first.saveRoleCheckpoint({ experimentId: "exp", generation: 2, role: "generator", attemptId: "g2-generator", result, tokens: 0, cost: 0 });
    first.saveRoleCheckpoint({ experimentId: "exp", generation: 1, role: "solver", attemptId: "g1-solver", result: roleResult("solver", "failed"), tokens: 0, cost: 0 });
    first.close();
    const restarted = new ExperimentRuntimeRepository(databasePath);
    expect(restarted.getRoleCheckpoint("exp", 1, "generator")).toEqual({ attemptId: "g1-generator", result, tokens: 123, cost: 0.25 });
    expect(restarted.listRoleCheckpoints("exp", "generator", 2)).toEqual([{ generation: 1, attemptId: "g1-generator", result }]);
    restarted.saveRoleCheckpoint({ experimentId: "exp", generation: 1, role: "generator", attemptId: "g1-generator", result, tokens: 123, cost: 0.25 });
    expect(restarted.get("exp")?.usage).toEqual({ tokens: 123, cost: 0.25 });
    restarted.close();
  });

  it("提供方基础设施错误退避三次后抛出", async () => {
    const operation = vi.fn(async () => { throw new Error("限流"); });
    const wait = vi.fn(async () => undefined);
    await expect(withProviderRetry(operation, wait)).rejects.toThrow("限流");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("取消类错误可关闭重试并立即抛出", async () => {
    const operation = vi.fn(async () => { throw new Error("已取消"); });
    const wait = vi.fn(async () => undefined);
    await expect(withProviderRetry(operation, wait, () => false)).rejects.toThrow("已取消");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("双方共享上一代冻结快照，调用顺序不改变独立晋级结果", async () => {
    async function execute(order: readonly ("generator" | "solver")[]) {
      const repository = new ExperimentRuntimeRepository(":memory:");
      repository.registerReady({ experimentId: "exp", champions: { generator: "generator-champion", solver: "solver-champion" }, tokenLimit: 1_000, compatibilityFingerprint: "compat" });
      repository.start("exp");
      const frozenInputs: unknown[] = [];
      const result = await runSynchronousGeneration({
        experimentId: "exp", repository, order, checkpointKey: "generation-1",
        adapter: {
          evolve: async (role, frozen) => { frozenInputs.push(frozen); return roleResult(role, "promoted"); },
          createChampionExhibition: async () => "exhibition-1",
        },
      });
      repository.close();
      return { result, frozenInputs };
    }
    const forward = await execute(["generator", "solver"]);
    const reverse = await execute(["solver", "generator"]);
    expect(forward.result.champions).toEqual(reverse.result.champions);
    expect(forward.result.generations[0]?.exhibitionMatchId).toBe("exhibition-1");
    expect(forward.frozenInputs).toEqual([
      { generation: 1, champions: { generator: "generator-champion", solver: "solver-champion" }, compatibilityFingerprint: "compat" },
      { generation: 1, champions: { generator: "generator-champion", solver: "solver-champion" }, compatibilityFingerprint: "compat" },
    ]);
  });

  it("有晋级时可持续至第 20 代并自动结束", () => {
    const repository = new ExperimentRuntimeRepository(":memory:");
    repository.registerReady({ experimentId: "exp", champions: { generator: "g0", solver: "s0" }, tokenLimit: 1_000, compatibilityFingerprint: "compat" });
    repository.start("exp");
    let snapshot = repository.get("exp")!;
    for (let generation = 1; generation <= 20; generation += 1) {
      snapshot = repository.commitGeneration({
        experimentId: "exp", generator: roleResult("generator", "promoted"), solver: roleResult("solver", "failed"), checkpointKey: `generation-${generation}`,
      });
    }
    expect(snapshot).toMatchObject({ generation: 20, state: "completed", stagnationCount: 0 });
    repository.close();
  });
});
