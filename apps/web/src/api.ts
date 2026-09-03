import type {
  ArenaMatch,
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
  HarnessCatalogResponse,
  ModelProfileInput,
  MatchEventPage,
  MatchEventDelivery,
  BaselineValidationRecord,
  ExperimentRuntimeSnapshot,
  ExperimentAuditEventPage,
  MatchListResponse,
  LineageHistoryResponse,
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

  getBaselineValidation(id: string): Promise<BaselineValidationRecord> {
    return request<BaselineValidationRecord>(`/api/experiments/${id}/baseline-validation`);
  },

  runBaselineValidation(id: string, smokeProvider = false): Promise<BaselineValidationRecord> {
    return request<BaselineValidationRecord>(`/api/experiments/${id}/baseline-validation/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ smokeProvider }),
    });
  },

  confirmBaseline(id: string): Promise<BaselineValidationRecord> {
    return request<BaselineValidationRecord>(`/api/experiments/${id}/baseline-validation/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
  },

  async getRuntime(id: string): Promise<ExperimentRuntimeSnapshot | null> {
    const response = await fetch(`/api/experiments/${id}/runtime`);
    if (response.status === 404) return null;
    const body = (await response.json()) as ExperimentRuntimeSnapshot | DomainErrorResponse;
    if (!response.ok) throw new Error((body as DomainErrorResponse).error.message);
    return body as ExperimentRuntimeSnapshot;
  },

  runtimeAction(id: string, action: "start" | "pause" | "resume" | "cancel"): Promise<ExperimentRuntimeSnapshot> {
    return request<ExperimentRuntimeSnapshot>(`/api/experiments/${id}/runtime/${action}`, { method: "POST" });
  },

  cloneComparison(id: string, name: string, modelProfile: ModelProfileInput, costLimit?: number | null): Promise<ExperimentRuntimeSnapshot> {
    return request<ExperimentRuntimeSnapshot>(`/api/experiments/${id}/comparison-clones`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, modelProfile, costLimit }),
    });
  },

  forkContinuation(
    id: string,
    name: string,
    modelProfile: ModelProfileInput,
    compatibilityFingerprint?: string,
    generatorCommit?: string,
    solverCommit?: string,
    costLimit?: number | null,
  ): Promise<ExperimentRuntimeSnapshot> {
    return request<ExperimentRuntimeSnapshot>(`/api/experiments/${id}/continuation-forks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, modelProfile, compatibilityFingerprint, generatorCommit, solverCommit, costLimit }),
    });
  },

  unsealGroup(id: string): Promise<ExperimentRuntimeSnapshot[]> {
    return request<ExperimentRuntimeSnapshot[]>(`/api/experiments/${id}/seal-group/unseal`, { method: "POST" });
  },

  createExhibition(id: string, generatorCommit: string, solverCommit: string, publicSeed: string): Promise<{ matchId: string }> {
    return request<{ matchId: string }>(`/api/experiments/${id}/exhibitions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ generatorCommit, solverCommit, publicSeed }),
    });
  },

  getAuditEvents(id: string): Promise<ExperimentAuditEventPage> {
    return request<ExperimentAuditEventPage>(`/api/experiments/${id}/audit-events`);
  },

  getLineages(id: string): Promise<LineageHistoryResponse> {
    return request<LineageHistoryResponse>(`/api/experiments/${id}/lineages`);
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

  async listMatches(experimentId: string): Promise<ArenaMatch[]> {
    return (await request<MatchListResponse>(`/api/experiments/${experimentId}/matches`)).matches;
  },

  getMatch(matchId: string): Promise<ArenaMatch> {
    return request<ArenaMatch>(`/api/matches/${matchId}`);
  },

  getMatchEvents(matchId: string, afterSequence: number): Promise<MatchEventPage> {
    return request<MatchEventPage>(`/api/matches/${matchId}/events?after=${afterSequence}&limit=256`);
  },

  subscribeMatchEvents(
    matchId: string,
    afterSequence: number,
    onPage: (page: MatchEventPage) => void,
    onError: (error: Error) => void,
  ): () => void {
    if (typeof WebSocket === "undefined") return () => undefined;
    const url = new URL(`/api/matches/${matchId}/live?after=${afterSequence}`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.onmessage = (event) => {
      try {
        const delivery = JSON.parse(String(event.data)) as MatchEventDelivery;
        if (delivery.type !== "match.events") throw new Error("比赛事件通知类型非法");
        onPage(delivery.page);
        socket.send(JSON.stringify({ type: "match.ack", sequence: delivery.page.nextSequence }));
      } catch (reason) {
        onError(reason instanceof Error ? reason : new Error("比赛事件通知无法解析"));
      }
    };
    socket.onerror = () => onError(new Error("比赛直播连接暂时不可用，正在从权威事件记录补齐"));
    return () => socket.close();
  },
};
