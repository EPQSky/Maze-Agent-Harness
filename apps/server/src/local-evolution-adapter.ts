import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MATCH_PROTOCOL_VERSION, type Experiment, type GenerationRoleResult } from "@maze-arena/contracts";
import { HARNESS_EVOLUTION_PROTOCOL_VERSION, type HarnessAdapter, type HarnessEvolutionResponse } from "@maze-arena/dsh-integration";
import { runEvolutionAttempt } from "@maze-arena/evolution";
import {
  compareGeneratorScores,
  compareSolverScores,
  type GeneratorPairEvaluation,
  type SolverPairEvaluation,
} from "@maze-arena/evaluation";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import {
  rebuildTrustedPluginCandidate,
  verifyTrustedPluginCandidate,
  type PairedEvaluationRunner,
  type TrustedCandidateTestRunner,
} from "@maze-arena/match-profile";
import type { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import type { AuditRepository } from "./audit-repository.js";
import type { AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import type { ExperimentRepository } from "./experiment-repository.js";
import { HarnessInvocationError } from "./harness-invocation-error.js";
import { assembleTrustedEvolutionFeedback } from "./trusted-evolution-feedback.js";
import { CandidateEvaluationFacts } from "./candidate-evaluation-facts.js";

const MAX_PUBLIC_TRACE_EVENTS = 128;

export function createLocalEvolutionAdapter(options: {
  harness: HarnessAdapter;
  experiments: ExperimentRepository;
  lineage: PluginLineageRepository;
  runtime: ExperimentRuntimeRepository;
  audits: AuditRepository;
  pluginRoots: { generator: string; solver: string };
  candidateTestRunner: TrustedCandidateTestRunner;
  pairedEvaluationRunner: PairedEvaluationRunner;
  matchImageDigest: string;
  resourcePolicyDigest: string;
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
      const isolatedRoot = join(scratch, "attempts");
      const attemptWorkspace = join(isolatedRoot, input.attemptId, "workspace");
      options.lineage.materialize(input.experimentId, input.role, input.frozenChampions[input.role], championRoot);
      const opponentRole = input.role === "generator" ? "solver" : "generator";
      options.lineage.materialize(input.experimentId, opponentRole, input.frozenChampions[opponentRole], opponentRoot);
      let provider: HarnessEvolutionResponse | undefined;
      let evaluationCandidate: { commit: string; root: string } | undefined;
      const trustedUsage = { tokens: 0, cost: 0 };
      const evaluationFacts = new CandidateEvaluationFacts();
      const context = {
        opponentVersion: input.frozenChampions[opponentRole],
        imageDigest: options.matchImageDigest,
        resourcePolicyDigest: options.resourcePolicyDigest,
      };
      const { publicCases, hiddenCases } = createFrozenEvaluationCases(
        options.runtime, input.experimentId, input.generation, input.role,
      );
      const feedback = assembleTrustedEvolutionFeedback({
        experimentId: input.experimentId,
        generation: input.generation,
        role: input.role,
        championRoot: attemptWorkspace,
        frozenChampion: input.frozenChampions[input.role],
        runtime: options.runtime,
        lineage: options.lineage,
      });
      const allCases = [...publicCases, ...hiddenCases];
      try {
        const attempt = await runEvolutionAttempt({
          experimentId: input.experimentId,
          generation: input.generation,
          attemptId: input.attemptId,
          role: input.role,
          championRoot,
          isolatedRoot,
          input: feedback,
          beginRepairAttempt: () => evaluationFacts.beginRepairAttempt(),
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
          prepareCandidate: async (workspace, strategyRecord) => {
            const report = await rebuildTrustedPluginCandidate({
              championRoot,
              candidateRoot: workspace,
              trustedToolRoot: options.pluginRoots[input.role],
              testRunner: options.candidateTestRunner,
              strategyRecord,
            });
            return report.contentSha256;
          },
          candidatePrepared: (candidate) => {
            const root = join(scratch, "evaluation-candidate");
            options.lineage.materialize(input.experimentId, input.role, candidate.commit, root);
            evaluationCandidate = { commit: candidate.commit, root };
          },
          verifyCandidate: verifyTrustedPluginCandidate,
          publicGate: async (workspace) => {
            try {
              const evaluation = await options.pairedEvaluationRunner.evaluate({
                role: input.role,
                protocolVersion: MATCH_PROTOCOL_VERSION,
                candidate: requireEvaluationCandidate(evaluationCandidate),
                champion: { commit: input.frozenChampions[input.role], root: championRoot },
                opponent: { commit: input.frozenChampions[opponentRole], root: opponentRoot },
                cases: publicCases,
                context,
              });
              const facts = evaluationFactsFor(input.role, input.attemptId, input.generation, evaluation);
              const diagnostics = evaluationFacts.recordPublicSuccess({
                caseCount: publicCases.length, aggregate: facts.aggregate,
                traces: facts.publicTraces, regressed: evaluation.publicPrimaryRegressed,
              });
              return { passed: !evaluation.publicPrimaryRegressed, diagnostics };
            }
            catch {
              return { passed: false, diagnostics: evaluationFacts.recordPublicFailure() };
            }
          },
          hiddenEvaluate: async (workspace) => {
            try {
              const evaluation = await options.pairedEvaluationRunner.evaluate({
                role: input.role,
                protocolVersion: MATCH_PROTOCOL_VERSION,
                candidate: requireEvaluationCandidate(evaluationCandidate),
                champion: { commit: input.frozenChampions[input.role], root: championRoot },
                opponent: { commit: input.frozenChampions[opponentRole], root: opponentRoot },
                cases: allCases,
                context,
              });
              const facts = evaluationFactsFor(input.role, input.attemptId, input.generation, evaluation);
              evaluationFacts.recordHiddenSuccess({
                caseCount: hiddenCases.length, outcome: facts.outcome, aggregate: facts.aggregate,
                hiddenCandidateAggregate: facts.hiddenCandidateAggregate,
              });
              return { promote: facts.outcome === "promoted", outcome: facts.outcome, resultSummary: JSON.stringify(evaluation.total) };
            } catch (error) {
              evaluationFacts.recordHiddenFailure();
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
            outcome: attempt.status === "evaluated" ? evaluationFacts.outcome : "failed",
            promotionTag: attempt.candidate?.promotionTag ?? null, publicProgress: evaluationFacts.publicProgress,
            hiddenProgress: evaluationFacts.hiddenProgress, aggregate: evaluationFacts.aggregate,
            hiddenCandidateAggregate: evaluationFacts.hiddenCandidateAggregate, trustedPublicTraces: evaluationFacts.publicTraces,
            hypothesis: provider?.hypothesis,
            gateDiagnostics: attempt.diagnostics.length > 0 ? [...attempt.diagnostics] : evaluationFacts.diagnostics,
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

function requireEvaluationCandidate(candidate: { commit: string; root: string } | undefined) {
  if (!candidate) throw new Error("候选尚未建立可信 Git 评测版本");
  return candidate;
}

function evaluationFactsFor(
  role: "generator" | "solver",
  attemptId: string,
  generation: number,
  evaluation: GeneratorPairEvaluation | SolverPairEvaluation,
): { outcome: "promoted" | "failed" | "tie"; aggregate: Record<string, number>;
  hiddenCandidateAggregate: Record<string, number>;
  publicTraces: NonNullable<GenerationRoleResult["trustedPublicTraces"]> } {
  if (role === "generator") {
    const generatorEvaluation = evaluation as GeneratorPairEvaluation;
    const comparison = compareGeneratorScores(generatorEvaluation.total.candidate, generatorEvaluation.total.champion);
    return {
      outcome: generatorEvaluation.promote ? "promoted" : comparison === 0 ? "tie" : "failed",
      aggregate: { ...generatorEvaluation.total.candidate },
      hiddenCandidateAggregate: { ...generatorEvaluation.hidden.candidate },
      publicTraces: generatorEvaluation.publicCases.map(({ caseId, candidate }) => ({
        attemptId, generation, traceId: caseId, outcome: candidate.failed ? "failure" : "success",
        metrics: { failed: candidate.failed ? 1 : 0, extraActions: candidate.extraActions,
          gateFailure: candidate.gateFailure === null ? 0 : 1 },
        events: boundedTrace(sanitizeGeneratorTrace(candidate.trace)),
      })),
    };
  }
  const solverEvaluation = evaluation as SolverPairEvaluation;
  const comparison = compareSolverScores(solverEvaluation.total.candidate, solverEvaluation.total.champion);
  return {
    outcome: solverEvaluation.promote ? "promoted" : comparison === 0 ? "tie" : "failed",
    aggregate: { ...solverEvaluation.total.candidate },
    hiddenCandidateAggregate: { ...solverEvaluation.hidden.candidate },
    publicTraces: solverEvaluation.publicCases.map(({ caseId, candidate }) => ({
      attemptId, generation, traceId: caseId, outcome: candidate.solved ? "success" : "failure",
      metrics: { solved: candidate.solved ? 1 : 0, extraActions: candidate.extraActions, illegalActions: candidate.illegalActions },
      events: boundedTrace(candidate.trace.map(({ observation, action }) => ({
        type: "solver.decision" as const,
        position: { ...observation.position },
        openDirections: [...observation.openDirections],
        remainingSteps: observation.remainingSteps,
        direction: action.direction,
        kind: action.kind,
      }))),
    })),
  };
}

function sanitizeGeneratorTrace(trace: readonly unknown[]): NonNullable<GenerationRoleResult["trustedPublicTraces"]>[number]["events"] {
  return trace.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Generator 公开轨迹事件非法");
    const value = event as Record<string, unknown>;
    if (value.type === "maze.carved" && coordinate(value.from) && coordinate(value.to)) {
      return { type: "maze.carved" as const, from: { ...value.from }, to: { ...value.to } };
    }
    if (value.type === "maze.completed" && Number.isSafeInteger(value.passageCount) && Number(value.passageCount) >= 0) {
      return { type: "maze.completed" as const, passageCount: Number(value.passageCount) };
    }
    throw new Error("Generator 公开轨迹包含非白名单事件");
  });
}

function boundedTrace<T>(events: readonly T[]): T[] {
  if (events.length <= MAX_PUBLIC_TRACE_EVENTS) return [...events];
  const headCount = Math.floor(MAX_PUBLIC_TRACE_EVENTS / 2);
  return [...events.slice(0, headCount), ...events.slice(-(MAX_PUBLIC_TRACE_EVENTS - headCount))];
}

function coordinate(value: unknown): value is { x: number; y: number } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Number.isSafeInteger((value as { x?: unknown }).x) && Number.isSafeInteger((value as { y?: unknown }).y);
}

function requireExperiment(repository: ExperimentRepository, id: string): Experiment {
  const experiment = repository.find(id);
  if (!experiment) throw new Error(`未找到实验 ${id}`);
  return experiment;
}
