import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvolutionRole, GenerationRoleResult, ModelProfile } from "@maze-arena/contracts";
import { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditRepository } from "./audit-repository.js";
import { AutonomousExperimentRunner, type AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import { ExperimentRepository } from "./experiment-repository.js";

const resources: Array<{ close(): void | Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(resources.splice(0).reverse().map((resource) => resource.close())); });

const profile: ModelProfile = {
  providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
  contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 10_000,
  providerLabel: "Fake", modelLabel: "Fake",
};

function setup(adapter: AutonomousEvolutionAdapter, tokenLimit = 20, costLimit?: number) {
  const root = mkdtempSync(join(tmpdir(), "maze-autonomous-runner-"));
  const databasePath = join(root, "arena.sqlite");
  const experiments = new ExperimentRepository(databasePath, join(root, "harness"));
  const experiment = experiments.create("自治运行测试", profile);
  const runtime = new ExperimentRuntimeRepository(databasePath);
  runtime.registerReady({ experimentId: experiment.id, champions: { generator: "g0", solver: "s0" }, tokenLimit, costLimit, compatibilityFingerprint: "compat" });
  runtime.start(experiment.id);
  experiments.setStatus(experiment.id, "running");
  const audits = new AuditRepository(databasePath);
  const runner = new AutonomousExperimentRunner(runtime, experiments, audits, adapter);
  resources.push(runner, audits, runtime, experiments);
  return { experiment, runtime, runner, experiments };
}

function result(role: EvolutionRole, champion: string, outcome: "promoted" | "failed" | "tie", generation: number): GenerationRoleResult {
  const candidate = `${role}-${generation}`;
  return {
    candidateCommit: candidate,
    championBefore: champion,
    championAfter: outcome === "promoted" ? candidate : champion,
    outcome,
    promotionTag: outcome === "promoted" ? `promotion/exp/${role}/g${String(generation).padStart(4, "0")}` : null,
    publicProgress: 1,
    hiddenProgress: 1,
    aggregate: { primary: outcome === "promoted" ? 2 : 1 },
  };
}

async function waitForState(runtime: ExperimentRuntimeRepository, id: string, state: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = runtime.get(id)!;
    if (snapshot.state === state) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待状态 ${state} 超时`);
}

describe("自治实验后台运行器", () => {
  it.each([
    ["单方晋级", { generator: "promoted", solver: "failed" }],
    ["双方晋级", { generator: "promoted", solver: "promoted" }],
    ["双方失败", { generator: "failed", solver: "failed" }],
    ["完全平局", { generator: "tie", solver: "tie" }],
  ] as const)("覆盖%s并在统一代提交后执行预算暂停", async (_label, outcomes) => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: async ({ role, generation, frozenChampions }) => ({
        result: result(role, frozenChampions[role], outcomes[role], generation), usage: { tokens: 10, cost: 0 },
      }),
      createChampionExhibition: async ({ checkpointId }) => checkpointId,
    };
    const { experiment, runtime, runner } = setup(adapter);
    runner.launch(experiment.id);
    const snapshot = await waitForState(runtime, experiment.id, "paused");
    expect(snapshot).toMatchObject({ generation: 1, usage: { tokens: 20, cost: 0 } });
    expect(snapshot.generations[0]?.exhibitionMatchId).toContain("g1-champions");
    expect(snapshot.champions.generator).toBe(outcomes.generator === "promoted" ? "generator-1" : "g0");
    expect(snapshot.champions.solver).toBe(outcomes.solver === "promoted" ? "solver-1" : "s0");
  });

  it("连续提供方错误恰好重试三次并暂停且不消耗代次", async () => {
    const runRole = vi.fn(async () => { throw new Error("提供方限流"); });
    const { experiment, runtime, runner } = setup({ runRole });
    runner.launch(experiment.id);
    const snapshot = await waitForState(runtime, experiment.id, "paused");
    expect(runRole).toHaveBeenCalledTimes(3);
    expect(snapshot).toMatchObject({ generation: 0, stagnationCount: 0, usage: { tokens: 0, cost: 0 } });
  });

  it("重启恢复复用已提交角色检查点，不重复调用或计费", async () => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: vi.fn(async ({ role, generation, frozenChampions }) => ({
        result: result(role, frozenChampions[role], "tie", generation), usage: { tokens: 10, cost: 0 },
      })),
    };
    const { experiment, runtime, runner } = setup(adapter);
    runtime.saveRoleCheckpoint({ experimentId: experiment.id, generation: 1, role: "generator", attemptId: "g0001-generator",
      result: result("generator", "g0", "tie", 1), tokens: 10, cost: 0 });
    runner.resumePersisted();
    const snapshot = await waitForState(runtime, experiment.id, "paused");
    expect(adapter.runRole).toHaveBeenCalledTimes(1);
    expect(adapter.runRole).toHaveBeenCalledWith(expect.objectContaining({ role: "solver", generation: 1 }));
    expect(snapshot.usage.tokens).toBe(20);
  });

  it("重启时以运行时账本修复实验列表状态后再恢复任务", async () => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: ({ signal }) => new Promise((_resolve, reject) => {
        if (signal.aborted) { reject(new Error("已取消")); return; }
        signal.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
      }),
    };
    const { experiment, runner, experiments } = setup(adapter, 1_000);
    experiments.setStatus(experiment.id, "draft");
    runner.resumePersisted();
    expect(experiments.find(experiment.id)?.status).toBe("running");
  });

  it("持续有晋级时运行到第 20 代自动完成", async () => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: async ({ role, generation, frozenChampions }) => ({
        result: result(role, frozenChampions[role], role === "generator" ? "promoted" : "tie", generation),
        usage: { tokens: 0, cost: 0 },
      }),
    };
    const { experiment, runtime, runner } = setup(adapter, 1_000);
    runner.launch(experiment.id);
    const snapshot = await waitForState(runtime, experiment.id, "completed");
    expect(snapshot).toMatchObject({ generation: 20, stagnationCount: 0, champions: { generator: "generator-20" } });
  });

  it("可信成本达到可选上限后在完整代边界暂停", async () => {
    const adapter: AutonomousEvolutionAdapter = {
      runRole: async ({ role, generation, frozenChampions }) => ({
        result: result(role, frozenChampions[role], "tie", generation), usage: { tokens: 1, cost: 0.6 },
      }),
    };
    const { experiment, runtime, runner } = setup(adapter, 1_000, 1);
    runner.launch(experiment.id);
    const snapshot = await waitForState(runtime, experiment.id, "paused");
    expect(snapshot).toMatchObject({ generation: 1, usage: { tokens: 2, cost: 1.2 }, budget: { costLimit: 1 } });
  });
});
