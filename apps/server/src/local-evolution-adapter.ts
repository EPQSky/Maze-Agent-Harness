import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Experiment, GeneratorCapability, MazeDirection, SolverCapability } from "@maze-arena/contracts";
import { HARNESS_EVOLUTION_PROTOCOL_VERSION, type HarnessAdapter, type HarnessEvolutionResponse } from "@maze-arena/dsh-integration";
import { runEvolutionAttempt } from "@maze-arena/evolution";
import {
  compareGeneratorScores,
  compareSolverScores,
  evaluateGeneratorPair,
  evaluateSolverPair,
  type FrozenEvaluationContext,
  type GeneratorEvaluationPlugin,
  type SolverEvaluationPlugin,
} from "@maze-arena/evaluation";
import { GOAL, START, runSolverOnMaze, type MazeSnapshot, type SolverPolicy } from "@maze-arena/engine";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import { validatePluginPackage } from "@maze-arena/match-profile";
import type { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import type { AuditRepository } from "./audit-repository.js";
import type { AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import type { ExperimentRepository } from "./experiment-repository.js";
import { HarnessInvocationError } from "./harness-invocation-error.js";

export function createLocalEvolutionAdapter(options: {
  harness: HarnessAdapter;
  experiments: ExperimentRepository;
  lineage: PluginLineageRepository;
  runtime: ExperimentRuntimeRepository;
  audits: AuditRepository;
  startExhibition(input: {
    experimentId: string; seed: string; generatorCommit: string; solverCommit: string;
    generation?: number; exhibitionId?: string;
  }): string;
}): AutonomousEvolutionAdapter {
  return {
    async runRole(input) {
      const experiment = requireExperiment(options.experiments, input.experimentId);
      if (!experiment.modelProfile || !options.harness.evolvePlugin) throw new Error("当前 Harness 未配置自治插件进化能力");
      const scratch = mkdtempSync(join(tmpdir(), `maze-evolve-${input.role}-`));
      const championRoot = join(scratch, "champion");
      const opponentRoot = join(scratch, "opponent");
      options.lineage.materialize(input.experimentId, input.role, input.frozenChampions[input.role], championRoot);
      const opponentRole = input.role === "generator" ? "solver" : "generator";
      options.lineage.materialize(input.experimentId, opponentRole, input.frozenChampions[opponentRole], opponentRoot);
      let provider: HarnessEvolutionResponse | undefined;
      const trustedUsage = { tokens: 0, cost: 0 };
      let publicProgress = 0;
      let hiddenProgress = 0;
      let evaluatedOutcome: "promoted" | "failed" | "tie" = "failed";
      let aggregate: Record<string, number> = {};
      const context: FrozenEvaluationContext = {
        opponentVersion: input.frozenChampions[opponentRole],
        imageDigest: "versioned-local-plugin-v1",
        resourcePolicyDigest: "isolated-profile-v1",
      };
      const { publicCases, hiddenCases } = createFrozenEvaluationCases(
        options.runtime, input.experimentId, input.generation, input.role,
      );
      const allCases = [...publicCases, ...hiddenCases];
      try {
        const attempt = await runEvolutionAttempt({
          experimentId: input.experimentId,
          generation: input.generation,
          attemptId: input.attemptId,
          role: input.role,
          championRoot,
          isolatedRoot: join(scratch, "attempts"),
          input: { lineagePlans: [], trustedResults: [], publicTraces: [], hiddenAggregate: {} },
          createSession: () => {
            const sessionId = randomUUID();
            return {
              run: async (sessionRequest) => {
                if (input.signal.aborted) throw new Error("自治任务已取消");
                try {
                  provider = await options.harness.evolvePlugin!({
                    sessionId,
                    experimentId: input.experimentId, generation: input.generation, role: input.role,
                    attemptId: input.attemptId, modelProfile: experiment.modelProfile!,
                    home: sessionRequest.home, workspace: sessionRequest.workspace,
                    input: sessionRequest.input, allowedTools: sessionRequest.allowedTools,
                    repairAttempt: sessionRequest.repairAttempt, diagnostics: sessionRequest.diagnostics,
                    signal: input.signal,
                  });
                } catch (error) {
                  const currentInvocation = error instanceof HarnessInvocationError ? error : undefined;
                  const execution = currentInvocation?.execution ?? provider?.execution;
                  options.audits.append(input.experimentId, "harness.activity", {
                    role: input.role,
                    attemptId: input.attemptId,
                    executionKind: execution?.kind ?? "unknown",
                    protocolVersion: execution?.protocolVersion ?? HARNESS_EVOLUTION_PROTOCOL_VERSION,
                    sessionId: execution?.sessionId ?? sessionId,
                    harnessVersion: execution?.harnessVersion ?? "unknown",
                    providerId: execution?.providerId ?? experiment.modelProfile!.providerId,
                    modelId: execution?.modelId ?? experiment.modelProfile!.modelId,
                    outcome: "failed",
                    failureKind: currentInvocation?.kind ?? "unknown",
                    usageTokens: currentInvocation?.usage?.tokens ?? null,
                    usageCost: currentInvocation?.usage?.cost ?? null,
                  });
                  const hasTrustedUsage = trustedUsage.tokens > 0 || trustedUsage.cost > 0 || currentInvocation?.usage !== undefined;
                  throw new HarnessInvocationError(
                    currentInvocation?.message ?? "Harness 自治调用失败",
                    currentInvocation?.kind ?? "process",
                    hasTrustedUsage ? {
                      tokens: trustedUsage.tokens + (currentInvocation?.usage?.tokens ?? 0),
                      cost: trustedUsage.cost + (currentInvocation?.usage?.cost ?? 0),
                    } : undefined,
                    execution,
                  );
                }
                trustedUsage.tokens += provider.usage.tokens;
                trustedUsage.cost += provider.usage.cost;
                options.audits.append(input.experimentId, "harness.activity", {
                  role: input.role, attemptId: input.attemptId,
                  executionKind: provider.execution.kind,
                  protocolVersion: provider.execution.protocolVersion,
                  sessionId: provider.execution.sessionId,
                  harnessVersion: provider.execution.harnessVersion,
                  providerId: provider.execution.providerId,
                  modelId: provider.execution.modelId,
                  outcome: "succeeded",
                  usageTokens: provider.usage.tokens,
                  usageCost: provider.usage.cost,
                });
                return provider;
              },
              close: () => undefined,
            };
          },
          publicGate: async (workspace) => {
            try {
              await validatePluginPackage(workspace);
              const evaluation = await evaluateRole(input.role, workspace, championRoot, opponentRoot, publicCases, context);
              publicProgress = publicCases.length;
              return { passed: !evaluation.publicRegressed, diagnostics: evaluation.publicRegressed ? ["公开配对评测发生首要指标退化"] : [] };
            }
            catch (error) { return { passed: false, diagnostics: [error instanceof Error ? error.message : "公开门禁失败"] }; }
          },
          hiddenEvaluate: async (workspace) => {
            try {
              const evaluation = await evaluateRole(input.role, workspace, championRoot, opponentRoot, allCases, context);
              hiddenProgress = hiddenCases.length;
              evaluatedOutcome = evaluation.outcome;
              aggregate = evaluation.aggregate;
              return { promote: evaluation.outcome === "promoted", outcome: evaluation.outcome, resultSummary: evaluation.summary };
            } catch (error) {
              evaluatedOutcome = "failed";
              return { promote: false, resultSummary: error instanceof Error ? error.message : "隐藏评测失败" };
            }
          },
          lineage: options.lineage,
        });
        const championBefore = input.frozenChampions[input.role];
        const candidateCommit = attempt.candidate?.commit ?? championBefore;
        return {
          result: {
            candidateCommit, championBefore, championAfter: attempt.promoted ? candidateCommit : championBefore,
            outcome: attempt.status === "evaluated" ? evaluatedOutcome : "failed",
            promotionTag: attempt.candidate?.promotionTag ?? null, publicProgress,
            hiddenProgress, aggregate,
            hypothesis: provider?.hypothesis, gateDiagnostics: attempt.status === "public-gate-failed" ? ["公开门禁失败"] : [],
            diffSummary: attempt.candidate
              ? options.lineage.diff(input.experimentId, input.role, championBefore, candidateCommit).slice(0, 4_000)
              : undefined,
          },
          usage: trustedUsage,
        };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    async createChampionExhibition(input) {
      return options.startExhibition({
        experimentId: input.experimentId, seed: `generation-${input.generation}-champions`,
        generatorCommit: input.generatorCommit, solverCommit: input.solverCommit,
        generation: input.generation, exhibitionId: input.checkpointId,
      });
    },
  };
}

export function createFrozenEvaluationCases(
  runtime: Pick<ExperimentRuntimeRepository, "deriveHiddenSeed">,
  experimentId: string,
  generation: number,
  role: "generator" | "solver",
) {
  const publicCases = Array.from({ length: 8 }, (_, index) => ({
    id: `public-${String(index + 1).padStart(2, "0")}`,
    seed: `public:${role}:${index + 1}`,
    visibility: "public" as const,
  }));
  const hiddenCases = Array.from({ length: 24 }, (_, index) => ({
    id: `hidden-${String(index + 1).padStart(2, "0")}`,
    seed: runtime.deriveHiddenSeed(experimentId, generation, `${role}:${index + 1}`),
    visibility: "hidden" as const,
  }));
  return { publicCases, hiddenCases };
}

async function evaluateRole(
  role: "generator" | "solver",
  candidateRoot: string,
  championRoot: string,
  opponentRoot: string,
  cases: Array<{ id: string; seed: string; visibility: "public" | "hidden" }>,
  context: FrozenEvaluationContext,
): Promise<{ outcome: "promoted" | "failed" | "tie"; publicRegressed: boolean; summary: string; aggregate: Record<string, number> }> {
  if (role === "generator") {
    const [candidate, champion, solver] = await Promise.all([
      generatorPlugin(candidateRoot, "candidate"), generatorPlugin(championRoot, "champion"), solverPlugin(opponentRoot, "opponent"),
    ]);
    const evaluation = await evaluateGeneratorPair({
      candidate, champion,
      solver: { version: solver.version, solve: (maze) => runSolverOnMaze({ seed: "paired-generator", maze, solver: solver.createPolicy(context) }).score },
      cases, context,
    });
    const comparison = compareGeneratorScores(evaluation.total.candidate, evaluation.total.champion);
    return {
      outcome: evaluation.promote ? "promoted" : comparison === 0 ? "tie" : "failed",
      publicRegressed: evaluation.publicPrimaryRegressed,
      summary: JSON.stringify(evaluation.total),
      aggregate: { ...evaluation.total.candidate },
    };
  }
  const [candidate, champion, generator] = await Promise.all([
    solverPlugin(candidateRoot, "candidate"), solverPlugin(championRoot, "champion"), generatorPlugin(opponentRoot, "opponent"),
  ]);
  const evaluation = await evaluateSolverPair({
    candidate, champion,
    generator: { version: generator.version, generate: async (seed) => (await generator.generate(seed, context)).maze },
    cases, context,
  });
  const comparison = compareSolverScores(evaluation.total.candidate, evaluation.total.champion);
  return {
    outcome: evaluation.promote ? "promoted" : comparison === 0 ? "tie" : "failed",
    publicRegressed: evaluation.publicPrimaryRegressed,
    summary: JSON.stringify(evaluation.total),
    aggregate: { ...evaluation.total.candidate },
  };
}

async function generatorPlugin(root: string, version: string): Promise<GeneratorEvaluationPlugin> {
  const module = await import(`${pathToFileURL(join(root, "dist/index.js")).href}?v=${Date.now()}-${Math.random()}`) as {
    createGeneratorCapability(): GeneratorCapability;
  };
  return {
    version,
    generate: async (seed) => ({ maze: await generateMaze(module.createGeneratorCapability(), seed), protocolValid: true, resourceCompliant: true, trace: [] }),
  };
}

async function generateMaze(capability: GeneratorCapability, seed: string): Promise<MazeSnapshot> {
  const passages: MazeSnapshot["passages"] = [];
  let response = await capability.handle({ type: "generator.start", seed, rules: { size: 31, start: START, goal: GOAL } });
  while (response.type !== "generator.complete") {
    passages.push({ from: { ...response.from }, to: { ...response.to } });
    response = await capability.handle({ type: "generator.next" });
  }
  return { size: 31, start: { ...START }, goal: { ...GOAL }, passages };
}

async function solverPlugin(root: string, version: string): Promise<SolverEvaluationPlugin> {
  const module = await import(`${pathToFileURL(join(root, "dist/index.js")).href}?v=${Date.now()}-${Math.random()}`) as {
    createSolverCapability(): SolverCapability;
  };
  return { version, createPolicy: () => capabilityPolicy(module.createSolverCapability()) };
}

function capabilityPolicy(capability: SolverCapability): SolverPolicy {
  let started = false;
  return {
    nextAction(observation) {
      if (!started) {
        const ready = capability.handle({ type: "solver.start", start: observation.start, goal: observation.goal });
        if (ready instanceof Promise || ready.type !== "solver.ready") throw new Error("Solver 评测能力必须同步初始化");
        started = true;
      }
      const response = capability.handle({
        type: "solver.next", position: observation.position, start: observation.start, goal: observation.goal,
        openDirections: observation.openDirections as MazeDirection[], remainingSteps: observation.remainingSteps,
        previousAction: observation.previousAction,
      });
      if (response instanceof Promise || response.type !== "solver.move") throw new Error("Solver 评测能力必须同步返回动作");
      return { direction: response.direction, kind: response.kind };
    },
  };
}

function requireExperiment(repository: ExperimentRepository, id: string): Experiment {
  const experiment = repository.find(id);
  if (!experiment) throw new Error(`未找到实验 ${id}`);
  return experiment;
}
