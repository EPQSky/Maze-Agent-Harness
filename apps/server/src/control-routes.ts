import type {
  BaselineValidationRecord,
  DomainErrorResponse,
  Experiment,
  ExperimentRuntimeSnapshot,
  FrozenExperimentConfiguration,
  ModelProfileInput,
  LineageHistoryResponse,
} from "@maze-arena/contracts";
import type { HarnessAdapter } from "@maze-arena/dsh-integration";
import {
  ControlPlaneRepository,
  ExperimentRuntimeRepository,
  type BaselineValidationAdapter,
} from "@maze-arena/control-plane";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import type { FastifyInstance } from "fastify";
import type { AuditRepository } from "./audit-repository.js";
import { ExperimentNotFoundError, type ExperimentRepository } from "./experiment-repository.js";
import type { AutonomousExperimentRunner } from "./autonomous-runner.js";

interface ControlRouteOptions {
  server: FastifyInstance;
  experiments: ExperimentRepository;
  audits: AuditRepository;
  controlPlane: ControlPlaneRepository;
  runtime: ExperimentRuntimeRepository;
  lineage: PluginLineageRepository;
  autonomousRunner: AutonomousExperimentRunner;
  harnessAdapter: HarnessAdapter;
  compatibilityFingerprint: string;
  baselineValidationAdapter: (experiment: Experiment) => BaselineValidationAdapter;
  startExhibition(input: {
    experimentId: string; seed: string; exhibitionId: string; generatorCommit: string; solverCommit: string;
  }): string;
  backupBoundary(trigger: "experiment-start" | "experiment-terminal", experimentId: string): void;
}

function parseCostLimit(value: unknown, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("成本上限必须为正有限数字或 null");
  return value;
}

export function registerControlRoutes(options: ControlRouteOptions): void {
  const { server, experiments, audits, controlPlane, runtime, lineage, harnessAdapter, autonomousRunner } = options;

  const requireExperiment = (id: string): Experiment => {
    const experiment = experiments.find(id);
    if (!experiment) throw new ExperimentNotFoundError(id);
    return experiment;
  };

  const discardIncompleteDerivedExperiment = (id: string): void => {
    for (const discard of [
      () => controlPlane.discardDerived(id),
      () => runtime.discardDerived(id),
      () => lineage.discardDerived(id),
      () => experiments.discardDraft(id),
    ]) {
      try { discard(); }
      catch (error) { server.log.error({ err: error, experimentId: id }, "派生实验补偿清理失败"); }
    }
  };

  server.get<{ Params: { id: string }; Reply: LineageHistoryResponse | DomainErrorResponse }>(
    "/api/experiments/:id/lineages",
    async (request, reply) => {
      try {
        requireExperiment(request.params.id);
        return {
          generator: lineage.listHistory(request.params.id, "generator"),
          solver: lineage.listHistory(request.params.id, "solver"),
        };
      } catch (error) {
        return reply.code(error instanceof ExperimentNotFoundError ? 404 : 409).send({
          error: { code: error instanceof ExperimentNotFoundError ? "EXPERIMENT_NOT_FOUND" : "RUNTIME_STATE_INVALID",
            message: error instanceof Error ? error.message : "谱系读取失败" },
        });
      }
    },
  );

  server.get<{ Params: { id: string }; Reply: BaselineValidationRecord | DomainErrorResponse }>(
    "/api/experiments/:id/baseline-validation",
    async (request, reply) => {
      if (!experiments.find(request.params.id)) {
        return reply.code(404).send({ error: { code: "EXPERIMENT_NOT_FOUND", message: "未找到指定实验" } });
      }
      return controlPlane.getBaselineValidation(request.params.id) ?? {
        experimentId: request.params.id,
        status: "pending",
        steps: [],
        operatorConfirmed: false,
        frozenConfiguration: null,
        frozenDigest: null,
        smoke: { attempted: false, passed: null },
      };
    },
  );

  server.post<{ Params: { id: string }; Body: { smokeProvider?: boolean }; Reply: BaselineValidationRecord | DomainErrorResponse }>(
    "/api/experiments/:id/baseline-validation/run",
    async (request, reply) => {
      try {
        const experiment = requireExperiment(request.params.id);
        if (experiment.status !== "draft") {
          return reply.code(409).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: "仅草稿实验可以执行基线验收" } });
        }
        if (runtime.get(experiment.id) || controlPlane.getBaselineValidation(experiment.id)?.status === "ready") {
          return reply.code(409).send({ error: { code: "INVALID_EXPERIMENT_STATE", message: "已确认基线的实验不能重复执行验收" } });
        }
        const adapter = options.baselineValidationAdapter(experiment);
        const record = await controlPlane.runBaselineValidation(experiment.id, adapter, {
          smokeProvider: request.body?.smokeProvider === true,
        });
        audits.append(experiment.id, record.status === "passed" ? "baseline.passed" : "baseline.failed", { steps: record.steps.length });
        return record;
      } catch (error) {
        if (error instanceof ExperimentNotFoundError) {
          return reply.code(404).send({ error: { code: "EXPERIMENT_NOT_FOUND", message: error.message } });
        }
        throw error;
      }
    },
  );

  server.post<{ Params: { id: string }; Body: Partial<FrozenExperimentConfiguration>; Reply: BaselineValidationRecord | DomainErrorResponse }>(
    "/api/experiments/:id/baseline-validation/confirm",
    async (request, reply) => {
      try {
        const experiment = requireExperiment(request.params.id);
        if (!experiment.modelProfile) throw new Error("模型配置档缺失");
        const configuration: FrozenExperimentConfiguration = {
          modelProfile: experiment.modelProfile as unknown as Record<string, unknown>,
          tokenLimit: experiment.modelProfile.totalTokenLimit,
          costLimit: experiment.costLimit,
          rulesDigest: request.body?.rulesDigest ?? "maze-rules-v1",
          seedPolicyDigest: request.body?.seedPolicyDigest ?? "seed-policy-v1",
          resourcePolicyDigest: request.body?.resourcePolicyDigest ?? "isolated-profile-v1",
          scoringVersion: request.body?.scoringVersion ?? "lexicographic-v1",
          compatibilityFingerprint: options.compatibilityFingerprint,
        };
        const champions = {
          generator: lineage.baselineCommit(experiment.id, "generator"),
          solver: lineage.baselineCommit(experiment.id, "solver"),
        };
        const record = controlPlane.confirmBaseline(experiment.id, configuration);
        if (!runtime.get(experiment.id)) {
          try {
            runtime.registerReady({
              experimentId: experiment.id,
              champions,
              tokenLimit: experiment.modelProfile.totalTokenLimit,
              costLimit: experiment.costLimit ?? undefined,
              compatibilityFingerprint: configuration.compatibilityFingerprint,
            });
          } catch (error) {
            // 跨仓储注册失败时恢复为“验收通过、等待确认”，避免出现无运行时的伪就绪状态。
            controlPlane.rollbackBaselineConfirmation(experiment.id);
            throw error;
          }
        }
        audits.append(experiment.id, "baseline.confirmed", { frozenDigest: record.frozenDigest });
        return record;
      } catch (error) {
        return reply.code(error instanceof ExperimentNotFoundError ? 404 : 409).send({
          error: {
            code: error instanceof ExperimentNotFoundError ? "EXPERIMENT_NOT_FOUND" : "BASELINE_NOT_READY",
            message: error instanceof Error ? error.message : "基线确认失败",
          },
        });
      }
    },
  );

  server.get<{ Params: { id: string }; Reply: ExperimentRuntimeSnapshot | DomainErrorResponse }>(
    "/api/experiments/:id/runtime",
    async (request, reply) => runtime.get(request.params.id)
      ?? reply.code(404).send({ error: { code: "RUNTIME_NOT_FOUND", message: "实验尚未完成基线确认" } }),
  );

  for (const [path, action, auditType] of [
    ["start", (id: string) => runtime.start(id), "runtime.started"],
    ["pause", (id: string) => runtime.requestPause(id), "runtime.paused"],
    ["resume", (id: string) => runtime.start(id), "runtime.started"],
    ["cancel", (id: string) => runtime.cancel(id), "runtime.cancelled"],
  ] as const) {
    server.post<{ Params: { id: string }; Reply: ExperimentRuntimeSnapshot | DomainErrorResponse }>(
      `/api/experiments/:id/runtime/${path}`,
      async (request, reply) => {
        try {
          if ((path === "start" || path === "resume")
            && experiments.list().some((experiment) => experiment.id !== request.params.id && experiment.status === "running")) {
            throw new Error("当前 Arena 已有运行中的实验");
          }
          if (path === "start" || path === "resume") {
            controlPlane.requireReady(request.params.id, options.compatibilityFingerprint);
            options.backupBoundary("experiment-start", request.params.id);
          }
          let snapshot = action(request.params.id);
          const status = snapshot.state === "ready" ? "draft" : snapshot.state;
          experiments.setStatus(request.params.id, status);
          audits.append(request.params.id, auditType);
          if (path === "start" || path === "resume") autonomousRunner.launch(request.params.id);
          if (path === "pause") snapshot = await autonomousRunner.pause(request.params.id);
          if (path === "cancel") {
            await autonomousRunner.cancel(request.params.id);
            options.backupBoundary("experiment-terminal", request.params.id);
          }
          return snapshot;
        } catch (error) {
          return reply.code(409).send({ error: { code: "RUNTIME_STATE_INVALID", message: error instanceof Error ? error.message : "运行状态非法" } });
        }
      },
    );
  }

  server.post<{ Params: { id: string }; Body: { name: string; modelProfile: ModelProfileInput; costLimit?: number | null }; Reply: ExperimentRuntimeSnapshot | DomainErrorResponse }>(
    "/api/experiments/:id/comparison-clones",
    async (request, reply) => {
      let child: Experiment | undefined;
      try {
        const source = runtime.get(request.params.id);
        if (!source) throw new Error("源实验尚未就绪");
        const profile = harnessAdapter.validateModelProfile(request.body.modelProfile);
        child = experiments.create(request.body.name, profile, parseCostLimit(request.body.costLimit, source.budget.costLimit));
        const baselines = {
          generator: lineage.baselineCommit(request.params.id, "generator"),
          solver: lineage.baselineCommit(request.params.id, "solver"),
        };
        const champions = {
          generator: lineage.branchFrom(request.params.id, child.id, "generator", baselines.generator),
          solver: lineage.branchFrom(request.params.id, child.id, "solver", baselines.solver),
        };
        const budget = { tokenLimit: profile.totalTokenLimit, costLimit: child.costLimit };
        const snapshot = runtime.cloneComparison(request.params.id, child.id, source.compatibilityFingerprint, budget, champions);
        controlPlane.deriveReady(request.params.id, child.id, {
          modelProfile: profile as unknown as Record<string, unknown>, ...budget,
        });
        audits.append(child.id, "baseline.confirmed", { relation: "comparison-clone", parentId: request.params.id });
        return snapshot;
      }
      catch (error) {
        if (child) discardIncompleteDerivedExperiment(child.id);
        return reply.code(409).send({ error: { code: "CLONE_FAILED", message: error instanceof Error ? error.message : "克隆失败" } });
      }
    },
  );

  server.post<{ Params: { id: string }; Body: {
    name: string; modelProfile: ModelProfileInput; compatibilityFingerprint?: string;
    generatorCommit?: string; solverCommit?: string; costLimit?: number | null;
  }; Reply: ExperimentRuntimeSnapshot | DomainErrorResponse }>(
    "/api/experiments/:id/continuation-forks",
    async (request, reply) => {
      let child: Experiment | undefined;
      try {
        const source = runtime.get(request.params.id);
        if (!source) throw new Error("源实验尚未就绪");
        const profile = harnessAdapter.validateModelProfile(request.body.modelProfile);
        child = experiments.create(request.body.name, profile, parseCostLimit(request.body.costLimit, source.budget.costLimit));
        const fingerprint = request.body.compatibilityFingerprint ?? source.compatibilityFingerprint;
        const selected = {
          generator: request.body.generatorCommit ?? source.champions.generator,
          solver: request.body.solverCommit ?? source.champions.solver,
        };
        if (!runtime.isRetainedChampion(request.params.id, "generator", selected.generator)
          || !runtime.isRetainedChampion(request.params.id, "solver", selected.solver)) {
          throw new Error("延续分支只能从源实验保留的历史冠军版本开始");
        }
        const champions = {
          generator: lineage.branchFrom(request.params.id, child.id, "generator", selected.generator),
          solver: lineage.branchFrom(request.params.id, child.id, "solver", selected.solver),
        };
        const budget = { tokenLimit: profile.totalTokenLimit, costLimit: child.costLimit };
        const snapshot = runtime.forkContinuation(request.params.id, child.id, fingerprint, champions, budget);
        controlPlane.deriveReady(request.params.id, child.id, {
          modelProfile: profile as unknown as Record<string, unknown>, compatibilityFingerprint: fingerprint, ...budget,
        });
        audits.append(child.id, "baseline.confirmed", { relation: "continuation-fork", parentId: request.params.id });
        return snapshot;
      }
      catch (error) {
        if (child) discardIncompleteDerivedExperiment(child.id);
        return reply.code(409).send({ error: { code: "FORK_FAILED", message: error instanceof Error ? error.message : "分支失败" } });
      }
    },
  );

  server.post<{ Params: { id: string }; Reply: ExperimentRuntimeSnapshot[] | DomainErrorResponse }>(
    "/api/experiments/:id/seal-group/unseal",
    async (request, reply) => {
      try { return runtime.unsealGroup(request.params.id); }
      catch (error) { return reply.code(409).send({ error: { code: "UNSEAL_FAILED", message: error instanceof Error ? error.message : "解封失败" } }); }
    },
  );

  server.post<{ Params: { id: string }; Body: { generatorCommit: string; solverCommit: string; publicSeed: string }; Reply: { matchId: string } | DomainErrorResponse }>(
    "/api/experiments/:id/exhibitions",
    async (request, reply) => {
      let exhibitionId: string | undefined;
      try {
        if (!lineage.contains(request.params.id, "generator", request.body.generatorCommit)
          || !lineage.contains(request.params.id, "solver", request.body.solverCommit)) {
          throw new Error("展示局只能引用该实验 Git 谱系中保留的 Generator 与 Solver 版本");
        }
        exhibitionId = runtime.createExhibition({ experimentId: request.params.id, ...request.body });
        const matchId = options.startExhibition({
          experimentId: request.params.id,
          seed: request.body.publicSeed,
          exhibitionId,
          generatorCommit: request.body.generatorCommit,
          solverCommit: request.body.solverCommit,
        });
        audits.append(request.params.id, "exhibition.started", { exhibitionId, matchId });
        return reply.code(202).send({ matchId });
      } catch (error) {
        if (exhibitionId) runtime.discardExhibition(exhibitionId);
        return reply.code(400).send({ error: { code: "EXHIBITION_INVALID", message: error instanceof Error ? error.message : "展示局非法" } });
      }
    },
  );
}
