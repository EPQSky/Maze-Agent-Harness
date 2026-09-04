import type { EvolutionRole, GenerationRoleResult } from "@maze-arena/contracts";
import type { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import type {
  DelayedHiddenAggregate,
  TrustedAttemptResult,
  TrustedEvolutionInput,
  TypedPublicTrace,
  TypedPublicTraceEvent,
} from "@maze-arena/evolution";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import {
  HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS,
  HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES,
  HARNESS_EVOLUTION_MAX_LINEAGE_PLANS,
  HARNESS_EVOLUTION_MAX_PUBLIC_TRACES,
  HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES,
  HARNESS_EVOLUTION_MAX_TRACE_EVENTS,
  HARNESS_EVOLUTION_MAX_TRACE_METRICS,
  HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS,
  harnessEvolutionTrustedInputBytes,
} from "@maze-arena/dsh-integration";

type FeedbackInput = Omit<TrustedEvolutionInput, "role" | "championRoot">;

export function assembleTrustedEvolutionFeedback(input: {
  experimentId: string;
  generation: number;
  role: EvolutionRole;
  championRoot: string;
  frozenChampion: string;
  runtime: Pick<ExperimentRuntimeRepository, "get" | "listRoleCheckpoints">;
  lineage: Pick<PluginLineageRepository, "listStrategyRecords">;
}): FeedbackInput {
  const snapshot = input.runtime.get(input.experimentId);
  if (!snapshot || snapshot.champions[input.role] !== input.frozenChampion) {
    throw new Error("可信反馈与冻结冠军快照不一致");
  }
  const checkpoints = [...input.runtime.listRoleCheckpoints(input.experimentId, input.role, input.generation)]
    .sort((left, right) => left.generation - right.generation);
  let previousGeneration = 0;
  const traceIdentities = new Set<string>();
  const validatedCheckpoints = checkpoints.map((checkpoint) => {
    assertCheckpointIdentity(checkpoint.generation, checkpoint.attemptId, input.generation, input.role);
    if (checkpoint.generation <= previousGeneration) throw new Error("可信反馈检查点代次必须唯一且严格递增");
    previousGeneration = checkpoint.generation;
    const result = trustedResult(checkpoint.generation, checkpoint.attemptId, input.role, checkpoint.result);
    const publicTraces = validatePublicTraces(
      checkpoint.result.trustedPublicTraces ?? [], checkpoint.attemptId, checkpoint.generation, traceIdentities,
    );
    return { result, publicTraces };
  });
  const retainedCheckpoints = validatedCheckpoints.slice(-HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS);
  const trustedResults = retainedCheckpoints.map(({ result }) => result);
  const trustedAttemptIds = new Set(trustedResults.map(({ attemptId }) => attemptId));
  const lineagePlans = input.lineage.listStrategyRecords(input.experimentId, input.role)
    .filter(({ attemptId }) => trustedAttemptIds.has(attemptId))
    .slice(-HARNESS_EVOLUTION_MAX_LINEAGE_PLANS)
    .map(({ attemptId, strategyPlan }) => ({
      attemptId,
      strategyPlan: truncateUtf8(strategyPlan, HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES),
    }));
  const publicTraces = retainedCheckpoints.flatMap(({ publicTraces }) => publicTraces)
    .slice(-HARNESS_EVOLUTION_MAX_PUBLIC_TRACES);
  const feedback = { lineagePlans, trustedResults, publicTraces, hiddenAggregate: delayedHiddenAggregate(trustedResults) };
  if (harnessEvolutionTrustedInputBytes({ role: input.role, championRoot: input.championRoot, ...feedback })
    > HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES) {
    throw new Error("可信进化反馈超过协议字节预算");
  }
  return feedback;
}

function trustedResult(generation: number, attemptId: string, role: EvolutionRole, result: GenerationRoleResult): TrustedAttemptResult {
  if (!["promoted", "failed", "tie"].includes(result.outcome)) throw new Error("可信评测结果分类非法");
  const trusted: TrustedAttemptResult = {
    attemptId,
    generation,
    role,
    outcome: result.outcome,
    publicCaseCount: nonNegativeInteger(result.publicProgress, "公开案例计数"),
    hiddenCaseCount: nonNegativeInteger(result.hiddenProgress, "隐藏案例计数"),
    totalCandidateAggregate: numericRecord(result.aggregate, HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS),
  };
  if (result.hiddenCandidateAggregate !== undefined) {
    const hiddenMetrics = hiddenMetricRecord(result.hiddenCandidateAggregate, role);
    if (trusted.hiddenCaseCount === 0) {
      if (Object.keys(hiddenMetrics).length > 0) throw new Error("未完成隐藏评测不得携带隐藏指标");
    } else {
      trusted.hiddenCandidateAggregate = hiddenMetrics;
    }
  }
  return trusted;
}

function delayedHiddenAggregate(results: readonly TrustedAttemptResult[]): DelayedHiddenAggregate {
  const evaluatedResults = results.filter(({ hiddenCaseCount }) => hiddenCaseCount > 0);
  const metricAvailableResults = evaluatedResults.filter(({ hiddenCandidateAggregate }) => hiddenCandidateAggregate !== undefined);
  const metricTotals: Record<string, number> = {};
  for (const result of metricAvailableResults) {
    for (const [metric, value] of Object.entries(result.hiddenCandidateAggregate ?? {})) {
      metricTotals[metric] = safeMetricSum(metricTotals[metric] ?? 0, value);
    }
  }
  return {
    completedAttemptCount: evaluatedResults.length,
    metricAvailableAttemptCount: metricAvailableResults.length,
    metricUnavailableAttemptCount: evaluatedResults.length - metricAvailableResults.length,
    promotedAttemptCount: evaluatedResults.filter(({ outcome }) => outcome === "promoted").length,
    failedAttemptCount: evaluatedResults.filter(({ outcome }) => outcome === "failed").length,
    tieAttemptCount: evaluatedResults.filter(({ outcome }) => outcome === "tie").length,
    evaluatedHiddenCaseCount: evaluatedResults.reduce(
      (total, { hiddenCaseCount }) => safeCountSum(total, hiddenCaseCount),
      0,
    ),
    metricTotals,
  };
}

function safeCountSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("隐藏案例累计计数非法");
  return total;
}

function safeMetricSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("可信评测聚合字段累计溢出");
  return total;
}

function validatePublicTraces(
  traces: readonly StoredPublicTrace[],
  attemptId: string,
  generation: number,
  identities: Set<string>,
): TypedPublicTrace[] {
  if (traces.length > HARNESS_EVOLUTION_MAX_PUBLIC_TRACES) throw new Error("单次可信结果的公开轨迹超过数量上限");
  return traces.map((trace) => {
    const validated = validatePublicTrace(trace, attemptId, generation);
    const identity = `${trace.attemptId}\0${trace.traceId}`;
    if (identities.has(identity)) throw new Error("公开轨迹身份必须唯一");
    identities.add(identity);
    return validated;
  });
}

function assertCheckpointIdentity(generation: number, attemptId: string, currentGeneration: number, role: EvolutionRole): void {
  const expectedAttemptId = `g${String(generation).padStart(4, "0")}-${role}`;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation >= currentGeneration || attemptId !== expectedAttemptId) {
    throw new Error("可信反馈检查点与角色、代次或尝试身份不一致");
  }
}

type StoredPublicTrace = NonNullable<GenerationRoleResult["trustedPublicTraces"]>[number];

function validatePublicTrace(value: StoredPublicTrace, attemptId: string, generation: number): TypedPublicTrace {
  if (value.attemptId !== attemptId || value.generation !== generation || !feedbackId(value.traceId)
    || !["success", "failure", "tie"].includes(value.outcome)) throw new Error("公开轨迹与可信尝试身份不一致");
  if (value.events.length > HARNESS_EVOLUTION_MAX_TRACE_EVENTS) throw new Error("公开轨迹事件超过数量上限");
  return {
    attemptId,
    generation,
    traceId: value.traceId,
    outcome: value.outcome,
    metrics: numericRecord(value.metrics, HARNESS_EVOLUTION_MAX_TRACE_METRICS),
    events: value.events.map((event) => sanitizeStoredEvent(event)),
  };
}

function sanitizeStoredEvent(event: StoredPublicTrace["events"][number]): TypedPublicTraceEvent {
  const encoded = JSON.stringify(event);
  if (Buffer.byteLength(encoded, "utf8") > 1_024) throw new Error("公开轨迹事件超过冻结上限");
  if (event.type === "maze.carved" && onlyKeys(event, ["type", "from", "to"]) && coordinate(event.from) && coordinate(event.to)) {
    return { type: event.type, from: event.from, to: event.to };
  }
  if (event.type === "maze.completed" && onlyKeys(event, ["type", "passageCount"])
    && Number.isSafeInteger(event.passageCount) && Number(event.passageCount) >= 0) {
    return { type: event.type, passageCount: Number(event.passageCount) };
  }
  if (event.type === "solver.decision"
    && onlyKeys(event, ["type", "position", "openDirections", "remainingSteps", "direction", "kind"])
    && coordinate(event.position)
    && event.openDirections.every((direction) => ["north", "east", "south", "west"].includes(direction))
    && Number.isSafeInteger(event.remainingSteps) && event.remainingSteps >= 0
    && ["north", "east", "south", "west"].includes(event.direction)
    && ["move", "backtrack"].includes(event.kind)) {
    return { type: event.type, position: event.position, openDirections: [...event.openDirections],
      remainingSteps: event.remainingSteps, direction: event.direction, kind: event.kind };
  }
  throw new Error("公开轨迹包含非白名单事件");
}

function onlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === allowed.size && Object.keys(value).every((key) => allowed.has(key));
}

function coordinate(value: unknown): value is { x: number; y: number } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && Number.isSafeInteger((value as { x?: unknown }).x) && Number.isSafeInteger((value as { y?: unknown }).y);
}

function numericRecord(value: unknown, maximumEntries = HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("可信评测聚合字段非法");
  if (Object.keys(value).length > maximumEntries) throw new Error("可信评测聚合字段超过数量上限");
  const result: Record<string, number> = {};
  for (const [key, metric] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(key) || !Number.isFinite(metric)) throw new Error("可信评测聚合字段非法");
    result[key] = metric;
  }
  return result;
}

function hiddenMetricRecord(value: unknown, role: EvolutionRole): Record<string, number> {
  const allowed = role === "generator"
    ? new Set(["gateFailures", "failedCases", "extraActions", "structuralNovelty"])
    : new Set(["solvedCases", "extraActions", "illegalActions"]);
  const result = numericRecord(value);
  for (const [key, metric] of Object.entries(result)) {
    if (!allowed.has(key) || !Number.isSafeInteger(metric) || metric < 0) throw new Error("隐藏指标字段或数值非法");
  }
  return result;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}非法`);
  return value;
}

function feedbackId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return value.slice(0, end);
}
