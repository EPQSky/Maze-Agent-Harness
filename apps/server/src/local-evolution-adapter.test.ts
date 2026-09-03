import { describe, expect, it, vi } from "vitest";
import { createFrozenEvaluationCases } from "./local-evolution-adapter.js";

describe("本地自治评测适配器", () => {
  it("每个角色冻结 8 个公开案例和 24 个按代密封派生的隐藏案例", () => {
    const deriveHiddenSeed = vi.fn((experimentId: string, generation: number, caseId: string) =>
      `sealed:${experimentId}:${generation}:${caseId}`);
    const first = createFrozenEvaluationCases({ deriveHiddenSeed }, "exp", 3, "generator");
    const repeated = createFrozenEvaluationCases({ deriveHiddenSeed }, "exp", 3, "generator");

    expect(first.publicCases).toHaveLength(8);
    expect(first.hiddenCases).toHaveLength(24);
    expect(first).toEqual(repeated);
    expect(new Set(first.hiddenCases.map(({ seed }) => seed)).size).toBe(24);
    expect(first.publicCases.every(({ seed }) => !seed.includes(":3:"))).toBe(true);
    expect(deriveHiddenSeed).toHaveBeenCalledWith("exp", 3, "generator:24");
  });
});
