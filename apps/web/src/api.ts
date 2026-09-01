import type {
  ArenaMatch,
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
  HarnessCatalogResponse,
  ModelProfileInput,
  MatchEventPage,
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
  getHarnessCatalog(): Promise<HarnessCatalogResponse> {
    return request<HarnessCatalogResponse>("/api/harness/models");
  },

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

  updateModelProfile(id: string, modelProfile: ModelProfileInput): Promise<Experiment> {
    return request<Experiment>(`/api/experiments/${id}/model-profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelProfile }),
    });
  },

  startExperiment(id: string): Promise<Experiment> {
    return request<Experiment>(`/api/experiments/${id}/start`, { method: "POST" });
  },

  runBaselineMatch(experimentId: string, seed = "baseline-v1"): Promise<ArenaMatch> {
    return request<ArenaMatch>(`/api/experiments/${experimentId}/matches/baseline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed }),
    });
  },

  async getLatestMatch(experimentId: string): Promise<ArenaMatch | null> {
    const response = await fetch(`/api/experiments/${experimentId}/matches/latest`);
    if (response.status === 404) return null;
    const body = (await response.json()) as ArenaMatch | DomainErrorResponse;
    if (!response.ok) throw new Error((body as DomainErrorResponse).error?.message ?? "读取历史比赛失败");
    return body as ArenaMatch;
  },

  getMatchEvents(matchId: string, afterSequence: number): Promise<MatchEventPage> {
    return request<MatchEventPage>(`/api/matches/${matchId}/events?after=${afterSequence}&limit=256`);
  },
};
