import type { EvolutionRole, ExperimentRuntimeSnapshot, GenerationRoleResult } from "@maze-arena/contracts";
import { ExperimentRuntimeRepository, withProviderRetry } from "@maze-arena/control-plane";
import { HarnessInvocationError } from "./harness-invocation-error.js";
import type { AuditRepository } from "./audit-repository.js";
import type { ExperimentRepository } from "./experiment-repository.js";

export interface AutonomousRoleExecution {
  result: GenerationRoleResult;
  usage: { tokens: number; cost: number };
}

export interface AutonomousEvolutionAdapter {
  runRole(input: {
    experimentId: string;
    generation: number;
    role: EvolutionRole;
    attemptId: string;
    frozenChampions: Readonly<Record<EvolutionRole, string>>;
    compatibilityFingerprint: string;
    signal: AbortSignal;
  }): Promise<AutonomousRoleExecution>;
  createChampionExhibition?(input: {
    experimentId: string; generation: number; checkpointId: string;
    generatorCommit: string; solverCommit: string; signal: AbortSignal;
  }): Promise<string>;
}

export class AutonomousExperimentRunner {
  private readonly tasks = new Map<string, { controller: AbortController; task: Promise<void> }>();

  constructor(
    private readonly runtime: ExperimentRuntimeRepository,
    private readonly experiments: ExperimentRepository,
    private readonly audits: AuditRepository,
    private readonly adapter: AutonomousEvolutionAdapter,
    private readonly backupTerminal: (experimentId: string) => void = () => undefined,
    private readonly backupStart: (experimentId: string) => void = () => undefined,
  ) {}

  resumePersisted(): void {
    for (const snapshot of this.runtime.list()) {
      this.experiments.setStatus(snapshot.experimentId, experimentStatus(snapshot));
      if (snapshot.state === "running") {
        this.backupStart(snapshot.experimentId);
        this.launch(snapshot.experimentId);
      }
    }
  }

  launch(experimentId: string): void {
    if (this.tasks.has(experimentId)) return;
    const controller = new AbortController();
    const task = this.run(experimentId, controller.signal).finally(() => this.tasks.delete(experimentId));
    this.tasks.set(experimentId, { controller, task });
  }

  async cancel(experimentId: string): Promise<void> {
    const active = this.tasks.get(experimentId);
    active?.controller.abort();
    if (active) await active.task;
  }

  async pause(experimentId: string): Promise<ExperimentRuntimeSnapshot> {
    const active = this.tasks.get(experimentId);
    active?.controller.abort();
    if (active) await active.task;
    const current = this.runtime.get(experimentId);
    const paused = current?.state === "running" && current.pauseRequested
      ? this.runtime.completeRequestedPause(experimentId)
      : current;
    if (!paused) throw new Error("实验运行时不存在");
    this.experiments.setStatus(experimentId, experimentStatus(paused));
    return paused;
  }

  async close(): Promise<void> {
    for (const { controller } of this.tasks.values()) controller.abort();
    await Promise.allSettled([...this.tasks.values()].map(({ task }) => task));
  }

  private async run(experimentId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const before = this.runtime.get(experimentId);
      if (!before || before.state !== "running") return;
      const generation = before.generation + 1;
      const champions = Object.freeze({ ...before.champions });
      const results = {} as Record<EvolutionRole, GenerationRoleResult>;
      const uncheckpointedUsage = { tokens: 0, cost: 0 };
      try {
        for (const role of ["generator", "solver"] as const) {
          const checkpoint = this.runtime.getRoleCheckpoint(experimentId, generation, role);
          if (checkpoint) { results[role] = checkpoint.result; continue; }
          const attemptId = `g${String(generation).padStart(4, "0")}-${role}`;
          const execution = await withProviderRetry(() => {
            if (signal.aborted) return Promise.reject(new Error("自治任务已取消"));
            return this.adapter.runRole({
              experimentId, generation, role, attemptId, frozenChampions: champions,
              compatibilityFingerprint: before.compatibilityFingerprint, signal,
            });
          }, async (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 10)), (error) => {
            if (error instanceof HarnessInvocationError && error.usage) {
              uncheckpointedUsage.tokens += error.usage.tokens;
              uncheckpointedUsage.cost += error.usage.cost;
            }
            return !signal.aborted && error instanceof HarnessInvocationError && error.kind === "transient-provider";
          });
          execution.usage.tokens += uncheckpointedUsage.tokens;
          execution.usage.cost += uncheckpointedUsage.cost;
          validateRoleResult(role, champions[role], execution);
          this.runtime.saveRoleCheckpoint({ experimentId, generation, role, attemptId, ...execution.usage, result: execution.result });
          uncheckpointedUsage.tokens = 0;
          uncheckpointedUsage.cost = 0;
          results[role] = execution.result;
          // 已完成的角色副作用必须先落检查点，暂停或取消才能从下一原子步骤恢复。
          if (signal.aborted) return;
        }
      } catch (error) {
        if (uncheckpointedUsage.tokens > 0 || uncheckpointedUsage.cost > 0) {
          this.runtime.recordUsage(experimentId, uncheckpointedUsage.tokens, uncheckpointedUsage.cost);
        }
        if (signal.aborted) return;
        // Provider 与模型控制的异常文本不得进入运行时状态或公开审计，只持久化稳定分类。
        const failureCategory = error instanceof HarnessInvocationError ? `harness-${error.kind}` : "unknown-provider-failure";
        const paused = this.runtime.recordInfrastructureFailure(experimentId, failureCategory);
        this.experiments.setStatus(experimentId, experimentStatus(paused));
        this.audits.append(experimentId, "runtime.paused", { reason: paused.phase });
        return;
      }

      let exhibitionMatchId: string | undefined;
      try {
        exhibitionMatchId = this.adapter.createChampionExhibition
          ? await this.adapter.createChampionExhibition({ experimentId, generation,
            checkpointId: `${experimentId}-g${generation}-champions`, generatorCommit: results.generator.championAfter,
            solverCommit: results.solver.championAfter, signal })
          : undefined;
      } catch (error) {
        if (signal.aborted) return;
        const failed = this.runtime.fail(experimentId, error instanceof Error ? error.message : "展示局创建失败");
        this.experiments.setStatus(experimentId, experimentStatus(failed));
        this.backupTerminal(experimentId);
        return;
      }
      let committed: ExperimentRuntimeSnapshot | undefined;
      for (let attempt = 1; attempt <= 2 && !committed; attempt += 1) {
        try {
          if (signal.aborted) return;
          committed = this.runtime.commitGeneration({ experimentId, generator: results.generator, solver: results.solver,
            exhibitionMatchId, checkpointKey: `generation-${generation}` });
        } catch (error) {
          if (attempt === 2) {
            const failed = this.runtime.fail(experimentId, error instanceof Error ? error.message : "Arena 提交失败");
            this.experiments.setStatus(experimentId, experimentStatus(failed));
            this.backupTerminal(experimentId);
            return;
          }
        }
      }
      if (!committed) return;
      this.experiments.setStatus(experimentId, experimentStatus(committed));
      this.audits.append(experimentId, "generation.committed", {
        generation: committed.generation,
        generatorStart: results.generator.championBefore,
        generatorChampion: results.generator.championAfter,
        solverStart: results.solver.championBefore,
        solverChampion: results.solver.championAfter,
      });
      if (committed.state !== "running") {
        this.backupTerminal(experimentId);
        return;
      }
      await Promise.resolve();
    }
  }
}

function experimentStatus(snapshot: ExperimentRuntimeSnapshot): "draft" | "running" | "paused" | "completed" | "failed" | "cancelled" {
  return snapshot.state === "ready" ? "draft" : snapshot.state;
}

function validateRoleResult(role: EvolutionRole, champion: string, execution: AutonomousRoleExecution): void {
  if (!Number.isInteger(execution.usage.tokens) || execution.usage.tokens < 0
    || !Number.isFinite(execution.usage.cost) || execution.usage.cost < 0) throw new Error("Harness 返回了非法用量");
  if (execution.result.championBefore !== champion) throw new Error(`${role} 未使用冻结冠军快照`);
  if (execution.result.outcome === "promoted" && (!execution.result.promotionTag || execution.result.championAfter !== execution.result.candidateCommit)) {
    throw new Error(`${role} 晋级结果缺少完整 Promotion Tag 或冠军引用`);
  }
}
