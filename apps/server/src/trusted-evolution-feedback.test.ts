import type { GenerationRoleResult } from "@maze-arena/contracts";
import {
  HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS,
  HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES,
  HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES,
  HARNESS_EVOLUTION_MAX_TRACE_EVENTS,
  HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS,
  harnessEvolutionTrustedInputBytes,
} from "@maze-arena/dsh-integration";
import { describe, expect, it } from "vitest";
import { assembleTrustedEvolutionFeedback } from "./trusted-evolution-feedback.js";

function roleResult(
  outcome: "promoted" | "failed" | "tie",
  attemptId: string,
  generation: number,
  hiddenCandidateAggregate: Record<string, number> = {
    gateFailures: 0,
    failedCases: outcome === "failed" ? 1 : 0,
    extraActions: generation,
    structuralNovelty: generation,
  },
): GenerationRoleResult {
  return {
    candidateCommit: `${attemptId}-candidate`, championBefore: "g0",
    championAfter: outcome === "promoted" ? `${attemptId}-candidate` : "g0",
    outcome, promotionTag: outcome === "promoted" ? `promotion/exp/generator/g${String(generation).padStart(4, "0")}` : null,
    publicProgress: 8, hiddenProgress: 24, aggregate: { primary: generation, failures: outcome === "failed" ? 1 : 0 },
    hiddenCandidateAggregate,
    trustedPublicTraces: [{
      attemptId, generation, traceId: `public-${generation}`, outcome: outcome === "failed" ? "failure" : outcome === "tie" ? "tie" : "success",
      metrics: { solved: outcome === "failed" ? 0 : 1, actions: generation },
      events: [{ type: "solver.decision", position: { x: 0, y: 0 }, openDirections: ["east"], remainingSteps: 10,
        direction: "east", kind: "move" }],
    }],
  };
}

describe("可信进化反馈组装", () => {
  it("按 attempt 关联己方策略与三类结果，并只汇总已完成代次的隐藏反馈", () => {
    const checkpoints = [
      { generation: 3, attemptId: "g0003-generator", result: roleResult("promoted", "g0003-generator", 3) },
      { generation: 1, attemptId: "g0001-generator", result: roleResult("failed", "g0001-generator", 1) },
      { generation: 2, attemptId: "g0002-generator", result: roleResult("tie", "g0002-generator", 2) },
    ];
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 4, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g3",
      runtime: { get: () => ({ champions: { generator: "g3", solver: "s0" } }) as never, listRoleCheckpoints: () => checkpoints },
      lineage: { listStrategyRecords: () => [
        { attemptId: "g0001-generator", strategyPlan: "避免重复失败方向" },
        { attemptId: "g0002-solver", strategyPlan: "对手私有计划" },
        { attemptId: "g0003-generator", strategyPlan: "保留晋级方法" },
      ] },
    });

    expect(feedback.lineagePlans).toEqual([
      { attemptId: "g0001-generator", strategyPlan: "避免重复失败方向" },
      { attemptId: "g0003-generator", strategyPlan: "保留晋级方法" },
    ]);
    expect(feedback.trustedResults.map(({ attemptId, outcome }) => [attemptId, outcome])).toEqual([
      ["g0001-generator", "failed"], ["g0002-generator", "tie"], ["g0003-generator", "promoted"],
    ]);
    expect(feedback.trustedResults.map(({ hiddenCandidateAggregate }) => hiddenCandidateAggregate)).toEqual([
      { extraActions: 1, failedCases: 1, gateFailures: 0, structuralNovelty: 1 },
      { extraActions: 2, failedCases: 0, gateFailures: 0, structuralNovelty: 2 },
      { extraActions: 3, failedCases: 0, gateFailures: 0, structuralNovelty: 3 },
    ]);
    expect(feedback.publicTraces.map(({ attemptId }) => attemptId)).toEqual([
      "g0001-generator", "g0002-generator", "g0003-generator",
    ]);
    expect(feedback.hiddenAggregate).toEqual({
      completedAttemptCount: 3, metricAvailableAttemptCount: 3, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 1, failedAttemptCount: 1, tieAttemptCount: 1,
      evaluatedHiddenCaseCount: 72,
      metricTotals: { extraActions: 6, failedCases: 1, gateFailures: 0, structuralNovelty: 6 },
    });
    const serialized = JSON.stringify(feedback);
    expect(serialized).not.toContain("g0002-solver");
    expect(serialized).not.toContain("对手私有计划");
    expect(serialized).not.toContain("seed");
  });

  it("公开成功而隐藏失败时只汇总独立持久化的隐藏候选指标", () => {
    const result = roleResult("failed", "g0001-generator", 1,
      { gateFailures: 0, failedCases: 24, extraActions: 0, structuralNovelty: 0 });
    result.aggregate = { publicSuccesses: 8, hiddenFailures: 24, totalSuccesses: 8 };
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result }] },
      lineage: { listStrategyRecords: () => [] },
    });

    expect(feedback.trustedResults[0]).toMatchObject({
      role: "generator", totalCandidateAggregate: { publicSuccesses: 8, hiddenFailures: 24, totalSuccesses: 8 },
      hiddenCandidateAggregate: { extraActions: 0, failedCases: 24, gateFailures: 0, structuralNovelty: 0 },
    });
    expect(feedback.hiddenAggregate.metricTotals).toEqual({ extraActions: 0, failedCases: 24, gateFailures: 0, structuralNovelty: 0 });
    expect(feedback.hiddenAggregate.metricTotals).not.toHaveProperty("publicSuccesses");
    expect(feedback.hiddenAggregate.metricTotals).not.toHaveProperty("totalSuccesses");
  });

  it("公开门禁失败的历史尝试可作为可信结果，但不会伪装成已完成隐藏评测", () => {
    const result = roleResult("failed", "g0001-generator", 1, {});
    result.hiddenProgress = 0;
    result.aggregate = { publicFailures: 1 };
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result }] },
      lineage: { listStrategyRecords: () => [] },
    });

    expect(feedback.trustedResults).toHaveLength(1);
    expect(feedback.trustedResults[0]).not.toHaveProperty("hiddenCandidateAggregate");
    expect(feedback.hiddenAggregate).toEqual({
      completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
      evaluatedHiddenCaseCount: 0, metricTotals: {},
    });
  });

  it("兼容缺少隐藏候选聚合的旧检查点并明确标记指标不可用", () => {
    const legacy = roleResult("tie", "g0001-generator", 1);
    delete legacy.hiddenCandidateAggregate;
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result: legacy }] },
      lineage: { listStrategyRecords: () => [] },
    });

    expect(feedback.trustedResults).toEqual([expect.objectContaining({
      attemptId: "g0001-generator", outcome: "tie", totalCandidateAggregate: { failures: 0, primary: 1 },
    })]);
    expect(feedback.trustedResults[0]).not.toHaveProperty("hiddenCandidateAggregate");
    expect(feedback.publicTraces).toHaveLength(1);
    expect(feedback.hiddenAggregate).toEqual({
      completedAttemptCount: 1, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 1,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 1,
      evaluatedHiddenCaseCount: 24, metricTotals: {},
    });
  });

  it("允许已有隐藏指标能力但合法指标表为空，并保持完整计数不变量", () => {
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator",
          result: roleResult("tie", "g0001-generator", 1, {}) }] },
      lineage: { listStrategyRecords: () => [] },
    });

    expect(feedback.hiddenAggregate).toEqual({
      completedAttemptCount: 1, metricAvailableAttemptCount: 1, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 1,
      evaluatedHiddenCaseCount: 24, metricTotals: {},
    });
  });

  it("拒绝会令隐藏聚合违反安全数值不变量的持久化检查点", () => {
    const first = roleResult("tie", "g0001-generator", 1, { extraActions: Number.MAX_SAFE_INTEGER });
    const second = roleResult("tie", "g0002-generator", 2, { extraActions: 1 });
    second.hiddenProgress = Number.MAX_SAFE_INTEGER;
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 3, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [
          { generation: 1, attemptId: "g0001-generator", result: first },
          { generation: 2, attemptId: "g0002-generator", result: second },
        ] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/累计溢出|累计计数非法/);
  });

  it("拒绝重复代次、隐藏指标越权及重复公开轨迹身份", () => {
    const first = roleResult("tie", "g0001-generator", 1);
    const duplicateTrace = roleResult("tie", "g0002-generator", 2);
    duplicateTrace.trustedPublicTraces![0] = {
      ...duplicateTrace.trustedPublicTraces![0]!, attemptId: "g0002-generator", generation: 2, traceId: "shared",
    };
    duplicateTrace.trustedPublicTraces!.push({ ...duplicateTrace.trustedPublicTraces![0]! });
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 3, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [
          { generation: 1, attemptId: "g0001-generator", result: first },
          { generation: 1, attemptId: "g0001-generator", result: first },
        ] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/代次必须唯一/);
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 3, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 2, attemptId: "g0002-generator", result: duplicateTrace }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/公开轨迹身份必须唯一/);
    const forgedMetric = roleResult("tie", "g0001-generator", 1, { caseId: 12345 });
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result: forgedMetric }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/隐藏指标字段或数值非法/);
  });

  it("长期历史只保留规范排序的最近窗口并维持全部引用关联", () => {
    const historyLength = 3_800;
    const checkpoints = Array.from({ length: historyLength }, (_, index) => {
      const generation = historyLength - index;
      const attemptId = `g${String(generation).padStart(4, "0")}-generator`;
      return { generation, attemptId, result: roleResult("tie", attemptId, generation) };
    });
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: historyLength + 1, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => checkpoints },
      lineage: { listStrategyRecords: () => checkpoints.map(({ attemptId }) => ({ attemptId, strategyPlan: `策略-${attemptId}` })) },
    });

    const firstRetainedGeneration = historyLength - HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS + 1;
    expect(feedback.trustedResults).toHaveLength(HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS);
    expect(feedback.trustedResults.map(({ generation }) => generation)).toEqual(
      Array.from({ length: HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS }, (_, index) => firstRetainedGeneration + index),
    );
    const retainedAttempts = new Set(feedback.trustedResults.map(({ attemptId }) => attemptId));
    expect(feedback.lineagePlans).toHaveLength(16);
    expect(feedback.lineagePlans.every(({ attemptId }) => retainedAttempts.has(attemptId))).toBe(true);
    expect(feedback.publicTraces).toHaveLength(16);
    expect(feedback.publicTraces.every(({ attemptId }) => retainedAttempts.has(attemptId))).toBe(true);
    expect(feedback.hiddenAggregate).toMatchObject({
      completedAttemptCount: HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS,
      metricAvailableAttemptCount: HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS,
      metricUnavailableAttemptCount: 0,
      evaluatedHiddenCaseCount: HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS * 24,
    });
    expect(Buffer.byteLength(JSON.stringify(feedback), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("截取历史窗口前审计早期结果、隐藏指标、公开轨迹和全历史唯一性", () => {
    const checkpoints = Array.from({ length: HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS + 1 }, (_, index) => {
      const generation = index + 1;
      const attemptId = `g${String(generation).padStart(4, "0")}-generator`;
      return { generation, attemptId, result: roleResult("tie", attemptId, generation) };
    });
    checkpoints[0]!.result.aggregate = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [`metric${index}`, index]),
    );
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: checkpoints.length + 1, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => checkpoints },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/聚合字段超过数量上限/);

    checkpoints[0]!.result = roleResult("tie", checkpoints[0]!.attemptId, 1);
    checkpoints[0]!.result.trustedPublicTraces![0]!.traceId = "shared-trace";
    checkpoints[0]!.result.trustedPublicTraces!.push({ ...checkpoints[0]!.result.trustedPublicTraces![0]! });
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: checkpoints.length + 1, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => checkpoints },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/公开轨迹身份必须唯一/);
  });

  it("在指标、事件、UTF-8 策略和反馈总字节边界上保持确定性上限", () => {
    const result = roleResult("tie", "g0001-generator", 1);
    result.aggregate = Object.fromEntries(
      Array.from({ length: HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS }, (_, index) => [`metric${index}`, index]),
    );
    result.trustedPublicTraces![0]!.events = Array.from(
      { length: HARNESS_EVOLUTION_MAX_TRACE_EVENTS },
      () => ({ type: "maze.completed" as const, passageCount: 960 }),
    );
    const feedback = assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result }] },
      lineage: { listStrategyRecords: () => [{ attemptId: "g0001-generator", strategyPlan: `${"策".repeat(2_730)}ab` }] },
    });
    expect(Object.keys(feedback.trustedResults[0]!.totalCandidateAggregate)).toHaveLength(HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS);
    expect(feedback.publicTraces[0]!.events).toHaveLength(HARNESS_EVOLUTION_MAX_TRACE_EVENTS);
    expect(Buffer.byteLength(feedback.lineagePlans[0]!.strategyPlan, "utf8")).toBe(HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES);
    expect(harnessEvolutionTrustedInputBytes({ role: "generator", championRoot: "/tmp/可信反馈", ...feedback }))
      .toBeLessThanOrEqual(HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES);

    result.trustedPublicTraces![0]!.events.push({ type: "maze.completed", passageCount: 960 });
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/事件超过数量上限/);
  });

  it("拒绝尝试身份错配及非白名单公开事件", () => {
    const invalid = roleResult("tie", "forged-attempt", 1);
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result: invalid }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/尝试身份不一致/);

    const forbidden = roleResult("tie", "g0001-generator", 1);
    forbidden.trustedPublicTraces![0]!.events = [{ type: "solver.decision", position: { x: 0, y: 0 }, openDirections: ["east"],
      remainingSteps: 10, direction: "east", kind: "move", prompt: "forbidden" } as never];
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation: 1, attemptId: "g0001-generator", result: forbidden }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/非白名单事件/);
  });

  it.each([
    ["角色错配", 1, "g0001-solver"],
    ["当前代次", 2, "g0002-generator"],
    ["未来代次", 3, "g0003-generator"],
  ] as const)("拒绝%s的可信检查点", (_label, generation, attemptId) => {
    expect(() => assembleTrustedEvolutionFeedback({
      experimentId: "exp", generation: 2, role: "generator", championRoot: "/tmp/可信反馈", frozenChampion: "g0",
      runtime: { get: () => ({ champions: { generator: "g0", solver: "s0" } }) as never,
        listRoleCheckpoints: () => [{ generation, attemptId, result: roleResult("tie", attemptId, generation) }] },
      lineage: { listStrategyRecords: () => [] },
    })).toThrow(/角色、代次或尝试身份不一致/);
  });
});
