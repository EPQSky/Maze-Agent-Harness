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

export type DomainErrorCode =
  | "ACTIVE_EXPERIMENT_EXISTS"
  | "EXPERIMENT_NOT_FOUND"
  | "INVALID_EXPERIMENT_NAME"
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
