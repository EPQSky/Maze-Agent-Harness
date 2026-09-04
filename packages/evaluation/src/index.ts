import { createHash } from "node:crypto";
import type { MatchScore, MazeSnapshot, SolverAction, SolverObservation, SolverPolicy } from "@maze-arena/engine";
import { runSolverOnMaze, validateMaze } from "@maze-arena/engine";

export * from "./determinism.js";
export * from "./opponents.js";

export type EvaluationVisibility = "public" | "hidden";

export interface EvaluationCase {
  id: string;
  seed: string;
  visibility: EvaluationVisibility;
}

export interface FrozenEvaluationContext {
  opponentVersion: string;
  imageDigest: string;
  resourcePolicyDigest: string;
}

export interface EvaluationTelemetry {
  cpuUsec?: number;
  wallClockMs?: number;
}

export interface GeneratedMazeOutput {
  maze: MazeSnapshot;
  protocolValid: boolean;
  resourceCompliant: boolean;
  trace: readonly unknown[];
  telemetry?: EvaluationTelemetry;
}

export interface GeneratorEvaluationPlugin {
  version: string;
  generate(seed: string, context: FrozenEvaluationContext): GeneratedMazeOutput | Promise<GeneratedMazeOutput>;
}

export interface FrozenSolver {
  version: string;
  solve(maze: MazeSnapshot, context: FrozenEvaluationContext): MatchScore | Promise<MatchScore>;
}

export interface FrozenGenerator {
  version: string;
  generate(seed: string, context: FrozenEvaluationContext): MazeSnapshot | Promise<MazeSnapshot>;
}

export interface SolverEvaluationPlugin {
  version: string;
  createPolicy(context: FrozenEvaluationContext): SolverPolicy;
  telemetry?: EvaluationTelemetry;
}

export interface AsyncSolverEvaluationPlugin {
  version: string;
  solve(seed: string, maze: MazeSnapshot, context: FrozenEvaluationContext): Promise<{
    score: SolverCaseScore;
    trace: Array<{ observation: SolverObservation; action: SolverAction }>;
    telemetry?: EvaluationTelemetry;
  }>;
}

export interface SolverCaseScore {
  solved: boolean;
  extraActions: number;
  illegalActions: number;
}

export interface SolverPublicCaseResult {
  caseId: string;
  seed: string;
  candidate: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
  champion: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
}

export interface SolverAggregateScore {
  solvedCases: number;
  extraActions: number;
  illegalActions: number;
}

export interface SolverPairEvaluation {
  candidateVersion: string;
  championVersion: string;
  generatorVersion: string;
  context: FrozenEvaluationContext;
  publicCases: SolverPublicCaseResult[];
  hidden: { caseCount: number; candidate: SolverAggregateScore; champion: SolverAggregateScore };
  total: { candidate: SolverAggregateScore; champion: SolverAggregateScore };
  publicPrimaryRegressed: boolean;
  promote: boolean;
}

export interface GeneratorCaseScore {
  failed: boolean;
  extraActions: number;
  topologyHash: string | null;
  gateFailure: "protocol" | "resource" | "maze" | null;
}

export interface GeneratorPublicCaseResult {
  caseId: string;
  seed: string;
  candidate: GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry };
  champion: GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry };
}

export interface GeneratorAggregateScore {
  gateFailures: number;
  failedCases: number;
  extraActions: number;
  structuralNovelty: number;
}

export interface GeneratorPairEvaluation {
  candidateVersion: string;
  championVersion: string;
  solverVersion: string;
  context: FrozenEvaluationContext;
  publicCases: GeneratorPublicCaseResult[];
  hidden: {
    caseCount: number;
    candidate: GeneratorAggregateScore;
    champion: GeneratorAggregateScore;
  };
  total: {
    candidate: GeneratorAggregateScore;
    champion: GeneratorAggregateScore;
  };
  publicPrimaryRegressed: boolean;
  promote: boolean;
}

interface InternalCaseResult {
  caseId: string;
  seed: string;
  visibility: EvaluationVisibility;
  candidate: GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry };
  champion: GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry };
}

export async function evaluateGeneratorPair(options: {
  candidate: GeneratorEvaluationPlugin;
  champion: GeneratorEvaluationPlugin;
  solver: FrozenSolver;
  cases: readonly EvaluationCase[];
  context: FrozenEvaluationContext;
}): Promise<GeneratorPairEvaluation> {
  const cases = [...options.cases].sort((left, right) => left.id.localeCompare(right.id));
  ensureUniqueCases(cases);
  const results: InternalCaseResult[] = [];
  for (const evaluationCase of cases) {
    const [candidate, champion] = await Promise.all([
      runGeneratorCase(options.candidate, options.solver, evaluationCase, options.context),
      runGeneratorCase(options.champion, options.solver, evaluationCase, options.context),
    ]);
    results.push({
      caseId: evaluationCase.id,
      seed: evaluationCase.seed,
      visibility: evaluationCase.visibility,
      candidate,
      champion,
    });
  }
  const publicResults = results.filter(({ visibility }) => visibility === "public");
  const hiddenResults = results.filter(({ visibility }) => visibility === "hidden");
  const candidateTotal = aggregate(results.map(({ candidate }) => candidate));
  const championTotal = aggregate(results.map(({ champion }) => champion));
  const candidatePublic = aggregate(publicResults.map(({ candidate }) => candidate));
  const championPublic = aggregate(publicResults.map(({ champion }) => champion));
  const publicPrimaryRegressed = candidatePublic.gateFailures > 0
    || candidatePublic.failedCases < championPublic.failedCases;
  return {
    candidateVersion: options.candidate.version,
    championVersion: options.champion.version,
    solverVersion: options.solver.version,
    context: { ...options.context },
    publicCases: publicResults.map(({ caseId, seed, candidate, champion }) => ({ caseId, seed, candidate, champion })),
    hidden: {
      caseCount: hiddenResults.length,
      candidate: aggregate(hiddenResults.map(({ candidate }) => candidate)),
      champion: aggregate(hiddenResults.map(({ champion }) => champion)),
    },
    total: { candidate: candidateTotal, champion: championTotal },
    publicPrimaryRegressed,
    promote: candidateTotal.gateFailures === 0
      && !publicPrimaryRegressed
      && compareGeneratorScores(candidateTotal, championTotal) > 0,
  };
}

export function compareGeneratorScores(candidate: GeneratorAggregateScore, champion: GeneratorAggregateScore): number {
  if (candidate.gateFailures !== champion.gateFailures) return champion.gateFailures - candidate.gateFailures;
  if (candidate.failedCases !== champion.failedCases) return candidate.failedCases - champion.failedCases;
  if (candidate.extraActions !== champion.extraActions) return candidate.extraActions - champion.extraActions;
  if (candidate.structuralNovelty !== champion.structuralNovelty) return candidate.structuralNovelty - champion.structuralNovelty;
  return 0;
}

export async function evaluateSolverPair(options: {
  candidate: SolverEvaluationPlugin;
  champion: SolverEvaluationPlugin;
  generator: FrozenGenerator;
  cases: readonly EvaluationCase[];
  context: FrozenEvaluationContext;
}): Promise<SolverPairEvaluation> {
  const cases = [...options.cases].sort((left, right) => left.id.localeCompare(right.id));
  ensureUniqueCases(cases);
  const results: Array<{
    caseId: string;
    seed: string;
    visibility: EvaluationVisibility;
    candidate: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
    champion: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
  }> = [];
  for (const evaluationCase of cases) {
    const maze = await options.generator.generate(evaluationCase.seed, options.context);
    const validation = validateMaze(maze);
    if (!validation.valid) throw new Error(`冻结生成器产生非法迷宫：${validation.reason}`);
    const candidate = runSolverCase(options.candidate, evaluationCase.seed, maze, options.context);
    const champion = runSolverCase(options.champion, evaluationCase.seed, maze, options.context);
    results.push({ caseId: evaluationCase.id, seed: evaluationCase.seed, visibility: evaluationCase.visibility, candidate, champion });
  }
  const publicResults = results.filter(({ visibility }) => visibility === "public");
  const hiddenResults = results.filter(({ visibility }) => visibility === "hidden");
  const candidateTotal = aggregateSolver(results.map(({ candidate }) => candidate));
  const championTotal = aggregateSolver(results.map(({ champion }) => champion));
  const candidatePublic = aggregateSolver(publicResults.map(({ candidate }) => candidate));
  const championPublic = aggregateSolver(publicResults.map(({ champion }) => champion));
  const publicPrimaryRegressed = candidatePublic.solvedCases < championPublic.solvedCases;
  return {
    candidateVersion: options.candidate.version,
    championVersion: options.champion.version,
    generatorVersion: options.generator.version,
    context: { ...options.context },
    publicCases: publicResults.map(({ caseId, seed, candidate, champion }) => ({ caseId, seed, candidate, champion })),
    hidden: {
      caseCount: hiddenResults.length,
      candidate: aggregateSolver(hiddenResults.map(({ candidate }) => candidate)),
      champion: aggregateSolver(hiddenResults.map(({ champion }) => champion)),
    },
    total: { candidate: candidateTotal, champion: championTotal },
    publicPrimaryRegressed,
    promote: !publicPrimaryRegressed && compareSolverScores(candidateTotal, championTotal) > 0,
  };
}

export async function evaluateAsyncSolverPair(options: {
  candidate: AsyncSolverEvaluationPlugin;
  champion: AsyncSolverEvaluationPlugin;
  generator: FrozenGenerator;
  cases: readonly EvaluationCase[];
  context: FrozenEvaluationContext;
}): Promise<SolverPairEvaluation> {
  const cases = [...options.cases].sort((left, right) => left.id.localeCompare(right.id));
  ensureUniqueCases(cases);
  const results: Array<{
    caseId: string;
    seed: string;
    visibility: EvaluationVisibility;
    candidate: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
    champion: SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry };
  }> = [];
  for (const evaluationCase of cases) {
    const maze = await options.generator.generate(evaluationCase.seed, options.context);
    const validation = validateMaze(maze);
    if (!validation.valid) throw new Error(`冻结生成器产生非法迷宫：${validation.reason}`);
    const [candidateResult, championResult] = await Promise.all([
      options.candidate.solve(evaluationCase.seed, maze, options.context),
      options.champion.solve(evaluationCase.seed, maze, options.context),
    ]);
    results.push({
      caseId: evaluationCase.id,
      seed: evaluationCase.seed,
      visibility: evaluationCase.visibility,
      candidate: { ...candidateResult.score, trace: candidateResult.trace, telemetry: candidateResult.telemetry },
      champion: { ...championResult.score, trace: championResult.trace, telemetry: championResult.telemetry },
    });
  }
  const publicResults = results.filter(({ visibility }) => visibility === "public");
  const hiddenResults = results.filter(({ visibility }) => visibility === "hidden");
  const candidateTotal = aggregateSolver(results.map(({ candidate }) => candidate));
  const championTotal = aggregateSolver(results.map(({ champion }) => champion));
  const candidatePublic = aggregateSolver(publicResults.map(({ candidate }) => candidate));
  const championPublic = aggregateSolver(publicResults.map(({ champion }) => champion));
  const publicPrimaryRegressed = candidatePublic.solvedCases < championPublic.solvedCases;
  return {
    candidateVersion: options.candidate.version,
    championVersion: options.champion.version,
    generatorVersion: options.generator.version,
    context: { ...options.context },
    publicCases: publicResults.map(({ caseId, seed, candidate, champion }) => ({ caseId, seed, candidate, champion })),
    hidden: {
      caseCount: hiddenResults.length,
      candidate: aggregateSolver(hiddenResults.map(({ candidate }) => candidate)),
      champion: aggregateSolver(hiddenResults.map(({ champion }) => champion)),
    },
    total: { candidate: candidateTotal, champion: championTotal },
    publicPrimaryRegressed,
    promote: !publicPrimaryRegressed && compareSolverScores(candidateTotal, championTotal) > 0,
  };
}

export function compareSolverScores(candidate: SolverAggregateScore, champion: SolverAggregateScore): number {
  if (candidate.solvedCases !== champion.solvedCases) return candidate.solvedCases - champion.solvedCases;
  if (candidate.extraActions !== champion.extraActions) return champion.extraActions - candidate.extraActions;
  if (candidate.illegalActions !== champion.illegalActions) return champion.illegalActions - candidate.illegalActions;
  return 0;
}

function runSolverCase(
  plugin: SolverEvaluationPlugin,
  seed: string,
  maze: MazeSnapshot,
  context: FrozenEvaluationContext,
): SolverCaseScore & { trace: Array<{ observation: SolverObservation; action: SolverAction }>; telemetry?: EvaluationTelemetry } {
  const trace: Array<{ observation: SolverObservation; action: SolverAction }> = [];
  let invalidActions = 0;
  const delegate = plugin.createPolicy(context);
  const policy: SolverPolicy = {
    nextAction(observation) {
      let action: SolverAction;
      try { action = delegate.nextAction(cloneObservation(observation)); }
      catch { invalidActions += 1; action = fallbackAction(observation); }
      if (!validSolverAction(action)) {
        invalidActions += 1;
        action = fallbackAction(observation);
      }
      trace.push({ observation: cloneObservation(observation), action: { ...action } });
      return action;
    },
  };
  const result = runSolverOnMaze({ seed, maze, solver: policy });
  return {
    solved: result.score.solved,
    extraActions: result.score.solved ? Math.max(0, result.score.actions - shortestPathLength(maze)) : 0,
    illegalActions: result.score.illegalMoves + invalidActions,
    trace,
    telemetry: plugin.telemetry,
  };
}

function aggregateSolver(results: SolverCaseScore[]): SolverAggregateScore {
  return {
    solvedCases: results.filter(({ solved }) => solved).length,
    extraActions: results.reduce((total, { extraActions }) => total + extraActions, 0),
    illegalActions: results.reduce((total, { illegalActions }) => total + illegalActions, 0),
  };
}

function cloneObservation(observation: SolverObservation): SolverObservation {
  return {
    position: { ...observation.position }, start: { ...observation.start }, goal: { ...observation.goal },
    openDirections: [...observation.openDirections], remainingSteps: observation.remainingSteps,
    previousAction: observation.previousAction ? { ...observation.previousAction } : null,
  };
}

function validSolverAction(value: unknown): value is SolverAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Partial<SolverAction>;
  return ["north", "east", "south", "west"].includes(action.direction ?? "")
    && ["move", "backtrack"].includes(action.kind ?? "")
    && Object.keys(value).every((key) => key === "direction" || key === "kind");
}

function fallbackAction(observation: SolverObservation): SolverAction {
  return { direction: observation.openDirections[0] ?? "north", kind: "move" };
}

async function runGeneratorCase(
  generator: GeneratorEvaluationPlugin,
  solver: FrozenSolver,
  evaluationCase: EvaluationCase,
  context: FrozenEvaluationContext,
): Promise<GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry }> {
  const output = await generator.generate(evaluationCase.seed, context);
  if (!output.protocolValid) return failedGate("protocol", output);
  if (!output.resourceCompliant) return failedGate("resource", output);
  if (!validateMaze(output.maze).valid) return failedGate("maze", output);
  const score = await solver.solve(output.maze, context);
  const shortest = shortestPathLength(output.maze);
  return {
    failed: !score.solved,
    extraActions: score.solved ? Math.max(0, score.actions - shortest) : 0,
    topologyHash: topologyHash(output.maze),
    gateFailure: null,
    trace: output.trace,
    telemetry: output.telemetry,
  };
}

function failedGate(
  gateFailure: NonNullable<GeneratorCaseScore["gateFailure"]>,
  output: GeneratedMazeOutput,
): GeneratorCaseScore & { trace: readonly unknown[]; telemetry?: EvaluationTelemetry } {
  return { failed: true, extraActions: 0, topologyHash: null, gateFailure, trace: output.trace, telemetry: output.telemetry };
}

function aggregate(results: Array<GeneratorCaseScore>): GeneratorAggregateScore {
  return {
    gateFailures: results.filter(({ gateFailure }) => gateFailure !== null).length,
    failedCases: results.filter(({ failed, gateFailure }) => failed && gateFailure === null).length,
    extraActions: results.reduce((total, { extraActions }) => total + extraActions, 0),
    structuralNovelty: new Set(results.flatMap(({ topologyHash }) => topologyHash ? [topologyHash] : [])).size,
  };
}

function ensureUniqueCases(cases: EvaluationCase[]): void {
  const ids = new Set<string>();
  for (const evaluationCase of cases) {
    if (!evaluationCase.id || !evaluationCase.seed || ids.has(evaluationCase.id)) throw new Error("评测案例标识和种子必须非空且案例标识唯一");
    ids.add(evaluationCase.id);
  }
}

export function topologyHash(maze: MazeSnapshot): string {
  const passages = maze.passages.map(({ from, to }) => [point(from), point(to)].sort().join("|")).sort();
  return createHash("sha256").update(JSON.stringify({ size: maze.size, start: maze.start, goal: maze.goal, passages })).digest("hex");
}

function point(value: { x: number; y: number }): string { return `${value.x},${value.y}`; }

export function shortestPathLength(maze: MazeSnapshot): number {
  const adjacency = new Map<string, string[]>();
  for (const { from, to } of maze.passages) {
    const fromKey = point(from);
    const toKey = point(to);
    adjacency.set(fromKey, [...(adjacency.get(fromKey) ?? []), toKey]);
    adjacency.set(toKey, [...(adjacency.get(toKey) ?? []), fromKey]);
  }
  const goal = point(maze.goal);
  const queue: Array<{ key: string; distance: number }> = [{ key: point(maze.start), distance: 0 }];
  const visited = new Set([point(maze.start)]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.key === goal) return current.distance;
    for (const neighbor of adjacency.get(current.key) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push({ key: neighbor, distance: current.distance + 1 });
    }
  }
  throw new Error("已通过合法性门禁的迷宫缺少起终点路径");
}
