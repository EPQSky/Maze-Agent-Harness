import type { GenerationRoleResult } from "@maze-arena/contracts";
import { describe, expect, it } from "vitest";
import { CandidateEvaluationFacts } from "./candidate-evaluation-facts.js";

function traces(traceId: string): NonNullable<GenerationRoleResult["trustedPublicTraces"]> {
  return [{
    attemptId: "g0001-generator", generation: 1, traceId, outcome: "failure", metrics: { failed: 1 },
    events: [{ type: "maze.completed", passageCount: 960 }],
  }];
}

describe("候选评测事实关联", () => {
  it("最终公开退化保留当前候选的公开聚合、轨迹和类型化诊断", () => {
    const facts = new CandidateEvaluationFacts();
    facts.beginRepairAttempt();
    facts.recordPublicSuccess({ caseCount: 8, aggregate: { failures: 8 }, traces: traces("final-regression"), regressed: true });

    expect(facts).toMatchObject({
      publicProgress: 8, hiddenProgress: 0, aggregate: { failures: 8 }, diagnostics: ["PUBLIC_PRIMARY_REGRESSION"],
    });
    expect(facts.publicTraces[0]?.traceId).toBe("final-regression");
  });

  it("隐藏评测异常保留同一候选公开事实并追加稳定诊断", () => {
    const facts = new CandidateEvaluationFacts();
    facts.beginRepairAttempt();
    facts.recordPublicSuccess({ caseCount: 8, aggregate: { publicSuccesses: 8 }, traces: traces("hidden-throw"), regressed: false });
    facts.recordHiddenFailure();

    expect(facts).toMatchObject({
      publicProgress: 8, hiddenProgress: 0, outcome: "failed",
      aggregate: { publicSuccesses: 8 }, diagnostics: ["HIDDEN_EVALUATION_FAILED"],
    });
    expect(facts.publicTraces[0]?.traceId).toBe("hidden-throw");
  });

  it("开始修复候选时清空旧公开事实，成功隐藏评测只更新同一候选总量和隐藏量", () => {
    const facts = new CandidateEvaluationFacts();
    facts.beginRepairAttempt();
    facts.recordPublicSuccess({ caseCount: 8, aggregate: { stale: 8 }, traces: traces("stale"), regressed: true });

    facts.beginRepairAttempt();
    expect(facts).toMatchObject({ publicProgress: 0, aggregate: {}, publicTraces: [], diagnostics: [] });
    facts.recordPublicSuccess({ caseCount: 8, aggregate: { publicSuccesses: 8 }, traces: traces("repaired"), regressed: false });
    facts.recordHiddenSuccess({ caseCount: 24, outcome: "promoted", aggregate: { totalSuccesses: 32 }, hiddenCandidateAggregate: { hiddenSuccesses: 24 } });

    expect(facts).toMatchObject({
      publicProgress: 8, hiddenProgress: 24, outcome: "promoted",
      aggregate: { totalSuccesses: 32 }, hiddenCandidateAggregate: { hiddenSuccesses: 24 }, diagnostics: [],
    });
    expect(facts.publicTraces.map(({ traceId }) => traceId)).toEqual(["repaired"]);
  });
});
