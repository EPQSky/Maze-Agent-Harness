import { describe, expect, it } from "vitest";
import {
  buildActiveOpponentPool,
  createGenerationEvaluationPlan,
  generatorDiversityPassed,
  historyRegressionPassed,
  requiresFullHistoryRegression,
} from "./index.js";

describe("活跃对手池与历史回归", () => {
  it("无历史启动时去重基线与冠军", () => {
    expect(buildActiveOpponentPool({ baseline: "a", champion: "a", recentChampions: [], historicalResults: [] }))
      .toEqual([{ commit: "a", category: "baseline" }]);
  });

  it("最多保留六个不同版本并处理类别重叠", () => {
    const pool = buildActiveOpponentPool({
      baseline: "base", champion: "current", recentChampions: ["current", "recent-1", "recent-2"],
      historicalResults: [
        { opponentCommit: "base", primaryMetric: 0 }, { opponentCommit: "hard-2", primaryMetric: 1 },
        { opponentCommit: "hard-1", primaryMetric: 1 }, { opponentCommit: "hard-3", primaryMetric: 2 },
      ],
    });
    expect(pool.map(({ commit }) => commit)).toEqual(["base", "current", "recent-1", "recent-2", "hard-1", "hard-2"]);
    expect(new Set(pool.map(({ commit }) => commit)).size).toBe(pool.length);
  });

  it("历史强敌同分时按提交哈希稳定排序", () => {
    const pool = buildActiveOpponentPool({
      baseline: "base", champion: "champ", recentChampions: [],
      historicalResults: [{ opponentCommit: "bbb", primaryMetric: 1 }, { opponentCommit: "aaa", primaryMetric: 1 }],
    });
    expect(pool.slice(-2).map(({ commit }) => commit)).toEqual(["aaa", "bbb"]);
  });

  it("每代固定 8 个公开与 24 个隐藏案例并在排序对手池上均衡轮转", () => {
    const opponents = buildActiveOpponentPool({ baseline: "b", champion: "a", recentChampions: ["c"], historicalResults: [] });
    const first = createGenerationEvaluationPlan({ experimentId: "exp", role: "generator", generation: 3, opponents });
    const second = createGenerationEvaluationPlan({ experimentId: "exp", role: "generator", generation: 3, opponents });
    expect(first).toEqual(second);
    expect(first.filter(({ visibility }) => visibility === "public")).toHaveLength(8);
    expect(first.filter(({ visibility }) => visibility === "hidden")).toHaveLength(24);
    expect(first.slice(0, 6).map(({ opponentCommit }) => opponentCommit)).toEqual(["a", "b", "c", "a", "b", "c"]);
    const nextGeneration = createGenerationEvaluationPlan({ experimentId: "exp", role: "generator", generation: 4, opponents });
    expect(nextGeneration.slice(0, 8).map(({ seed }) => seed)).toEqual(first.slice(0, 8).map(({ seed }) => seed));
    expect(nextGeneration.slice(8).map(({ seed }) => seed)).not.toEqual(first.slice(8).map(({ seed }) => seed));
  });

  it("第五代扩展历史回归并逐对手组禁止公开首要指标退化", () => {
    expect([1, 4, 5, 10].map(requiresFullHistoryRegression)).toEqual([false, false, true, true]);
    expect(historyRegressionPassed([{ opponentCommit: "a", candidatePublicPrimary: 2, championPublicPrimary: 2 }])).toBe(true);
    expect(historyRegressionPassed([{ opponentCommit: "a", candidatePublicPrimary: 1, championPublicPrimary: 2 }])).toBe(false);
  });

  it("每代 32 个迷宫至少需要 29 个不同规范拓扑哈希", () => {
    expect(generatorDiversityPassed(Array.from({ length: 32 }, (_, index) => `h${index % 29}`))).toBe(true);
    expect(generatorDiversityPassed(Array.from({ length: 32 }, (_, index) => `h${index % 28}`))).toBe(false);
  });
});
