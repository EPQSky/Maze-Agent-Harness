import type {
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
} from "@maze-arena/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ActiveExperimentExistsError,
  ExperimentNotFoundError,
  ExperimentRepository,
} from "./experiment-repository.js";

export interface ArenaServerOptions {
  databasePath: string;
  logger?: boolean;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
}

export function createArenaServer(options: ArenaServerOptions): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });
  const experiments = new ExperimentRepository(options.databasePath);

  server.addHook("onClose", async () => {
    experiments.close();
  });

  server.get<{ Reply: ExperimentListResponse }>("/api/experiments", async () => ({
    experiments: experiments.list(),
  }));

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
      return reply.code(201).send(experiments.create(request.body.name.trim()));
    },
  );

  server.post<{ Params: { id: string }; Reply: Experiment | DomainErrorResponse }>(
    "/api/experiments/:id/start",
    async (request, reply) => {
      try {
        return experiments.start(request.params.id);
      } catch (error) {
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
        throw error;
      }
    },
  );

  return server;
}
