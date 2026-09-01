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
  harnessEnvironments: HarnessAgentEnvironments;
}

export interface CreateExperimentRequest {
  name: string;
  modelProfile: ModelProfileInput;
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

export type ArenaMatchStatus = "running" | "completed";

export interface ArenaMatch {
  id: string;
  experimentId: string;
  seed: string;
  protocolVersion: 1;
  status: ArenaMatchStatus;
  committedEventCount: number;
  totalEventCount: number;
  score: MatchScore | null;
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

export type DomainErrorCode =
  | "ACTIVE_EXPERIMENT_EXISTS"
  | "EXPERIMENT_NOT_FOUND"
  | "INVALID_EXPERIMENT_NAME"
  | "MATCH_NOT_FOUND"
  | "MATCH_DATA_CORRUPT"
  | "MODEL_PROFILE_INVALID"
  | "MODEL_PROFILE_FROZEN"
  | "INVALID_EXPERIMENT_STATE";

export interface DomainErrorResponse {
  error: {
    code: DomainErrorCode;
    message: string;
    issues?: Array<{ path: string; message: string }>;
  };
}
