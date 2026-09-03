export const experimentStatuses = [
  "draft",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ExperimentStatus = (typeof experimentStatuses)[number];

export interface Experiment {
  id: string;
  name: string;
  status: ExperimentStatus;
  createdAt: string;
  modelProfile: ModelProfile | null;
  costLimit: number | null;
  harnessEnvironments: HarnessAgentEnvironments;
}

export type BaselineValidationStep =
  | "model-config" | "native-plugin-install" | "isolated-match" | "event-replay" | "determinism"
  | "maze-legality" | "persistence" | "live-delivery" | "paired-evaluation" | "promotion-tag";

export interface BaselineStepResult {
  step: BaselineValidationStep;
  passed: boolean;
  diagnostics: string[];
}

export interface FrozenExperimentConfiguration {
  modelProfile: Record<string, unknown>;
  tokenLimit: number;
  costLimit: number | null;
  rulesDigest: string;
  seedPolicyDigest: string;
  resourcePolicyDigest: string;
  scoringVersion: string;
  compatibilityFingerprint: string;
}

export interface BaselineValidationRecord {
  experimentId: string;
  status: "pending" | "running" | "failed" | "passed" | "ready";
  steps: BaselineStepResult[];
  operatorConfirmed: boolean;
  frozenConfiguration: FrozenExperimentConfiguration | null;
  frozenDigest: string | null;
  smoke: { attempted: boolean; passed: boolean | null };
}

export type EvolutionRole = "generator" | "solver";
export interface GenerationRoleResult {
  candidateCommit: string;
  championBefore: string;
  championAfter: string;
  outcome: "promoted" | "failed" | "tie";
  promotionTag: string | null;
  publicProgress: number;
  hiddenProgress: number;
  aggregate: Record<string, number>;
  hypothesis?: string;
  diffSummary?: string;
  gateDiagnostics?: string[];
}

export interface GenerationRecord {
  generation: number;
  status: "completed" | "infrastructure-failed";
  generator: GenerationRoleResult | null;
  solver: GenerationRoleResult | null;
  exhibitionMatchId: string | null;
  stagnationCount: number;
}

export interface ExperimentRuntimeSnapshot {
  experimentId: string;
  state: "ready" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: string;
  generation: number;
  stagnationCount: number;
  champions: Record<EvolutionRole, string>;
  pauseRequested: boolean;
  usage: { tokens: number; cost: number };
  budget: { tokenLimit: number; costLimit: number | null };
  evaluationSuiteId: string;
  sealGroupId: string;
  sealed: boolean;
  evolutionPermitted: boolean;
  compatibilityFingerprint: string;
  generations: GenerationRecord[];
}

export interface ObservationMatch {
  id: string;
  generation: number | null;
  role: EvolutionRole | "exhibition";
  opponent: string;
  evaluationType: "public" | "hidden" | "exhibition";
  result: "won" | "lost" | "tie" | "completed";
  replayable: boolean;
}

export interface ExperimentObservation {
  runtime: ExperimentRuntimeSnapshot | null;
  matches: ObservationMatch[];
  candidates: Array<{ role: EvolutionRole; commit: string; hypothesis: string; result: string; promotionTag: string | null }>;
  audit: ExperimentAuditEvent[];
}

export interface LineageHistoryResponse {
  generator: Array<{ commit: string; subject: string; tags: string[] }>;
  solver: Array<{ commit: string; subject: string; tags: string[] }>;
}

export interface CreateExperimentRequest {
  name: string;
  modelProfile: ModelProfileInput;
  costLimit?: number | null;
}

export type ReasoningEffort = "low" | "medium" | "high";
export type ProviderOptionValue = boolean | number | string;

export interface ModelProfileInput {
  providerId: string;
  modelId: string;
  credentialRef: string;
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  topP?: number;
  contextTokens: number;
  outputTokens: number;
  totalTokenLimit: number;
  providerOptions?: Record<string, ProviderOptionValue>;
}

export interface ModelProfile extends ModelProfileInput {
  providerLabel: string;
  modelLabel: string;
}

export interface HarnessAgentEnvironment {
  home: string;
  workspace: string;
}

export interface HarnessAgentEnvironments {
  generator: HarnessAgentEnvironment;
  solver: HarnessAgentEnvironment;
}

export interface ProviderOptionCapability {
  type: "boolean" | "number" | "string";
  minimum?: number;
  maximum?: number;
}

export interface HarnessModelCapabilities {
  reasoningEfforts: ReasoningEffort[];
  temperature?: { minimum: number; maximum: number };
  topP?: { minimum: number; maximum: number };
  maxContextTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  providerOptions: Record<string, ProviderOptionCapability>;
}

export interface HarnessModel {
  id: string;
  label: string;
  capabilities: HarnessModelCapabilities;
}

export interface HarnessProvider {
  id: string;
  label: string;
  models: HarnessModel[];
}

export interface HarnessCatalogResponse {
  providers: HarnessProvider[];
}

export interface UpdateModelProfileRequest {
  modelProfile: ModelProfileInput;
}

export interface ExperimentListResponse {
  experiments: Experiment[];
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface MatchScore {
  solved: boolean;
  actions: number;
  illegalMoves: number;
  backtracks: number;
  remainingSteps: number;
}

interface SequencedMatchEvent {
  protocolVersion: 1;
  sequence: number;
}

export type MatchEvent = SequencedMatchEvent & (
  | { type: "match.started"; seed: string; size: number; start: Coordinate; goal: Coordinate; stepBudget: number }
  | { type: "maze.carved"; from: Coordinate; to: Coordinate }
  | { type: "maze.completed"; passageCount: number }
  | { type: "solver.action"; step: number; action: { direction: "north" | "east" | "south" | "west"; kind: "move" | "backtrack" }; from: Coordinate; to: Coordinate; moved: boolean }
  | { type: "match.completed"; score: MatchScore }
);

export type ArenaMatchStatus = "running" | "completed" | "failed";

export interface ArenaMatch {
  id: string;
  experimentId: string;
  seed: string;
  protocolVersion: 1;
  status: ArenaMatchStatus;
  committedEventCount: number;
  totalEventCount: number;
  score: MatchScore | null;
  observation?: ObservationMatch;
}

export interface CompletedArenaMatch extends ArenaMatch {
  status: "completed";
  score: MatchScore;
  events: MatchEvent[];
}

export interface MatchEventPage {
  match: ArenaMatch;
  events: MatchEvent[];
  nextSequence: number;
}

export interface MatchListResponse { matches: ArenaMatch[]; }

export interface RawMatchEvent {
  sequence: number;
  protocolVersion: number;
  contentType: "application/json";
  bytesBase64: string;
}

export interface RawMatchEventPage {
  matchId: string;
  events: RawMatchEvent[];
  nextSequence: number;
}

export interface MatchEventDelivery {
  type: "match.events";
  page: MatchEventPage;
}

export interface MatchEventAcknowledgement {
  type: "match.ack";
  sequence: number;
}

export type ExperimentAuditEventType =
  | "match.started"
  | "match.completed"
  | "match.failed"
  | "match.integrity-failed"
  | "baseline.passed"
  | "baseline.failed"
  | "baseline.confirmed"
  | "runtime.started"
  | "runtime.paused"
  | "runtime.cancelled"
  | "harness.activity"
  | "generation.committed"
  | "exhibition.started";

export interface ExperimentAuditEvent {
  id: number;
  experimentId: string;
  type: ExperimentAuditEventType;
  occurredAt: string;
  details: Record<string, boolean | number | string | null>;
}

export interface ExperimentAuditEventPage {
  events: ExperimentAuditEvent[];
  nextId: number;
}

export const MATCH_PROTOCOL_VERSION = 1 as const;
export const MATCH_OUTPUT_LIMIT_BYTES = 16 * 1024;

export type MazeDirection = "north" | "east" | "south" | "west";
export type MatchPluginRole = "generator" | "solver";

export interface GeneratorRules {
  size: 31;
  start: Coordinate;
  goal: Coordinate;
}

export type GeneratorRequest =
  | { type: "generator.start"; rules: GeneratorRules; seed: string }
  | { type: "generator.next" };

export type GeneratorResponse =
  | { type: "generator.carve"; from: Coordinate; to: Coordinate }
  | { type: "generator.complete" };

export type SolverRequest =
  | { type: "solver.start"; start: Coordinate; goal: Coordinate }
  | {
    type: "solver.next";
    position: Coordinate;
    start: Coordinate;
    goal: Coordinate;
    openDirections: MazeDirection[];
    remainingSteps: number;
    previousAction: { direction: MazeDirection; moved: boolean } | null;
  };

export type SolverResponse =
  | { type: "solver.ready" }
  | { type: "solver.move"; direction: MazeDirection; kind: "move" | "backtrack" };

export interface MatchProtocolRequest {
  protocolVersion: typeof MATCH_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
  role: MatchPluginRole;
  payload: GeneratorRequest | SolverRequest;
}

export interface MatchProtocolResponse {
  protocolVersion: typeof MATCH_PROTOCOL_VERSION;
  requestId: string;
  sequence: number;
  role: MatchPluginRole;
  payload: GeneratorResponse | SolverResponse;
}

export interface GeneratorCapability {
  handle(request: GeneratorRequest): GeneratorResponse | Promise<GeneratorResponse>;
}

export interface SolverCapability {
  handle(request: SolverRequest): SolverResponse | Promise<SolverResponse>;
}

export interface MatchPluginContext {
  provide(name: "mazeGenerator", capability: GeneratorCapability): () => void;
  provide(name: "mazeSolver", capability: SolverCapability): () => void;
}

export type DomainErrorCode =
  | "ACTIVE_EXPERIMENT_EXISTS"
  | "EXPERIMENT_NOT_FOUND"
  | "INVALID_EXPERIMENT_NAME"
  | "EXPERIMENT_BUDGET_INVALID"
  | "MATCH_NOT_FOUND"
  | "MATCH_DATA_CORRUPT"
  | "MODEL_PROFILE_INVALID"
  | "MODEL_PROFILE_FROZEN"
  | "INVALID_EXPERIMENT_STATE"
  | "BASELINE_NOT_READY"
  | "RUNTIME_NOT_FOUND"
  | "RUNTIME_STATE_INVALID"
  | "USAGE_INVALID"
  | "GENERATION_COMMIT_FAILED"
  | "CLONE_FAILED"
  | "FORK_FAILED"
  | "UNSEAL_FAILED"
  | "EXHIBITION_INVALID";

export interface DomainErrorResponse {
  error: {
    code: DomainErrorCode;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}
