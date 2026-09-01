import type {
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
} from "@maze-arena/contracts";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = (await response.json()) as T | DomainErrorResponse;
  if (!response.ok) {
    const error = body as DomainErrorResponse;
    throw new Error(error.error?.message ?? "请求失败");
  }
  return body as T;
}

export const arenaApi = {
  async listExperiments(): Promise<Experiment[]> {
    const response = await request<ExperimentListResponse>("/api/experiments");
    return response.experiments;
  },

  createExperiment(payload: CreateExperimentRequest): Promise<Experiment> {
    return request<Experiment>("/api/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  startExperiment(id: string): Promise<Experiment> {
    return request<Experiment>(`/api/experiments/${id}/start`, { method: "POST" });
  },
};
