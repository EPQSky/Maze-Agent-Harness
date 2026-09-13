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
  RealDshCanaryReport,
  RealDshCanaryRequest,
} from "@maze-arena/contracts";
import { REAL_DSH_CANARY_MAX_COST, REAL_DSH_CANARY_MAX_TOKENS } from "@maze-arena/contracts";
import {
  assertSupportedRuntimeDatabaseSchema,
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
import type { ArenaMatchRunner, PairedEvaluationRunner, TrustedCandidateTestRunner, VersionedMatchRunner } from "@maze-arena/match-profile";
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
import { createHash } from "node:crypto";
import { buildCanaryReport, CanaryAcceptanceRepository } from "./canary-acceptance.js";
import { isImmutableImageReference } from "./immutable-image-reference.js";

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
  candidateTestRunner?: TrustedCandidateTestRunner;
  pairedEvaluationRunner?: PairedEvaluationRunner;
  matchImageDigest?: string;
  resourcePolicyDigest?: string;
  versionedMatchRunner?: VersionedMatchRunner;
  autonomousEvolutionAdapter?: AutonomousEvolutionAdapter;
  backupManager?: { create(trigger: "experiment-start" | "experiment-terminal"): unknown };
  canaryPreflight?: {
    executionKind: "real-provider" | "deterministic-fixture";
    serverDoctor(): Promise<{
      checkedAt: string;
      runtimeIdentity: {
        harnessPackage: string;
        harnessVersion: string;
        modelCatalogRelease: string;
        modelReleaseSha256: string;
        imageDigest: string;
        harnessRuntimePayloadSha256: string;
      };
      completeBackup: { backupId: string; createdAt: string };
    }>;
    allowDeterministicTestRun?: boolean;
  };
}

type ShutdownSignal = "SIGTERM" | "SIGINT";

class BackupBoundaryError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "完整备份失败");
    this.name = "BackupBoundaryError";
  }
}

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
  // 在任何 Repository 建表前拒绝未发布 schema，避免启动失败后留下部分当前结构。
  assertSupportedRuntimeDatabaseSchema(options.databasePath);
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
  const canaries = new CanaryAcceptanceRepository(options.databasePath);
  const lineageRoot = options.databasePath === ":memory:"
    ? `${harnessRoot}.lineages`
    : resolve(dirname(options.databasePath), "lineages");
  const lineage = new PluginLineageRepository(lineageRoot, options.databasePath);
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const pluginRoots = options.pluginRoots ?? {
    generator: resolve(workspaceRoot, "packages/generator-plugin"),
    solver: resolve(workspaceRoot, "packages/solver-plugin"),
  };
  const backgroundMatches = new Set<Promise<void>>();
  const matchBatchSize = options.matchBatchSize ?? 96;
  const matchBatchDelayMs = options.matchBatchDelayMs ?? 4;
  const matchRunner = options.matchRunner;
  const subscribers = new Map<string, Set<{ socket: import("ws").WebSocket; delivered: number }>>();

  // 终态报告必须在 experiment-terminal 备份前写入 SQLite，且重复收尾回调不得覆盖首份证据。
  const persistCanaryTerminalReport = (experimentId: string): boolean => {
    try {
      const row = canaries.finishExperiment(experimentId);
      if (!row || row.terminal_report_json) return true;
      const report = buildCanaryReport({
        row,
        runtime,
        lineage,
        audits,
        frozenModelProfile: controlPlane.getBaselineValidation(experimentId)?.frozenConfiguration?.modelProfile ?? null,
      });
      if (report.status === "running" || report.completedAt === null) {
        server.log.error({ experimentId, canaryId: row.canary_id }, "金丝雀已关闭但尚未形成终态报告");
        return false;
      }
      canaries.persistTerminalReport(row.canary_id, report);
      return true;
    } catch (error) {
      // 报告落盘失败时禁止创建缺证据的终态备份；重启恢复会再次尝试补写。
      server.log.error({ err: error, experimentId }, "金丝雀终态报告持久化失败");
      return false;
    }
  };

  const terminalBackupsAttempted = new Set<string>();
  const terminalBackupsCreated = new Set<string>();
  const createCanaryTerminalBackup = (experimentId: string): void => {
    if (!options.backupManager || terminalBackupsAttempted.has(experimentId) || terminalBackupsCreated.has(experimentId)) return;
    const canary = canaries.getByExperimentId(experimentId);
    const marker: Record<string, string> = canary?.terminal_report_json ? {
      canaryId: canary.canary_id,
      terminalReportSha256: createHash("sha256").update(canary.terminal_report_json).digest("hex"),
    } : {};
    if (audits.hasBackupCreated(experimentId, "experiment-terminal", marker)) {
      terminalBackupsCreated.add(experimentId);
      return;
    }
    // 失败后本进程内不重复制造备份；重启时依靠持久化审计重新尝试。
    terminalBackupsAttempted.add(experimentId);
    try {
      options.backupManager.create("experiment-terminal");
      const idempotencyKey = marker.canaryId
        ? `experiment-terminal-canary-backup:${experimentId}`
        : `experiment-terminal-backup:${experimentId}`;
      audits.appendOnce(idempotencyKey, experimentId, "backup.created", {
        trigger: "experiment-terminal", ...marker,
      });
      terminalBackupsCreated.add(experimentId);
    } catch (error) {
      try { audits.append(experimentId, "backup.failed", { trigger: "experiment-terminal" }); }
      catch (auditError) { server.log.error({ err: auditError, experimentId }, "实验终态备份失败审计写入失败"); }
      server.log.error({ err: error, experimentId }, "实验终态完整备份失败");
    }
  };

  const settleTerminalExperiment = (experimentId: string): void => {
    if (persistCanaryTerminalReport(experimentId)) createCanaryTerminalBackup(experimentId);
  };

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
    canaries.close();
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
        run: (seed, onEvents) => {
          if (!options.versionedMatchRunner) throw new Error("版本化展示局必须配置 Docker Match Profile 执行器");
          return options.versionedMatchRunner.runVersioned({
            seed,
            generator: { commit: input.generatorCommit, root: generatorRoot },
            solver: { commit: input.solverCommit, root: solverRoot },
            onEvents,
          });
        },
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
      pluginRoots,
      candidateTestRunner: options.candidateTestRunner ?? {
        run: () => { throw new Error("候选权威测试必须配置摘要锁定的 Docker 隔离执行器"); },
      },
      pairedEvaluationRunner: options.pairedEvaluationRunner ?? {
        evaluate: () => { throw new Error("自治配对评测必须配置摘要锁定的 Docker 隔离执行器"); },
      },
      matchImageDigest: options.matchImageDigest ?? "unconfigured-match-image",
      resourcePolicyDigest: options.resourcePolicyDigest ?? "unconfigured-resource-policy",
      startExhibition: startExhibitionMatch,
    }),
    (experimentId) => {
      if (persistCanaryTerminalReport(experimentId)) createCanaryTerminalBackup(experimentId);
    },
    (experimentId) => {
      if (options.backupManager) {
        options.backupManager.create("experiment-start");
        audits.append(experimentId, "backup.created", { trigger: "experiment-start", resumed: true });
      }
    },
    (experimentId) => canaries.remaining(experimentId) ? {
      remaining: () => canaries.remaining(experimentId) ?? { tokens: 0, cost: 0 },
      consume: (usage) => canaries.consume(experimentId, usage),
      consumeOnce: (batchId, usage) => canaries.consumeOnce(batchId, experimentId, usage),
    } : undefined,
    settleTerminalExperiment,
  );

  // 启动恢复先收敛未能注册运行时的孤儿金丝雀，再恢复仍有运行时记录的实验。
  // 这样 reserve/attach 与 registerReady 之间的进程崩溃不会永久占用单例租约。
  const runtimeSnapshots = runtime.list();
  const activeExperimentIds = new Set(
    runtimeSnapshots.filter((snapshot) => snapshot.state === "running").map((snapshot) => snapshot.experimentId),
  );
  const terminalExperimentIds = new Set(
    runtimeSnapshots.filter((snapshot) => ["paused", "completed", "failed", "cancelled"].includes(snapshot.state))
      .map((snapshot) => snapshot.experimentId),
  );
  for (const orphan of canaries.recoverOrphaned(activeExperimentIds, terminalExperimentIds)) {
    if (persistCanaryTerminalReport(orphan.experiment_id)) createCanaryTerminalBackup(orphan.experiment_id);
  }
  for (const pending of canaries.listUnreportedTerminalReports()) {
    // 该记录尚未有终态报告；本次启动补写成功后立即备份，覆盖进程在 terminalSettled 前退出的窗口。
    const persisted = persistCanaryTerminalReport(pending.experiment_id);
    if (persisted) createCanaryTerminalBackup(pending.experiment_id);
  }
  for (const reported of canaries.listReportedTerminalReports()) {
    // 报告已存在但上次进程可能在备份失败，或在写入成功审计前崩溃；缺少成功事实时必须重试。
    createCanaryTerminalBackup(reported.experiment_id);
  }
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
      pluginRoots,
    })),
    startExhibition: ({ experimentId, seed, exhibitionId, generatorCommit, solverCommit }) => startExhibitionMatch({
      experimentId, seed, exhibitionId, generatorCommit, solverCommit,
    }),
    backupBoundary: (trigger, experimentId) => {
      if (trigger === "experiment-terminal") {
        settleTerminalExperiment(experimentId);
        return;
      }
      if (options.backupManager) {
        options.backupManager.create(trigger);
        audits.append(experimentId, "backup.created", { trigger });
      }
    },
  });

  server.get<{ Reply: ExperimentListResponse }>("/api/experiments", async () => ({
    experiments: experiments.list(),
  }));

  server.get<{ Reply: HarnessCatalogResponse }>("/api/harness/models", async () => harnessAdapter.listModels());

  server.post<{ Body: RealDshCanaryRequest; Reply: RealDshCanaryReport | DomainErrorResponse }>(
    "/api/canaries",
    async (request, reply) => {
      const preflight = options.canaryPreflight;
      if (!preflight) {
        return reply.code(409).send({ error: { code: "RUNTIME_STATE_INVALID", message: "正式运行未配置金丝雀前置身份" } });
      }
      if (preflight.executionKind !== "real-provider" && preflight.allowDeterministicTestRun !== true) {
        return reply.code(409).send({ error: { code: "RUNTIME_STATE_INVALID", message: "正式金丝雀拒绝 deterministic-fixture 或 Fake Harness" } });
      }
      if (!options.backupManager) {
        return reply.code(409).send({ error: { code: "RUNTIME_STATE_INVALID", message: "正式金丝雀必须配置一致性备份管理器" } });
      }
      if (request.body?.operatorConfirmed !== true) {
        return reply.code(400).send({ error: { code: "RUNTIME_STATE_INVALID", message: "真实金丝雀必须由操作员显式确认" } });
      }
      if (!Number.isSafeInteger(request.body.tokenLimit) || request.body.tokenLimit < 1
        || request.body.tokenLimit > REAL_DSH_CANARY_MAX_TOKENS
        || !Number.isFinite(request.body.costLimit) || request.body.costLimit <= 0
        || request.body.costLimit > REAL_DSH_CANARY_MAX_COST
        || !Number.isSafeInteger(request.body.modelProfile?.totalTokenLimit)
        || request.body.modelProfile.totalTokenLimit * 2 > request.body.tokenLimit) {
        return reply.code(400).send({ error: { code: "EXPERIMENT_BUDGET_INVALID",
          message: `金丝雀上限为 ${REAL_DSH_CANARY_MAX_TOKENS} tokens 与 ${REAL_DSH_CANARY_MAX_COST} 成本单位，且双角色会话令牌上限之和不得超过总上限` } });
      }
      let experiment: Experiment | undefined;
      let canaryId: string | undefined;
      try {
        if (!validName(request.body.name)) throw new Error("金丝雀名称必须为 1 到 120 个非空字符");
        const modelProfile = validateModelProfile(request.body.modelProfile);
        if (experiments.list().some(({ status }) => status === "running")) throw new Error("当前 Arena 已有运行中的实验");
        const doctor = await preflight.serverDoctor();
        assertCanaryDoctorEvidence(doctor);
        canaryId = canaries.reserve({
          tokenLimit: request.body.tokenLimit,
          costLimit: request.body.costLimit,
          executionKind: preflight.executionKind,
          imageDigest: doctor.runtimeIdentity.imageDigest,
          backupId: doctor.completeBackup.backupId,
          backupCreatedAt: doctor.completeBackup.createdAt,
          doctorCheckedAt: doctor.checkedAt,
          runtimeIdentity: {
            harnessPackage: doctor.runtimeIdentity.harnessPackage,
            harnessVersion: doctor.runtimeIdentity.harnessVersion,
            modelCatalogRelease: doctor.runtimeIdentity.modelCatalogRelease,
            modelReleaseSha256: doctor.runtimeIdentity.modelReleaseSha256,
            imageDigest: doctor.runtimeIdentity.imageDigest,
            harnessRuntimePayloadSha256: doctor.runtimeIdentity.harnessRuntimePayloadSha256,
          },
        });
        if (experiments.list().some(({ status }) => status === "running")) throw new Error("当前 Arena 已有运行中的实验");
        experiment = experiments.create(request.body.name, modelProfile, request.body.costLimit);
        canaries.attachExperiment(canaryId, experiment.id);
        const validation = await controlPlane.runBaselineValidation(
          experiment.id,
          (options.baselineValidationAdapter ?? ((candidate) => createRealBaselineValidationAdapter({
            experiment: candidate, harnessAdapter, matchRunner, matches, lineage, pluginRoots,
          })))(experiment),
          { smokeProvider: true },
        );
        audits.append(experiment.id, validation.status === "passed" ? "baseline.passed" : "baseline.failed", { steps: validation.steps.length });
        if (validation.smoke.usage) {
          audits.append(experiment.id, "baseline.smoke", {
            outcome: validation.smoke.passed === true ? "succeeded" : "failed",
            usageTokens: validation.smoke.usage.tokens,
            usageCost: validation.smoke.usage.cost,
            usageModelCalls: validation.smoke.usage.modelCalls,
            failureKind: validation.smoke.failureKind,
          });
        }
        if (validation.smoke.usage) canaries.recordSmoke(canaryId, validation.smoke.passed === true, validation.smoke.usage);
        if (validation.status !== "passed" || validation.smoke.passed !== true) throw new Error("真实模型冒烟或基线验收未通过");
        const configuration: FrozenExperimentConfiguration = {
          modelProfile: modelProfile as unknown as Record<string, unknown>,
          tokenLimit: request.body.tokenLimit,
          costLimit: request.body.costLimit,
          rulesDigest: "maze-rules-v1",
          seedPolicyDigest: "seed-policy-v1",
          resourcePolicyDigest: options.resourcePolicyDigest ?? "unconfigured-resource-policy",
          scoringVersion: "lexicographic-v1",
          compatibilityFingerprint: options.compatibilityFingerprint ?? "maze-arena-v1",
          modelReleaseSha256: doctor.runtimeIdentity.modelReleaseSha256,
        };
        controlPlane.confirmBaseline(experiment.id, configuration);
        const champions = {
          generator: lineage.baselineCommit(experiment.id, "generator"),
          solver: lineage.baselineCommit(experiment.id, "solver"),
        };
        runtime.registerReady({
          experimentId: experiment.id,
          champions,
          tokenLimit: request.body.tokenLimit,
          costLimit: request.body.costLimit,
          compatibilityFingerprint: configuration.compatibilityFingerprint,
        });
        audits.append(experiment.id, "baseline.confirmed", { canaryId });
        options.backupManager.create("experiment-start");
        audits.append(experiment.id, "backup.created", { trigger: "experiment-start", canaryId });
        runtime.start(experiment.id);
        // 金丝雀只运行一代；先写安全暂停请求，运行器会在双角色结果原子提交后停下。
        runtime.requestPause(experiment.id);
        experiments.setStatus(experiment.id, "running");
        audits.append(experiment.id, "runtime.started", { canaryId, oneGeneration: true });
        autonomousRunner.launch(experiment.id);
        return reply.code(202).send(buildCanaryReport({
          row: canaries.get(canaryId)!, runtime, lineage, audits,
          frozenModelProfile: controlPlane.getBaselineValidation(experiment.id)?.frozenConfiguration?.modelProfile ?? null,
        }));
      } catch (error) {
        if (canaryId) canaries.failPreflight(canaryId, error instanceof Error ? error.message : "金丝雀前置检查失败");
        if (canaryId) {
          const row = canaries.get(canaryId)!;
          if (persistCanaryTerminalReport(row.experiment_id)) createCanaryTerminalBackup(row.experiment_id);
          const report = buildCanaryReport({
            row, runtime, lineage, audits,
            frozenModelProfile: controlPlane.getBaselineValidation(row.experiment_id)?.frozenConfiguration?.modelProfile ?? null,
          });
          return reply.code(409).send(report);
        }
        return reply.code(409).send({ error: { code: "RUNTIME_STATE_INVALID", message: error instanceof Error ? error.message : "金丝雀启动失败" } });
      }
    },
  );

  server.get<{ Params: { id: string }; Reply: RealDshCanaryReport | DomainErrorResponse }>(
    "/api/canaries/:id",
    async (request, reply) => {
      const row = canaries.get(request.params.id);
      if (!row) return reply.code(404).send({ error: { code: "RUNTIME_NOT_FOUND", message: "未找到金丝雀记录" } });
      const report = buildCanaryReport({
        row, runtime, lineage, audits,
        frozenModelProfile: controlPlane.getBaselineValidation(row.experiment_id)?.frozenConfiguration?.modelProfile ?? null,
      });
      return report;
    },
  );

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
        if (options.backupManager) {
          try { options.backupManager.create("experiment-start"); }
          catch (error) { throw new BackupBoundaryError(error); }
          audits.append(request.params.id, "backup.created", { trigger: "experiment-start", compatibilityRoute: true });
        }
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
        if (error instanceof BackupBoundaryError) {
          return reply.code(409).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: error.message } });
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
        setImmediate(() => {
          try { publishCommittedEvents(matchId); } catch { socket.close(1011, "比赛事件读取失败"); }
        });
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

function assertCanaryDoctorEvidence(value: Awaited<ReturnType<NonNullable<ArenaServerOptions["canaryPreflight"]>["serverDoctor"]>>): void {
  const checkedAt = new Date(value.checkedAt);
  const backupCreatedAt = new Date(value.completeBackup.createdAt);
  const identity = value.runtimeIdentity;
  if (checkedAt.toISOString() !== value.checkedAt || backupCreatedAt.toISOString() !== value.completeBackup.createdAt
    || backupCreatedAt.getTime() > checkedAt.getTime()
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(value.completeBackup.backupId)
    || identity.harnessPackage !== "@deepseek-ai/dsh" || !identity.harnessVersion || !identity.modelCatalogRelease
    || !isImmutableImageReference(identity.imageDigest)
    || !/^[0-9a-f]{64}$/.test(identity.harnessRuntimePayloadSha256)
    || !/^[0-9a-f]{64}$/.test(identity.modelReleaseSha256)
    || identity.modelCatalogRelease !== identity.modelReleaseSha256) {
    throw new Error("Server doctor 未返回绑定当前运行身份与最近完整备份的可信证据");
  }
}
