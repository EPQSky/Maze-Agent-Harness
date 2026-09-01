import type {
  ArenaMatch,
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  MatchEventPage,
  ExperimentListResponse,
  HarnessCatalogResponse,
  ModelProfileInput,
  UpdateModelProfileRequest,
} from "@maze-arena/contracts";
import {
  type HarnessAdapter,
  ModelProfileValidationError,
} from "@maze-arena/dsh-integration";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  ActiveExperimentExistsError,
  ExperimentNotFoundError,
  ExperimentRepository,
  InvalidExperimentStateError,
  ModelProfileFrozenError,
} from "./experiment-repository.js";
import { MatchDataCorruptError, MatchRepository } from "./match-repository.js";

export interface ArenaServerOptions {
  databasePath: string;
  harnessRoot?: string;
  harnessAdapter: HarnessAdapter;
  logger?: boolean;
  matchBatchSize?: number;
  matchBatchDelayMs?: number;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
}

export function createArenaServer(options: ArenaServerOptions): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });
  const harnessAdapter = options.harnessAdapter;
  const harnessRoot = options.harnessRoot ?? `${options.databasePath === ":memory:" ? "/tmp/maze-arena" : options.databasePath}.harness`;
  const experiments = new ExperimentRepository(options.databasePath, harnessRoot);
  const matches = new MatchRepository(options.databasePath);
  const matchTimers = new Set<ReturnType<typeof setTimeout>>();
  const matchBatchSize = options.matchBatchSize ?? 96;
  const matchBatchDelayMs = options.matchBatchDelayMs ?? 4;

  function validateModelProfile(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ModelProfileValidationError([{ path: "modelProfile", message: "必须提供模型配置档" }]);
    }
    return harnessAdapter.validateModelProfile(input as ModelProfileInput);
  }

  function revalidateStoredModelProfile(modelProfile: Experiment["modelProfile"]) {
    if (!modelProfile) {
      throw new ModelProfileValidationError([{ path: "modelProfile", message: "旧实验尚未配置模型配置档" }]);
    }
    const { providerLabel: _providerLabel, modelLabel: _modelLabel, ...input } = modelProfile;
    return harnessAdapter.validateModelProfile(input);
  }

  function modelProfileError(reply: FastifyReply, error: ModelProfileValidationError) {
    if (error instanceof ModelProfileValidationError) {
      return reply.code(400).send({
        error: { code: "MODEL_PROFILE_INVALID", message: error.message, issues: error.issues },
      });
    }
  }

  server.addHook("onClose", async () => {
    for (const timer of matchTimers) clearTimeout(timer);
    matches.close();
    experiments.close();
  });

  function scheduleBaseline(matchId: string, events: import("@maze-arena/contracts").MatchEvent[], score: import("@maze-arena/contracts").MatchScore) {
    let cursor = 0;
    const commitBatch = () => {
      const batch = events.slice(cursor, cursor + matchBatchSize);
      cursor += batch.length;
      matches.appendEvents(matchId, batch, cursor === events.length ? score : undefined);
      if (cursor < events.length) {
        const timer = setTimeout(() => { matchTimers.delete(timer); commitBatch(); }, matchBatchDelayMs);
        matchTimers.add(timer);
      }
    };
    const timer = setTimeout(() => { matchTimers.delete(timer); commitBatch(); }, matchBatchDelayMs);
    matchTimers.add(timer);
  }

  function matchDataError(reply: FastifyReply, error: unknown) {
    if (error instanceof MatchDataCorruptError) {
      return reply.code(500).send({ error: { code: "MATCH_DATA_CORRUPT", message: error.message } });
    }
  }

  server.get<{ Reply: ExperimentListResponse }>("/api/experiments", async () => ({
    experiments: experiments.list(),
  }));

  server.get<{ Reply: HarnessCatalogResponse }>("/api/harness/models", async () => harnessAdapter.listModels());

  server.get<{ Params: { id: string }; Reply: Experiment | DomainErrorResponse }>(
    "/api/experiments/:id",
    async (request, reply) => {
      const experiment = experiments.find(request.params.id);
      if (!experiment) {
        return reply.code(404).send({
          error: { code: "EXPERIMENT_NOT_FOUND", message: "未找到指定实验" },
        });
      }
      return experiment;
    },
  );

  server.post<{ Body: CreateExperimentRequest; Reply: Experiment | DomainErrorResponse }>(
    "/api/experiments",
    async (request, reply) => {
      if (!validName(request.body?.name)) {
        return reply.code(400).send({
          error: {
            code: "INVALID_EXPERIMENT_NAME",
            message: "实验名称必须为 1 到 120 个非空字符",
          },
        });
      }
      try {
        const modelProfile = validateModelProfile(request.body.modelProfile);
        return reply.code(201).send(experiments.create(request.body.name.trim(), modelProfile));
      } catch (error) {
        if (error instanceof ModelProfileValidationError) return modelProfileError(reply, error);
        throw error;
      }
    },
  );

  server.put<{
    Params: { id: string };
    Body: UpdateModelProfileRequest;
    Reply: Experiment | DomainErrorResponse;
  }>("/api/experiments/:id/model-profile", async (request, reply) => {
    try {
      const modelProfile = validateModelProfile(request.body?.modelProfile);
      return experiments.updateModelProfile(request.params.id, modelProfile);
    } catch (error) {
      if (error instanceof ModelProfileValidationError) return modelProfileError(reply, error);
      if (error instanceof ExperimentNotFoundError) {
        return reply.code(404).send({ error: { code: "EXPERIMENT_NOT_FOUND", message: error.message } });
      }
      if (error instanceof ModelProfileFrozenError) {
        return reply.code(409).send({ error: { code: "MODEL_PROFILE_FROZEN", message: error.message } });
      }
      throw error;
    }
  });

  server.post<{ Params: { id: string }; Reply: Experiment | DomainErrorResponse }>(
    "/api/experiments/:id/start",
    async (request, reply) => {
      try {
        return experiments.start(request.params.id, revalidateStoredModelProfile);
      } catch (error) {
        if (error instanceof ModelProfileValidationError) return modelProfileError(reply, error);
        if (error instanceof ExperimentNotFoundError) {
          return reply.code(404).send({
            error: { code: "EXPERIMENT_NOT_FOUND", message: error.message },
          });
        }
        if (error instanceof ActiveExperimentExistsError) {
          return reply.code(409).send({
            error: { code: "ACTIVE_EXPERIMENT_EXISTS", message: error.message },
          });
        }
        if (error instanceof InvalidExperimentStateError) {
          return reply.code(409).send({
            error: { code: "INVALID_EXPERIMENT_STATE", message: error.message },
          });
        }
        throw error;
      }
    },
  );

  server.post<{
    Params: { id: string };
    Body: { seed?: string };
    Reply: ArenaMatch | DomainErrorResponse;
  }>("/api/experiments/:id/matches/baseline", async (request, reply) => {
    const experiment = experiments.find(request.params.id);
    if (!experiment) {
      return reply.code(404).send({ error: { code: "EXPERIMENT_NOT_FOUND", message: "未找到指定实验" } });
    }
    if (!(["draft", "running"] as const).includes(experiment.status as "draft" | "running")) {
      return reply.code(409).send({
        error: { code: "INVALID_EXPERIMENT_STATE", message: `实验当前状态 ${experiment.status} 不允许运行基线比赛` },
      });
    }
    const seed = typeof request.body?.seed === "string" && request.body.seed.length > 0
      ? request.body.seed.slice(0, 200)
      : "baseline-v1";
    const prepared = matches.prepareBaseline(request.params.id, seed);
    scheduleBaseline(prepared.match.id, prepared.events, prepared.score);
    return reply.code(202).send(prepared.match);
  });

  server.get<{
    Params: { id: string };
    Reply: ArenaMatch | DomainErrorResponse;
  }>("/api/matches/:id", async (request, reply) => {
    try {
      const match = matches.getMetadata(request.params.id);
      if (!match) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "未找到指定比赛" } });
      return match;
    } catch (error) {
      return matchDataError(reply, error) ?? Promise.reject(error);
    }
  });

  server.get<{
    Params: { id: string };
    Querystring: { after?: string; limit?: string };
    Reply: MatchEventPage | DomainErrorResponse;
  }>("/api/matches/:id/events", async (request, reply) => {
    try {
      const page = matches.readEvents(request.params.id, Number(request.query.after ?? 0), Number(request.query.limit ?? 256));
      if (!page) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "未找到指定比赛" } });
      return page;
    } catch (error) {
      return matchDataError(reply, error) ?? Promise.reject(error);
    }
  });

  server.get<{
    Params: { id: string };
    Reply: ArenaMatch | DomainErrorResponse;
  }>("/api/experiments/:id/matches/latest", async (request, reply) => {
    try {
      const match = matches.latestForExperiment(request.params.id);
      if (!match) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "该实验尚无比赛" } });
      return match;
    } catch (error) {
      return matchDataError(reply, error) ?? Promise.reject(error);
    }
  });

  return server;
}
