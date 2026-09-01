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
}

export interface CreateExperimentRequest {
  name: string;
}

export interface ExperimentListResponse {
  experiments: Experiment[];
}

export type DomainErrorCode =
  | "ACTIVE_EXPERIMENT_EXISTS"
  | "EXPERIMENT_NOT_FOUND"
  | "INVALID_EXPERIMENT_NAME";

export interface DomainErrorResponse {
  error: {
    code: DomainErrorCode;
    message: string;
  };
}
