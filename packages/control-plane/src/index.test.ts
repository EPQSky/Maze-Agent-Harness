import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { baselineValidationSteps, CompatibilityFingerprintChangedError, ControlPlaneRepository, ExperimentRuntimeRepository, MAX_TOP_LEVEL_TOOL_CALLS, runSynchronousGeneration, withProviderRetry, type FrozenExperimentConfiguration } from "./index.js";

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
    const smokeProvider = vi.fn(async () => ({
      passed: true,
      providerText: `随机文本 ${Math.random()}`,
      usage: { tokens: 7, cost: 0.01, modelCalls: 1 },
    }));
    const record = await repository.runBaselineValidation("exp", {
      runStep: async (step) => ({ step, passed: true, diagnostics: [] }), smokeProvider,
    }, { smokeProvider: true });
    expect(record.smoke).toEqual({
      attempted: true, passed: true, usage: { tokens: 7, cost: 0.01, modelCalls: 1 }, failureKind: null,
    });
    expect(JSON.stringify(record)).not.toContain("随机文本");
    repository.close();
  });

  it("冒烟失败分类可跨重启持久化且不保存提供方原文", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-control-smoke-failure-"));
    const databasePath = join(root, "arena.sqlite");
    const sensitiveText = "provider-secret-diagnostic";
    try {
      const first = new ControlPlaneRepository(databasePath);
      const record = await first.runBaselineValidation("exp", {
        runStep: async (step) => ({ step, passed: true, diagnostics: [] }),
        smokeProvider: async () => ({
          passed: false,
          providerText: sensitiveText,
          usage: { tokens: 11, cost: 0.02, modelCalls: 1 },
          failureKind: "transient-provider",
        }),
      }, { smokeProvider: true });
      expect(record.smoke).toEqual({
        attempted: true,
        passed: false,
        usage: { tokens: 11, cost: 0.02, modelCalls: 1 },
        failureKind: "transient-provider",
      });
      first.close();

      const restarted = new ControlPlaneRepository(databasePath);
      expect(restarted.getBaselineValidation("exp")?.smoke).toEqual(record.smoke);
      restarted.close();
      expect(readFileSync(databasePath)).not.toContain(Buffer.from(sensitiveText));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(restarted.getRoleCheckpoint("exp", 1, "generator")).toEqual({
      attemptId: "g1-generator", result, tokens: 123, cost: 0.25, modelCalls: 0,
    });
    expect(restarted.listRoleCheckpoints("exp", "generator", 2)).toEqual([{ generation: 1, attemptId: "g1-generator", result }]);
    restarted.saveRoleCheckpoint({ experimentId: "exp", generation: 1, role: "generator", attemptId: "g1-generator", result, tokens: 123, cost: 0.25 });
    expect(restarted.get("exp")?.usage).toEqual({ tokens: 123, cost: 0.25, modelCalls: 0 });
    restarted.close();
  });

  it("父 Session 模型调用额度按可信用量结算并跨仓储重启保持", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-model-calls-")), "arena.sqlite");
    const first = new ExperimentRuntimeRepository(databasePath);
    first.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      compatibilityFingerprint: "compat",
    });

    const initial = first.reserveRemainingModelCalls("exp", 1, "generator");
    expect(initial).toBe(8);
    first.settleModelCallReservation({
      experimentId: "exp", generation: 1, role: "generator", reserved: initial, used: 2,
    });
    expect(first.get("exp")?.modelCallsReserved).toBe(2);
    first.close();

    const restarted = new ExperimentRuntimeRepository(databasePath);
    const afterSuccess = restarted.reserveRemainingModelCalls("exp", 1, "generator");
    expect(afterSuccess).toBe(6);
    // 结构化失败与成功使用相同的可信结算入口，只保留实际发生的调用。
    restarted.settleModelCallReservation({
      experimentId: "exp", generation: 1, role: "generator", reserved: afterSuccess, used: 3,
    });
    expect(restarted.get("exp")?.modelCallsReserved).toBe(5);

    const beforeCrash = restarted.reserveRemainingModelCalls("exp", 1, "generator");
    expect(beforeCrash).toBe(3);
    restarted.close();

    const afterCrash = new ExperimentRuntimeRepository(databasePath);
    expect(afterCrash.get("exp")?.modelCallsReserved).toBe(8);
    expect(() => afterCrash.reserveRemainingModelCalls("exp", 1, "generator"))
      .toThrow(/八次模型调用额度已耗尽/);
    expect(afterCrash.reserveRemainingModelCalls("exp", 1, "solver")).toBe(8);
    expect(afterCrash.reserveRemainingModelCalls("exp", 2, "generator")).toBe(8);
    afterCrash.close();
  });

  it("剩余模型调用不足以收尾时在预留前拒绝新 Session", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-model-call-minimum-")), "arena.sqlite");
    const runtime = new ExperimentRuntimeRepository(databasePath);
    runtime.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      compatibilityFingerprint: "compat",
    });

    expect(runtime.reserveRemainingModelCalls("exp", 1, "generator")).toBe(8);
    runtime.settleModelCallReservation({
      experimentId: "exp", generation: 1, role: "generator", reserved: 8, used: 6,
    });
    expect(() => runtime.reserveRemainingModelCalls("exp", 1, "generator", 3))
      .toThrow(/最小收尾.*至少 3 次.*仅剩 2 次/);
    expect(runtime.get("exp")?.modelCallsReserved).toBe(6);
    runtime.close();
  });

  it("首个进化 Session 最多预留五次，后续只在至少三次时启动", () => {
    const runtime = new ExperimentRuntimeRepository(":memory:");
    runtime.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      compatibilityFingerprint: "compat",
    });

    const first = runtime.reserveRemainingModelCalls("exp", 1, "generator", 3, 5);
    expect(first).toBe(5);
    runtime.settleModelCallReservation({
      experimentId: "exp", generation: 1, role: "generator", reserved: first, used: 3,
    });
    expect(runtime.get("exp")?.modelCallsReserved).toBe(3);

    const second = runtime.reserveRemainingModelCalls("exp", 1, "generator", 3, 8);
    expect(second).toBe(5);
    runtime.settleModelCallReservation({
      experimentId: "exp", generation: 1, role: "generator", reserved: second, used: 3,
    });
    expect(runtime.get("exp")?.modelCallsReserved).toBe(6);
    expect(() => runtime.reserveRemainingModelCalls("exp", 1, "generator", 3, 8))
      .toThrow(/最小收尾.*至少 3 次.*仅剩 2 次/);
    runtime.close();
  });

  it("Provider attempt actual 跨进程原子转入持久 batch，未结算上界继续保留", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-provider-budget-")), "arena.sqlite");
    const first = new ExperimentRuntimeRepository(databasePath);
    first.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000, costLimit: 1,
      compatibilityFingerprint: "compat",
    });
    expect(first.reserveRemainingModelCalls("exp", 1, "generator")).toBe(8);
    const settled = first.reserveProviderAttempt({
      experimentId: "exp", generation: 1, role: "generator", tokens: 600, cost: 0.6,
      invocationId: "a".repeat(64), reservedModelCalls: 8, auditDetails: { outcome: "failed" },
    });
    const settledBatch = first.settleProviderAttempt({ reservationId: settled, tokens: 100, cost: 0.1 });
    expect(settledBatch).toMatchObject({
      itemId: settled, invocationId: "a".repeat(64), tokens: 100, cost: 0.1, modelCalls: 1,
    });
    first.close();

    const restarted = new ExperimentRuntimeRepository(databasePath);
    const item = restarted.listPendingProviderUsageItems("exp", 1, "generator")[0]!;
    expect(restarted.listPendingProviderUsageItems("exp", 1, "generator")).toHaveLength(1);
    expect(restarted.accountProviderUsageItemModelCalls(item.itemId)).toBe(true);
    restarted.accountProviderUsageItemRuntime(item.itemId);
    restarted.recordRoleFailureUsage({
      experimentId: "exp", generation: 1, role: "generator", tokens: 100, cost: 0.1, modelCalls: 1,
    });
    const crashed = restarted.reserveProviderAttempt({
      experimentId: "exp", generation: 1, role: "generator", tokens: 800, cost: 0.8,
      invocationId: "b".repeat(64), reservedModelCalls: 7, auditDetails: { outcome: "failed" },
    });
    expect(crashed).toMatch(/[0-9a-f-]{36}/);
    expect(() => restarted.reserveProviderAttempt({
      experimentId: "exp", generation: 1, role: "generator", tokens: 101, cost: 0.01,
      invocationId: "b".repeat(64), reservedModelCalls: 7, auditDetails: { outcome: "failed" },
    })).toThrow(/保守预算不足/);
    // 已结算的 100 tokens 已正式入账；无 usage 的 800 tokens 崩溃预留仍不可释放。
    expect(() => restarted.reserveProviderAttempt({
      experimentId: "exp", generation: 1, role: "generator", tokens: 101, cost: 0.01,
      invocationId: "b".repeat(64), reservedModelCalls: 7, auditDetails: { outcome: "failed" },
    })).toThrow(/保守预算不足/);
    restarted.close();
  });

  it("逐 attempt item 在双仓储交错结算后保持不可变并让晚到 usage 重新 pending", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-provider-batch-race-")), "arena.sqlite");
    const first = new ExperimentRuntimeRepository(databasePath);
    first.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000_000,
      costLimit: 10, compatibilityFingerprint: "compat",
    });
    expect(first.reserveRemainingModelCalls("exp", 1, "generator")).toBe(8);
    const reservations = ([[100_000, 1], [40_000, 0.4]] as const).map(([tokens, cost]) => ({
      reservationId: first.reserveProviderAttempt({
        experimentId: "exp", generation: 1, role: "generator", tokens: 200_000, cost: 2,
        invocationId: "c".repeat(64), reservedModelCalls: 8, auditDetails: { outcome: "failed" },
      }), tokens, cost,
    }));
    const second = new ExperimentRuntimeRepository(databasePath);
    const firstItem = first.settleProviderAttempt({ ...reservations[0]!, tokens: 10, cost: 0.1 });
    expect(second.settleProviderAttempt({ ...reservations[0]!, tokens: 10, cost: 0.1 })).toEqual(firstItem);
    expect(() => second.settleProviderAttempt({ ...reservations[0]!, tokens: 99_999 }))
      .toThrow(/幂等结算载荷冲突/);
    expect(first.accountProviderUsageItemModelCalls(firstItem.itemId)).toBe(true);
    first.markProviderUsageItemCanaryAccounted(firstItem.itemId, true);
    first.markProviderUsageItemAuditAccounted(firstItem.itemId);
    first.accountProviderUsageItemRuntime(firstItem.itemId);
    first.saveRoleCheckpoint({
      experimentId: "exp", generation: 1, role: "generator", attemptId: "attempt",
      result: roleResult("generator", "failed"), tokens: 999, cost: 9, modelCalls: 8,
    });
    expect(first.listPendingProviderUsageItems("exp", 1, "generator")).toEqual([]);

    const secondItem = second.settleProviderAttempt({ ...reservations[1]!, tokens: 20, cost: 0.2 });
    expect(secondItem).toMatchObject({ tokens: 20, cost: 0.2, modelCalls: 1 });
    expect(second.listPendingProviderUsageItems("exp", 1, "generator"))
      .toEqual([expect.objectContaining({ itemId: secondItem.itemId })]);
    expect(second.listPendingProviderUsageItems("exp", 1, "generator"))
      .not.toContainEqual(expect.objectContaining({ itemId: firstItem.itemId }));
    expect(second.accountProviderUsageItemModelCalls(secondItem.itemId)).toBe(true);
    second.markProviderUsageItemCanaryAccounted(secondItem.itemId, true);
    second.markProviderUsageItemAuditAccounted(secondItem.itemId);
    second.accountProviderUsageItemRuntime(secondItem.itemId);
    expect(second.get("exp")).toMatchObject({ usage: { tokens: 30, modelCalls: 2 } });
    expect(second.get("exp")!.usage.cost).toBeCloseTo(0.3);
    expect(second.getRoleCheckpoint("exp", 1, "generator")).toMatchObject({ tokens: 30, modelCalls: 2 });
    expect(second.getRoleCheckpoint("exp", 1, "generator")!.cost).toBeCloseTo(0.3);
    expect(second.getProviderInvocationUsage("c".repeat(64))).toMatchObject({ tokens: 30, modelCalls: 2 });
    second.close();
    first.close();
  });

  it("Provider invocation 与 usage item 跨实验、代次与角色严格隔离", () => {
    const runtime = new ExperimentRuntimeRepository(":memory:");
    for (const experimentId of ["exp-a", "exp-b"]) runtime.registerReady({
      experimentId, champions: { generator: "g", solver: "s" }, tokenLimit: 10_000,
      costLimit: 10, compatibilityFingerprint: "compat",
    });
    const invocationId = "f".repeat(64);
    const auditDetails = { outcome: "failed" };
    expect(runtime.reserveRemainingModelCalls("exp-a", 1, "generator")).toBe(8);
    const reservationId = runtime.reserveProviderAttempt({
      experimentId: "exp-a", generation: 1, role: "generator", tokens: 100, cost: 0.1,
      invocationId, reservedModelCalls: 8, auditDetails,
    });
    for (const [experimentId, generation, role] of [
      ["exp-b", 1, "generator"], ["exp-a", 2, "generator"], ["exp-a", 1, "solver"],
    ] as const) {
      expect(runtime.reserveRemainingModelCalls(experimentId, generation, role)).toBe(8);
      expect(() => runtime.reserveProviderAttempt({
        experimentId, generation, role, tokens: 100, cost: 0.1,
        invocationId, reservedModelCalls: 8, auditDetails,
      })).toThrow(/invocation owner 冲突/);
    }
    runtime.settleProviderAttempt({ reservationId, tokens: 10, cost: 0.01 });
    expect(runtime.listPendingProviderUsageItems("exp-a", 1, "generator")).toHaveLength(1);
    expect(runtime.listPendingProviderUsageItems("exp-b", 1, "generator")).toEqual([]);
    expect(runtime.listPendingProviderUsageItems("exp-a", 2, "generator")).toEqual([]);
    expect(runtime.listPendingProviderUsageItems("exp-a", 1, "solver")).toEqual([]);
    runtime.close();
  });

  it("Provider invocation 在 SQLite 账本层拒绝超出模型调用预留", () => {
    const runtime = new ExperimentRuntimeRepository(":memory:");
    runtime.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 10_000,
      costLimit: 10, compatibilityFingerprint: "compat",
    });
    expect(runtime.reserveRemainingModelCalls("exp", 1, "generator")).toBe(8);
    const common = {
      experimentId: "exp", generation: 1, role: "generator" as const, tokens: 100, cost: 0.1,
      invocationId: "8".repeat(64), reservedModelCalls: 2, auditDetails: { outcome: "failed" },
    };
    runtime.reserveProviderAttempt(common);
    runtime.reserveProviderAttempt(common);
    expect(() => runtime.reserveProviderAttempt(common)).toThrow(/模型调用预留已耗尽/);
    runtime.close();
  });

  it("Provider attempt settle 删除失败时回滚 outbox 聚合并保留预留", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-provider-batch-rollback-")), "arena.sqlite");
    const runtime = new ExperimentRuntimeRepository(databasePath);
    runtime.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      costLimit: 1, compatibilityFingerprint: "compat",
    });
    expect(runtime.reserveRemainingModelCalls("exp", 1, "generator")).toBe(8);
    const reservationId = runtime.reserveProviderAttempt({
      experimentId: "exp", generation: 1, role: "generator", tokens: 500, cost: 0.5,
      invocationId: "d".repeat(64), reservedModelCalls: 8, auditDetails: { outcome: "failed" },
    });
    const sabotage = new DatabaseSync(databasePath);
    sabotage.exec(`CREATE TRIGGER reject_provider_settle BEFORE DELETE ON generation_role_provider_attempts
      BEGIN SELECT RAISE(ABORT, 'settle rejected'); END`);
    expect(() => runtime.settleProviderAttempt({ reservationId, tokens: 123, cost: 0.12 }))
      .toThrow(/settle rejected/);
    expect(runtime.listPendingProviderUsageItems("exp", 1, "generator")).toEqual([]);
    sabotage.exec("DROP TRIGGER reject_provider_settle");
    expect(runtime.settleProviderAttempt({ reservationId, tokens: 123, cost: 0.12 }))
      .toMatchObject({ tokens: 123, cost: 0.12, modelCalls: 1 });
    sabotage.close();
    runtime.close();
  });

  it("正式 Repair60 Provider attempts 旧表正常升级为逐 attempt items", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-provider-repair60-migration-")), "arena.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE generation_role_provider_attempts (
      reservation_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL, reserved_cost REAL NOT NULL, actual_tokens INTEGER, actual_cost REAL
    )`);
    legacy.prepare(`INSERT INTO generation_role_provider_attempts VALUES
      ('settled', 'exp', 1, 'generator', 100, 1, 10, 0.1),
      ('pending', 'exp', 1, 'generator', 200, 2, NULL, NULL)`).run();
    legacy.close();

    const migrated = new ExperimentRuntimeRepository(databasePath);
    expect(migrated.listPendingProviderUsageItems("exp", 1, "generator"))
      .toEqual([expect.objectContaining({ itemId: "settled", reservationId: "settled", invocationId: "settled",
        tokens: 10, cost: 0.1, modelCalls: 1 })]);
    migrated.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(`SELECT reservation_id, invocation_id, reserved_model_calls, audit_details_json
      FROM generation_role_provider_attempts`).all()).toEqual([
      { reservation_id: "pending", invocation_id: "pending", reserved_model_calls: 1, audit_details_json: "{}" },
    ]);
    database.close();
  });

  it.each([
    ["generation_role_provider_attempt_receipts"],
    ["generation_role_provider_usage_batches"],
    ["generation_role_provider_attempt_receipts", "generation_role_provider_usage_batches",
      "real_dsh_canary_usage_receipts", "experiment_audit_events"],
  ])("检测到未发布 Repair66 中间表时 fail-closed 且不部分修改：%s", (...tables) => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-provider-intermediate-reject-")), "arena.sqlite");
    const legacy = new DatabaseSync(databasePath);
    for (const table of tables) legacy.exec(`CREATE TABLE ${table} (marker TEXT)`);
    const before = legacy.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    legacy.close();
    expect(() => new ExperimentRuntimeRepository(databasePath)).toThrow(/未发布的 Repair66 Provider usage 中间表/);
    const unchanged = new DatabaseSync(databasePath, { readOnly: true });
    expect(unchanged.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual(before);
    unchanged.close();
  });

  it("七次顶层工具额度按 generation/role 跨 repair 与仓储重启累计", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-tool-budget-")), "arena.sqlite");
    const first = new ExperimentRuntimeRepository(databasePath);
    first.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      compatibilityFingerprint: "compat",
    });
    for (let repair = 0; repair < 3; repair += 1) {
      expect(first.reserveTopLevelToolCall("exp", 1, "generator")).toBe(true);
      expect(first.reserveTopLevelToolCall("exp", 1, "generator")).toBe(true);
    }
    expect(first.reserveTopLevelToolCall("exp", 1, "generator")).toBe(true);
    first.close();
    const restarted = new ExperimentRuntimeRepository(databasePath);
    expect(restarted.reserveTopLevelToolCall("exp", 1, "generator")).toBe(false);
    expect(restarted.reserveTopLevelToolCall("exp", 1, "solver")).toBe(true);
    expect(restarted.reserveTopLevelToolCall("exp", 2, "generator")).toBe(true);
    restarted.close();
  });

  it("把旧版六次工具额度表迁移为七次并保留已有账本", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-tool-budget-migrate-")), "arena.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE generation_role_tool_calls (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      calls_used INTEGER NOT NULL CHECK (calls_used >= 0 AND calls_used <= 6),
      PRIMARY KEY (experiment_id, generation, role)
    )`);
    legacy.prepare("INSERT INTO generation_role_tool_calls VALUES (?, ?, ?, ?)").run("exp", 1, "generator", 6);
    legacy.close();

    const migrated = new ExperimentRuntimeRepository(databasePath);
    migrated.registerReady({
      experimentId: "exp", champions: { generator: "g", solver: "s" }, tokenLimit: 1_000,
      compatibilityFingerprint: "compat",
    });
    expect(migrated.reserveTopLevelToolCall("exp", 1, "generator")).toBe(true);
    expect(migrated.reserveTopLevelToolCall("exp", 1, "generator")).toBe(false);
    expect(MAX_TOP_LEVEL_TOOL_CALLS).toBe(7);
    migrated.close();
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
