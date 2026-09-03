import type {
  ArenaMatch,
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  MatchEventPage,
  MatchEventAcknowledgement,
  MatchEventDelivery,
  RawMatchEventPage,
  ExperimentAuditEventPage,
  ExperimentListResponse,
  HarnessCatalogResponse,
  ModelProfileInput,
  UpdateModelProfileRequest,
  BaselineValidationRecord,
  ExperimentRuntimeSnapshot,
  FrozenExperimentConfiguration,
  GenerationRoleResult,
  MatchListResponse,
} from "@maze-arena/contracts";
import {
  ControlPlaneRepository,
  ExperimentRuntimeRepository,
  type BaselineValidationAdapter,
} from "@maze-arena/control-plane";
import {
  type HarnessAdapter,
  ModelProfileValidationError,
  validateModelProfileSnapshot,
} from "@maze-arena/dsh-integration";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import {
  ActiveExperimentExistsError,
  ExperimentNotFoundError,
  ExperimentRepository,
  InvalidExperimentStateError,
  ModelProfileFrozenError,
} from "./experiment-repository.js";
import { MatchDataCorruptError, MatchRepository } from "./match-repository.js";
import { AuditRepository } from "./audit-repository.js";
import type { ArenaMatchRunner } from "@maze-arena/match-profile";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { registerControlRoutes } from "./control-routes.js";
import { createRealBaselineValidationAdapter } from "./baseline-validation.js";
import { AutonomousExperimentRunner, type AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import { createLocalEvolutionAdapter } from "./local-evolution-adapter.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { runVersionedPluginMatch } from "./versioned-match-runner.js";

export interface ArenaServerOptions {
  databasePath: string;
  harnessRoot?: string;
  harnessAdapter: HarnessAdapter;
  logger?: FastifyServerOptions["logger"];
  webRoot?: string;
  startupCommitted?: () => boolean;
  matchBatchSize?: number;
  matchBatchDelayMs?: number;
  matchRunner: ArenaMatchRunner;
  baselineValidationAdapter?: (experiment: Experiment) => BaselineValidationAdapter;
  compatibilityFingerprint?: string;
  pluginRoots?: { generator: string; solver: string };
  autonomousEvolutionAdapter?: AutonomousEvolutionAdapter;
}

type ShutdownSignal = "SIGTERM" | "SIGINT";

interface ShutdownSignalTarget {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export function installPersistentShutdownHandlers(
  close: () => Promise<void>,
  onFailure: (error: unknown) => void,
  target: ShutdownSignalTarget = process,
  holdOpen: () => () => void = () => {
    const timer = setInterval(() => {}, 60_000);
    return () => clearInterval(timer);
  },
): { begin: () => Promise<void> } {
  const signals: ShutdownSignal[] = ["SIGTERM", "SIGINT"];
  let closing: Promise<void> | undefined;
  let failureReported = false;
  let releaseHold: (() => void) | undefined;
  const dispose = () => {
    for (const signal of signals) target.off(signal, handleSignal);
  };
  const begin = () => {
    releaseHold ??= holdOpen();
    closing ??= Promise.resolve()
      .then(close)
      .then(() => {
        releaseHold?.();
        dispose();
      }, (error) => {
        if (!failureReported) {
          failureReported = true;
          onFailure(error);
        }
        // 关闭失败后保持信号监听与唯一 pending Promise，防止后续信号恢复 Node 默认终止行为。
        return new Promise<void>(() => {});
      });
    return closing;
  };
  const handleSignal = () => { void begin(); };
  for (const signal of signals) target.on(signal, handleSignal);
  return { begin };
}

const webContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
}

function parseCostLimit(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("成本上限必须为正有限数字");
  }
  return value;
}

export function createArenaServer(options: ArenaServerOptions): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? false });
  if (options.startupCommitted) {
    server.addHook("onRequest", async (_request, reply) => {
      if (!options.startupCommitted!()) {
        return reply.code(503).send({ error: { code: "STARTUP_PENDING", message: "生产服务正在等待启动确认" } });
      }
    });
  }
  const harnessAdapter = options.harnessAdapter;
  const harnessRoot = options.harnessRoot ?? `${options.databasePath === ":memory:" ? "/tmp/maze-arena" : options.databasePath}.harness`;
  const experiments = new ExperimentRepository(options.databasePath, harnessRoot);
  const matches = new MatchRepository(options.databasePath);
  const audits = new AuditRepository(options.databasePath);
  const controlPlane = new ControlPlaneRepository(options.databasePath);
  const runtime = new ExperimentRuntimeRepository(options.databasePath);
  const lineageRoot = options.databasePath === ":memory:"
    ? `${harnessRoot}.lineages`
    : resolve(dirname(options.databasePath), "lineages");
  const lineage = new PluginLineageRepository(lineageRoot, options.databasePath);
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const backgroundMatches = new Set<Promise<void>>();
  const matchBatchSize = options.matchBatchSize ?? 96;
  const matchBatchDelayMs = options.matchBatchDelayMs ?? 4;
  const matchRunner = options.matchRunner;
  const subscribers = new Map<string, Set<{ socket: import("ws").WebSocket; delivered: number }>>();

  void server.register(websocket);

  server.get("/api/health", async () => ({
    status: "ok" as const,
    instanceId: process.env.ARENA_INSTANCE_ID ?? null,
    pid: process.pid,
  }));

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
    if (modelProfile.catalogIdentity && modelProfile.catalogCapabilities) {
      return validateModelProfileSnapshot(modelProfile);
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
    await autonomousRunner.close();
    await Promise.allSettled(backgroundMatches);
    matches.close();
    audits.close();
    experiments.close();
    controlPlane.close();
    runtime.close();
    lineage.close();
  });

  function publishCommittedEvents(matchId: string): void {
    for (const subscriber of subscribers.get(matchId) ?? []) {
      if (subscriber.socket.readyState !== 1) continue;
      const page = matches.readEvents(matchId, subscriber.delivered, 1_024);
      if (!page || (page.events.length === 0 && page.match.status === "running")) continue;
      const delivery: MatchEventDelivery = { type: "match.events", page };
      subscriber.socket.send(JSON.stringify(delivery));
      subscriber.delivered = page.nextSequence;
    }
  }

  async function appendRemainingEvents(
    matchId: string,
    events: readonly import("@maze-arena/contracts").MatchEvent[],
    start: number,
    score: import("@maze-arena/contracts").MatchScore,
  ): Promise<void> {
    for (let cursor = start; cursor < events.length; cursor += matchBatchSize) {
      if (matchBatchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, matchBatchDelayMs));
      const batch = events.slice(cursor, cursor + matchBatchSize);
      const completed = cursor + batch.length === events.length;
      matches.appendEvents(matchId, batch, completed ? score : undefined);
      publishCommittedEvents(matchId);
    }
    if (start === events.length) {
      matches.appendEvents(matchId, [], score);
      publishCommittedEvents(matchId);
    }
  }

  function runMatchInBackground(match: ArenaMatch, runner: ArenaMatchRunner = matchRunner, cleanup?: () => void): void {
    let streamed = 0;
    const task = (async () => {
      try {
        const result = await runner.run(match.seed, async (events) => {
          const terminalIndex = events.findIndex(({ type }) => type === "match.completed");
          const committable = terminalIndex < 0 ? events : events.slice(0, terminalIndex);
          if (committable.length > 0) {
            matches.appendEvents(match.id, committable);
            publishCommittedEvents(match.id);
          }
          streamed += committable.length;
        });
        if (streamed > result.events.length) throw new Error("比赛运行器提交的事件数量超过最终结果");
        await appendRemainingEvents(match.id, result.events, streamed, result.score);
        audits.append(match.experimentId, "match.completed", { matchId: match.id });
      } catch (error) {
        try {
          matches.fail(match.id);
          publishCommittedEvents(match.id);
          audits.append(match.experimentId, "match.failed", { matchId: match.id });
        } catch (failure) {
          server.log.error({ err: new AggregateError([error, failure], "比赛失败且无法持久化失败终态") });
        }
      }
    })();
    backgroundMatches.add(task);
    void task.finally(() => { backgroundMatches.delete(task); cleanup?.(); });
  }

  function matchDataError(reply: FastifyReply, error: unknown) {
    if (error instanceof MatchDataCorruptError) {
      return reply.code(500).send({ error: { code: "MATCH_DATA_CORRUPT", message: error.message } });
    }
  }

  function sealedHiddenMatch(id: string): ArenaMatch | undefined {
    const match = matches.getMetadata(id);
    if (match?.observation?.evaluationType === "hidden" && runtime.get(match.experimentId)?.sealed) return match;
    return undefined;
  }

  function publicMatch(match: ArenaMatch): ArenaMatch {
    if (match.observation?.evaluationType !== "hidden" || !runtime.get(match.experimentId)?.sealed) return match;
    return { ...match, seed: "[sealed]", observation: { ...match.observation, replayable: false } };
  }

  const startExhibitionMatch = (input: {
    experimentId: string; seed: string; generatorCommit: string; solverCommit: string;
    generation?: number; exhibitionId?: string;
  }): string => {
    if (!lineage.contains(input.experimentId, "generator", input.generatorCommit)
      || !lineage.contains(input.experimentId, "solver", input.solverCommit)) {
      throw new Error("展示局版本不属于该实验的受保护谱系");
    }
    const scratch = mkdtempSync(join(tmpdir(), "maze-exhibition-"));
    const generatorRoot = join(scratch, "generator");
    const solverRoot = join(scratch, "solver");
    try {
      lineage.materialize(input.experimentId, "generator", input.generatorCommit, generatorRoot);
      lineage.materialize(input.experimentId, "solver", input.solverCommit, solverRoot);
      const match = matches.start(input.experimentId, input.seed, 0, {
        generation: input.generation ?? null,
        role: "exhibition",
        opponent: `${input.generatorCommit.slice(0, 12)} / ${input.solverCommit.slice(0, 12)}`,
        evaluationType: "exhibition",
        result: "completed",
        replayable: true,
      }, input.exhibitionId);
      if (match.committedEventCount > 0 || match.status !== "running") {
        rmSync(scratch, { recursive: true, force: true });
        return match.id;
      }
      runMatchInBackground(match, {
        run: (seed, onEvents) => runVersionedPluginMatch({ seed, generatorRoot, solverRoot, onEvents }),
      }, () => rmSync(scratch, { recursive: true, force: true }));
      return match.id;
    } catch (error) {
      rmSync(scratch, { recursive: true, force: true });
      throw error;
    }
  };

  const autonomousRunner = new AutonomousExperimentRunner(
    runtime,
    experiments,
    audits,
    options.autonomousEvolutionAdapter ?? createLocalEvolutionAdapter({
      harness: harnessAdapter,
      experiments,
      lineage,
      runtime,
      audits,
      startExhibition: startExhibitionMatch,
    }),
  );
  autonomousRunner.resumePersisted();

  registerControlRoutes({
    server,
    experiments,
    audits,
    controlPlane,
    runtime,
    lineage,
    harnessAdapter,
    autonomousRunner,
    compatibilityFingerprint: options.compatibilityFingerprint ?? "maze-arena-v1",
    baselineValidationAdapter: options.baselineValidationAdapter ?? ((experiment) => createRealBaselineValidationAdapter({
      experiment,
      harnessAdapter,
      matchRunner,
      matches,
      lineage,
      pluginRoots: options.pluginRoots ?? {
        generator: resolve(workspaceRoot, "packages/generator-plugin"),
        solver: resolve(workspaceRoot, "packages/solver-plugin"),
      },
    })),
    startExhibition: ({ experimentId, seed, exhibitionId, generatorCommit, solverCommit }) => startExhibitionMatch({
      experimentId, seed, exhibitionId, generatorCommit, solverCommit,
    }),
  });

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
        const costLimit = parseCostLimit(request.body.costLimit);
        return reply.code(201).send(experiments.create(request.body.name.trim(), modelProfile, costLimit));
      } catch (error) {
        if (error instanceof ModelProfileValidationError) return modelProfileError(reply, error);
        if (error instanceof Error && error.message.includes("成本上限")) {
          return reply.code(400).send({ error: { code: "EXPERIMENT_BUDGET_INVALID", message: error.message } });
        }
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
      if (controlPlane.getBaselineValidation(request.params.id)?.status === "ready") throw new ModelProfileFrozenError();
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
        const experiment = experiments.find(request.params.id);
        if (!experiment) throw new ExperimentNotFoundError(request.params.id);
        revalidateStoredModelProfile(experiment.modelProfile);
        controlPlane.requireReady(request.params.id, options.compatibilityFingerprint ?? "maze-arena-v1");
        const snapshot = runtime.start(request.params.id);
        experiments.setStatus(request.params.id, snapshot.state === "ready" ? "draft" : snapshot.state);
        autonomousRunner.launch(request.params.id);
        return experiments.find(request.params.id)!;
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
    const match = matches.start(request.params.id, seed);
    audits.append(request.params.id, "match.started", { matchId: match.id });
    runMatchInBackground(match);
    return reply.code(202).send(match);
  });

  server.get<{
    Params: { id: string };
    Reply: ArenaMatch | DomainErrorResponse;
  }>("/api/matches/:id", async (request, reply) => {
    try {
      const match = matches.getMetadata(request.params.id);
      if (!match) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "未找到指定比赛" } });
      return publicMatch(match);
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
      if (sealedHiddenMatch(request.params.id)) {
        return reply.code(403).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: "密封期间禁止读取隐藏评测单场事件" } });
      }
      const page = matches.readEvents(request.params.id, Number(request.query.after ?? 0), Number(request.query.limit ?? 256));
      if (!page) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "未找到指定比赛" } });
      return page;
    } catch (error) {
      return matchDataError(reply, error) ?? Promise.reject(error);
    }
  });

  server.get<{
    Params: { id: string };
    Querystring: { after?: string; limit?: string };
    Reply: RawMatchEventPage | DomainErrorResponse;
  }>("/api/matches/:id/raw-events", async (request, reply) => {
    if (sealedHiddenMatch(request.params.id)) {
      return reply.code(403).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: "密封期间禁止读取隐藏评测原始事件" } });
    }
    const page = matches.readRawEvents(request.params.id, Number(request.query.after ?? 0), Number(request.query.limit ?? 256));
    if (!page) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "未找到指定比赛" } });
    return page;
  });

  server.get<{
    Params: { id: string };
    Querystring: { after?: string; limit?: string };
    Reply: ExperimentAuditEventPage | DomainErrorResponse;
  }>("/api/experiments/:id/audit-events", async (request, reply) => {
    if (!["127.0.0.1", "::1"].includes(request.ip)) {
      return reply.code(403).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: "审计视图仅允许本机所有者读取" } });
    }
    return audits.list(request.params.id, Number(request.query.after ?? 0), Number(request.query.limit ?? 256));
  });

  server.after(() => {
    server.get<{ Params: { id: string }; Querystring: { after?: string } }>(
      "/api/matches/:id/live",
      { websocket: true },
      (socket, request) => {
        const matchId = request.params.id;
        if (sealedHiddenMatch(matchId)) { socket.close(1008, "密封期间禁止订阅隐藏评测"); return; }
        const initialAfter = Math.max(0, Number(request.query.after ?? 0));
        const subscriber = { socket, delivered: Number.isSafeInteger(initialAfter) ? initialAfter : 0 };
        const matchSubscribers = subscribers.get(matchId) ?? new Set();
        matchSubscribers.add(subscriber);
        subscribers.set(matchId, matchSubscribers);
        socket.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString()) as MatchEventAcknowledgement;
            if (message.type !== "match.ack" || !Number.isSafeInteger(message.sequence) || message.sequence < 0) return;
            // ACK 只用于客户端恢复游标；服务端投递仍每次从 SQLite 权威记录读取。
            subscriber.delivered = Math.max(subscriber.delivered, message.sequence);
          } catch { socket.close(1003, "消息格式非法"); }
        });
        socket.on("close", () => {
          matchSubscribers.delete(subscriber);
          if (matchSubscribers.size === 0) subscribers.delete(matchId);
        });
        try { publishCommittedEvents(matchId); } catch { socket.close(1011, "比赛事件读取失败"); }
      },
    );
  });

  server.get<{
    Params: { id: string };
    Reply: ArenaMatch | DomainErrorResponse;
  }>("/api/experiments/:id/matches/latest", async (request, reply) => {
    try {
      const match = matches.latestForExperiment(request.params.id);
      if (!match) return reply.code(404).send({ error: { code: "MATCH_NOT_FOUND", message: "该实验尚无比赛" } });
      return publicMatch(match);
    } catch (error) {
      return matchDataError(reply, error) ?? Promise.reject(error);
    }
  });

  server.get<{ Params: { id: string }; Reply: MatchListResponse }>(
    "/api/experiments/:id/matches", async (request) => ({ matches: matches.listForExperiment(request.params.id).map(publicMatch) }),
  );

  if (options.webRoot) {
    const webRoot = resolve(options.webRoot);
    server.setNotFoundHandler(async (request, reply) => {
      if (request.method !== "GET" && request.method !== "HEAD") return reply.code(404).send();
      const requestedPath = request.url.split("?", 1)[0] ?? "/";
      if (requestedPath.startsWith("/api/")) return reply.code(404).send();
      const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
      let assetPath = resolve(webRoot, relativePath);
      if (assetPath !== webRoot && !assetPath.startsWith(`${webRoot}/`)) return reply.code(404).send();
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) assetPath = join(webRoot, "index.html");
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) return reply.code(404).send();
      reply.type(webContentTypes[extname(assetPath)] ?? "application/octet-stream");
      return reply.send(readFileSync(assetPath));
    });
  }

  return server;
}
