import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { EvolutionRole, RealDshCanaryReport, RealDshCanaryRequest } from "@maze-arena/contracts";
import { DeterministicFakeHarnessAdapter, ExportedHarnessConfigAdapter } from "@maze-arena/dsh-integration";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import { describe, expect, it, vi } from "vitest";
import { createArenaServer } from "./app.js";
import { AuditRepository } from "./audit-repository.js";
import type { AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import { CanaryAcceptanceRepository } from "./canary-acceptance.js";
import { ExperimentRepository } from "./experiment-repository.js";
import { isImmutableImageReference } from "./immutable-image-reference.js";
import { HarnessInvocationError } from "./harness-invocation-error.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginRoots = {
  generator: join(workspaceRoot, "packages/generator-plugin"),
  solver: join(workspaceRoot, "packages/solver-plugin"),
};
const requestBody: RealDshCanaryRequest = {
  name: "受监督真实 DSH 金丝雀",
  modelProfile: {
    providerId: "fake-basic",
    modelId: "compact-v1",
    credentialRef: "dsh-credential://BASIC_CRED",
    contextTokens: 2_000,
    outputTokens: 500,
    totalTokenLimit: 2_500,
  },
  tokenLimit: 5_000,
  costLimit: 0.5,
  operatorConfirmed: true,
};
const doctorEvidence = () => ({
  checkedAt: "2026-09-05T08:00:00.000Z",
  runtimeIdentity: {
    harnessPackage: "@deepseek-ai/dsh",
    harnessVersion: "2026.09.2",
    modelCatalogRelease: "a".repeat(64),
    modelReleaseSha256: "a".repeat(64),
    imageDigest: `sha256:${"b".repeat(64)}`,
    harnessRuntimePayloadSha256: "c".repeat(64),
  },
  completeBackup: { backupId: "backup-complete-test", createdAt: "2026-09-05T07:59:00.000Z" },
});
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function waitForReport(server: ReturnType<typeof createArenaServer>, canaryId: string): Promise<RealDshCanaryReport> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await server.inject({ method: "GET", url: `/api/canaries/${canaryId}` });
    const report = response.json<RealDshCanaryReport>();
    if (report.status !== "running") return report;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("等待金丝雀报告超时");
}

describe("真实 DSH 金丝雀正式验收边界", () => {
  it("旧审计表先迁移幂等列再创建唯一索引", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-audit-migration-"));
    const databasePath = join(root, "arena.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE experiment_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL, details_json TEXT NOT NULL
    )`);
    database.close();
    const audits = new AuditRepository(databasePath);
    expect(audits.appendOnce("legacy-batch", "exp", "harness.activity", { outcome: "succeeded" }))
      .toMatchObject({ experimentId: "exp", type: "harness.activity" });
    expect(audits.appendOnce("legacy-batch", "exp", "harness.activity", { outcome: "succeeded" }).id).toBe(1);
    audits.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("Server 精确限制正式金丝雀总令牌、成本与双角色会话预算", async () => {
    const serverDoctor = vi.fn(async () => ({
      ...doctorEvidence(),
      runtimeIdentity: { ...doctorEvidence().runtimeIdentity, imageDigest: "invalid-after-budget-check" },
    }));
    const server = createArenaServer({
      databasePath: ":memory:",
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      backupManager: { create: () => undefined },
      canaryPreflight: { executionKind: "real-provider", serverDoctor },
    });
    try {
      for (const [tokenLimit, costLimit] of [[20_000, 0.5], [640_000, 5]] as const) {
        const accepted = await server.inject({
          method: "POST", url: "/api/canaries", payload: {
            ...requestBody, tokenLimit, costLimit,
            modelProfile: { ...requestBody.modelProfile, totalTokenLimit: 5_000 },
          },
        });
        expect(accepted.statusCode).toBe(409);
        expect(accepted.body).toContain("Server doctor 未返回绑定当前运行身份与最近完整备份的可信证据");
      }
      expect(serverDoctor).toHaveBeenCalledTimes(2);

      for (const payload of [
        { ...requestBody, tokenLimit: 640_001 },
        { ...requestBody, tokenLimit: 640_000, costLimit: 5.01 },
        { ...requestBody, tokenLimit: 640_000, modelProfile: { ...requestBody.modelProfile, totalTokenLimit: 320_001 } },
      ]) {
        const rejected = await server.inject({ method: "POST", url: "/api/canaries", payload });
        expect(rejected.statusCode, rejected.body).toBe(400);
        expect(rejected.body).toContain("金丝雀上限为 640000 tokens 与 5 成本单位");
      }
      expect(serverDoctor).toHaveBeenCalledTimes(2);
    } finally { await server.close(); }
  });

  it("协议前崩溃的 settled actual 与重试成功用量共同持久入账，后续上界按剩余金丝雀预算拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-provider-drain-"));
    const databasePath = join(root, "arena.sqlite");
    const lineageRoot = join(root, "lineages");
    const exportPath = join(root, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.09.2",
      credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
      providers: [{
        id: "provider",
        label: "Provider",
        models: [{
          id: "model",
          label: "Model",
          capabilities: {
            reasoningEfforts: [],
            maxContextTokens: 256_000,
            maxOutputTokens: 64_000,
            maxTotalTokens: 320_000,
            providerOptions: {},
          },
        }],
      }],
    }));
    const catalog = ExportedHarnessConfigAdapter.fromFile(exportPath, "2026.09.2");
    let providerCalls = 0;
    const harness = {
      listModels: () => catalog.listModels(),
      validateModelProfile: (input: Parameters<typeof catalog.validateModelProfile>[0]) => catalog.validateModelProfile(input),
      smokeModel: async () => ({ providerText: "ready", usage: { tokens: 0, cost: 0, modelCalls: 0 } }),
      evolvePlugin: async (request: import("@maze-arena/dsh-integration").HarnessEvolutionRequest) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          const reservationId = request.budgetLedger!.reserveProviderAttempt({ tokens: 200_000, cost: 2 });
          request.budgetLedger!.settleProviderAttempt(reservationId, { tokens: 100_000, cost: 1 });
          throw new HarnessInvocationError("协议输出前崩溃", "transient-provider", undefined, {
            kind: "real-provider", protocolVersion: 1, sessionId: request.sessionId, harnessVersion: "2026.09.2",
            providerId: "provider", modelId: "model",
          }, "PROCESS_RESPONSE_JSON_INVALID");
        }
        if (providerCalls === 2) {
          const reservationId = request.budgetLedger!.reserveProviderAttempt({ tokens: 100_000, cost: 1 });
          request.budgetLedger!.settleProviderAttempt(reservationId, { tokens: 40_000, cost: 0.4 });
          return {
            hypothesis: "重试后正常关闭", strategyPlan: "不提交候选", submitted: false,
            usage: { tokens: 40_000, cost: 0.4, modelCalls: 1 },
            execution: {
              kind: "real-provider" as const, protocolVersion: 1 as const, sessionId: request.sessionId,
              harnessVersion: "2026.09.2", providerId: "provider", modelId: "model",
            },
          };
        }
        request.budgetLedger!.reserveProviderAttempt({ tokens: 600_000, cost: 4.6 });
        throw new Error("预算门禁错误地允许了第三次 Provider attempt");
      },
    };
    const server = createArenaServer({
      databasePath,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("未提交候选不得进入比赛"); } },
      pluginRoots,
      candidateTestRunner: { run: () => undefined },
      pairedEvaluationRunner: { evaluate: async () => { throw new Error("未提交候选不得进入评测"); } },
      baselineValidationAdapter: (experiment) => ({
        async runStep(step) {
          if (step === "native-plugin-install") {
            const lineage = new PluginLineageRepository(lineageRoot, databasePath);
            try {
              await lineage.initialize(experiment.id, "generator", pluginRoots.generator);
              await lineage.initialize(experiment.id, "solver", pluginRoots.solver);
            } finally { lineage.close(); }
          }
          return { step, passed: true, diagnostics: [] };
        },
        smokeProvider: () => ({ passed: true, providerText: "ready", usage: { tokens: 0, cost: 0, modelCalls: 0 } }),
      }),
      backupManager: { create: () => undefined },
      canaryPreflight: { executionKind: "real-provider", serverDoctor: async () => doctorEvidence() },
    });
    try {
      const started = await server.inject({
        method: "POST",
        url: "/api/canaries",
        payload: {
          ...requestBody,
          tokenLimit: 640_000,
          costLimit: 5,
          modelProfile: {
            providerId: "provider", modelId: "model", credentialRef: "dsh-credential://PRODUCTION_CRED",
            contextTokens: 256_000, outputTokens: 64_000, totalTokenLimit: 320_000,
          },
        },
      });
      expect(started.statusCode, started.body).toBe(202);
      const initial = started.json<RealDshCanaryReport>();
      let runtime = (await server.inject({ method: "GET", url: `/api/experiments/${initial.experimentId}/runtime` }))
        .json<import("@maze-arena/contracts").ExperimentRuntimeSnapshot>();
      for (let attempt = 0; attempt < 500 && runtime.state === "running"; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        runtime = (await server.inject({ method: "GET", url: `/api/experiments/${initial.experimentId}/runtime` })).json();
      }
      expect(providerCalls).toBe(3);
      expect(runtime).toMatchObject({ state: "paused", usage: { tokens: 140_000, cost: 1.4, modelCalls: 2 } });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare(`SELECT tokens_consumed, cost_consumed, model_calls_consumed
          FROM real_dsh_canaries WHERE canary_id = ?`).get(initial.canaryId)).toEqual({
          tokens_consumed: 140_000, cost_consumed: 1.4, model_calls_consumed: 2,
        });
        expect(database.prepare(`SELECT tokens, cost, model_calls FROM generation_role_checkpoints
          WHERE experiment_id = ? AND generation = 1 AND role = 'generator'`).get(initial.experimentId)).toEqual({
          tokens: 140_000, cost: 1.4, model_calls: 2,
        });
        expect(database.prepare(`SELECT COUNT(*) AS count FROM generation_role_provider_attempts
          WHERE experiment_id = ?`).get(initial.experimentId)).toEqual({ count: 0 });
      } finally { database.close(); }
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    `sha256:${"a".repeat(64)}`,
    `maze-match@sha256:${"a".repeat(64)}`,
    `foo--bar/foo__bar@sha256:${"a".repeat(64)}`,
    `localhost:5000/maze/match-profile@sha256:${"a".repeat(64)}`,
    `[2001:db8::1]:5000/maze/match-profile@sha256:${"a".repeat(64)}`,
    `${"a".repeat(247)}@sha256:${"a".repeat(64)}`,
    `docker.io/${"a".repeat(247)}@sha256:${"a".repeat(64)}`,
    `index.docker.io/${"a".repeat(247)}@sha256:${"a".repeat(64)}`,
    `registry-1.docker.io/${"a".repeat(248)}@sha256:${"a".repeat(64)}`,
    `aa/${"a".repeat(252)}@sha256:${"a".repeat(64)}`,
    `x.io/${"a".repeat(255)}@sha256:${"a".repeat(64)}`,
  ])("接受不可变 Docker 镜像身份 %s", (reference) => {
    expect(isImmutableImageReference(reference)).toBe(true);
  });

  it.each([
    "latest",
    "maze-match:latest",
    `maze-match:latest@sha256:${"a".repeat(64)}`,
    `maze-match:1.2.3@sha256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"A".repeat(64)}`,
    `maze-match@sha256:${"A".repeat(64)}`,
    `foo___bar@sha256:${"a".repeat(64)}`,
    `[2001:db8::zz]:5000/maze@sha256:${"a".repeat(64)}`,
    `${"a".repeat(248)}@sha256:${"a".repeat(64)}`,
    `docker.io/${"a".repeat(248)}@sha256:${"a".repeat(64)}`,
    `index.docker.io/${"a".repeat(248)}@sha256:${"a".repeat(64)}`,
    `aa/${"a".repeat(253)}@sha256:${"a".repeat(64)}`,
    `x.io/${"a".repeat(256)}@sha256:${"a".repeat(64)}`,
  ])("拒绝浮动或畸形 Docker 镜像身份 %s", (reference) => {
    expect(isImmutableImageReference(reference)).toBe(false);
  });

  it.each([
    "maze-match:latest",
    `maze-match:latest@sha256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
  ])("Server doctor 门禁拒绝非不可变镜像身份 %s", async (imageDigest) => {
    const baseline = vi.fn();
    const server = createArenaServer({
      databasePath: ":memory:",
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      baselineValidationAdapter: baseline,
      backupManager: { create: () => undefined },
      canaryPreflight: {
        executionKind: "real-provider",
        serverDoctor: async () => ({
          ...doctorEvidence(),
          runtimeIdentity: { ...doctorEvidence().runtimeIdentity, imageDigest },
        }),
      },
    });
    try {
      const response = await server.inject({ method: "POST", url: "/api/canaries", payload: requestBody });
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain("Server doctor 未返回绑定当前运行身份与最近完整备份的可信证据");
      expect(baseline).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("real-provider 证据严格绑定 attempt、Doctor Harness 与冻结模型身份", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-"));
    const databasePath = join(root, "arena.sqlite");
    const lineageRoot = join(root, "lineages");
    const createCandidateAdapter = (): AutonomousEvolutionAdapter => ({
      async runRole(input) {
        const lineage = new PluginLineageRepository(lineageRoot, databasePath);
        const audits = new AuditRepository(databasePath);
        const candidateRoot = join(root, `${input.attemptId}-candidate`);
        try {
          cpSync(pluginRoots[input.role], candidateRoot, {
            recursive: true,
            filter: (source) => !source.includes("node_modules") && !source.includes("/.git"),
          });
          const source = join(candidateRoot, "src/index.ts");
          writeFileSync(source, `${readFileSync(source, "utf8")}\n// 金丝雀确定性测试双 ${input.attemptId}\n`);
          const outcome = input.role === "generator" ? "promoted" as const : "tie" as const;
          const candidate = await lineage.commitCandidate({
            experimentId: input.experimentId,
            role: input.role,
            sourceRoot: candidateRoot,
            attemptId: input.attemptId,
            hypothesis: "确定性测试双模拟遵循生产协议的真实提供方结果",
            resultSummary: outcome,
            outcome,
            generation: outcome === "promoted" ? input.generation : undefined,
          });
          if (input.role === "generator") {
            const failedUsage = { tokens: 20, cost: 0.005, modelCalls: 1 };
            audits.append(input.experimentId, "harness.activity", {
              role: input.role,
              attemptId: input.attemptId,
              executionKind: "real-provider",
              protocolVersion: 1,
              sessionId: randomUUID(),
              harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
              providerId: requestBody.modelProfile.providerId,
              modelId: requestBody.modelProfile.modelId,
              outcome: "failed",
              failureKind: "transient-provider",
              usageTokens: failedUsage.tokens,
              usageCost: failedUsage.cost,
              usageModelCalls: failedUsage.modelCalls,
            });
            if (input.usageBudget?.consume(failedUsage) === false) throw new Error("测试双瞬态调用超出硬预算");
          }
          const sessionId = randomUUID();
          audits.append(input.experimentId, "harness.activity", {
            role: input.role,
            attemptId: input.attemptId,
            executionKind: "real-provider",
            protocolVersion: 1,
            sessionId,
            harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
            providerId: requestBody.modelProfile.providerId,
            modelId: requestBody.modelProfile.modelId,
            outcome: "succeeded",
            usageTokens: 100,
            usageCost: 0.01,
            usageModelCalls: 1,
          });
          if (input.role === "solver") {
            // 一个真实 Session 会覆盖多个模型回合；重复 Session 身份不应被报告层误判为复用。
            audits.append(input.experimentId, "harness.activity", {
              role: input.role,
              attemptId: input.attemptId,
              executionKind: "real-provider",
              protocolVersion: 1,
              sessionId,
              harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
              providerId: requestBody.modelProfile.providerId,
              modelId: requestBody.modelProfile.modelId,
              outcome: "failed",
              failureKind: "provider",
              failureCode: "TRANSIENT_RECORDED",
              usageTokens: null,
              usageCost: null,
              usageModelCalls: null,
            });
          }
          if (input.usageBudget?.consume({ tokens: 100, cost: 0.01, modelCalls: 1 }) === false) {
            throw new Error("测试双超出金丝雀硬预算");
          }
          const usage = input.role === "generator"
            ? { tokens: 120, cost: 0.015, modelCalls: 2 }
            : { tokens: 100, cost: 0.01, modelCalls: 1 };
          return {
            result: {
              candidateCommit: candidate.commit,
              championBefore: input.frozenChampions[input.role],
              championAfter: outcome === "promoted" ? candidate.commit : input.frozenChampions[input.role],
              outcome,
              promotionTag: candidate.promotionTag ?? null,
              publicProgress: 1,
              hiddenProgress: 1,
              aggregate: {},
              diffSummary: "src/index.ts changed",
              attemptId: input.attemptId,
              evidenceLevel: "real-provider",
              candidateStatus: "evaluated",
              trustedBuildSha256: "a".repeat(64),
              isolatedEvaluation: true,
            },
            usage,
          };
        } finally {
          audits.close();
          lineage.close();
          rmSync(candidateRoot, { recursive: true, force: true });
        }
      },
    });
    const server = createArenaServer({
      databasePath,
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("金丝雀测试不直接运行展示比赛"); } },
      pluginRoots,
      autonomousEvolutionAdapter: createCandidateAdapter(),
      baselineValidationAdapter: (experiment) => ({
        async runStep(step) {
          if (step === "native-plugin-install") {
            const lineage = new PluginLineageRepository(lineageRoot, databasePath);
            try {
              await lineage.initialize(experiment.id, "generator", pluginRoots.generator);
              await lineage.initialize(experiment.id, "solver", pluginRoots.solver);
            } finally { lineage.close(); }
          }
          return { step, passed: true, diagnostics: [] };
        },
        smokeProvider: () => ({ passed: true, providerText: "test-only", usage: { tokens: 5, cost: 0.001, modelCalls: 1 } }),
      }),
      backupManager: { create: () => undefined },
      canaryPreflight: {
        executionKind: "real-provider",
        serverDoctor: async () => doctorEvidence(),
      },
    });
    try {
      const responses = await Promise.all([
        server.inject({ method: "POST", url: "/api/canaries", payload: requestBody }),
        server.inject({ method: "POST", url: "/api/canaries", payload: { ...requestBody, name: "并发金丝雀" } }),
      ]);
      const started = responses.find(({ statusCode }) => statusCode === 202)!;
      const rejected = responses.find(({ statusCode }) => statusCode === 409)!;
      expect(started.statusCode, started.body).toBe(202);
      expect(rejected.body).toContain("已有活动中的真实金丝雀");
      let restarted;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        restarted = await server.inject({ method: "POST", url: "/api/canaries", payload: { ...requestBody, name: "无需 GET 释放后的金丝雀" } });
        if (restarted.statusCode === 202) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(restarted?.statusCode, restarted?.body).toBe(202);
      const report = await waitForReport(server, restarted!.json<RealDshCanaryReport>().canaryId);
      expect(report).toMatchObject({
        status: "closed",
        executionKind: "real-provider",
        limits: { tokens: 5_000, cost: 0.5 },
        preflight: {
          doctorPassed: true,
          doctorCheckedAt: doctorEvidence().checkedAt,
          modelSmokePassed: true,
          completeBackupId: "backup-complete-test",
          completeBackupCreatedAt: doctorEvidence().completeBackup.createdAt,
          runtimeIdentity: {
            harnessPackage: doctorEvidence().runtimeIdentity.harnessPackage,
            harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
            modelCatalogRelease: doctorEvidence().runtimeIdentity.modelCatalogRelease,
            harnessRuntimePayloadSha256: doctorEvidence().runtimeIdentity.harnessRuntimePayloadSha256,
          },
        },
        mechanismClosed: true,
        promoted: true,
        formalAcceptancePassed: true,
        roles: {
          generator: { outcome: "promoted", nextGenerationStart: expect.any(String), usage: { tokens: 120, cost: 0.015, modelCalls: 2 } },
          solver: { outcome: "tie", promotionTag: null, usage: { tokens: 100, cost: 0.01, modelCalls: 1 } },
        },
      });
      expect(report.roles.generator.candidateCommit).toBe(report.roles.generator.championAfter);
      expect(report.roles.generator.promotionTag).toMatch(/^promotion\//);
      expect(report.roles.solver.championAfter).toBe(report.roles.solver.championBefore);
      expect(report.roles.generator.diff).toContain("金丝雀确定性测试双");
      expect(report.roles.generator.sessionIds[0]).not.toBe(report.roles.solver.sessionIds[0]);
      expect(report.limits).toMatchObject({
        tokens: 5_000, cost: 0.5, modelCalls: 18,
        consumedTokens: 225, consumedModelCalls: 4, withinLimit: true, reconciled: true,
      });
      expect(report.limits.consumedCost).toBeCloseTo(0.026);
      expect(report.nonGuarantee).toContain("不保证模型持续产生更优算法");
      expect(report.reason).toContain("真实自进化机制已闭环");

      const terminalDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const persisted = terminalDatabase.prepare(`SELECT state, completed_at, terminal_report_json
          FROM real_dsh_canaries WHERE canary_id = ?`).get(report.canaryId) as {
            state: string; completed_at: string | null; terminal_report_json: string | null;
          };
        expect(persisted.state).toBe("closed");
        expect(persisted.completed_at).toEqual(report.completedAt);
        expect(JSON.parse(persisted.terminal_report_json!)).toEqual(report);
      } finally { terminalDatabase.close(); }

      const identityDrifts = [
        ["attemptId", "mismatched-attempt"],
        ["providerId", "mismatched-provider"],
        ["modelId", "mismatched-model"],
        ["harnessVersion", "mismatched-harness"],
      ] as const;
      for (const [field, value] of identityDrifts) {
        const audits = new AuditRepository(databasePath);
        let eventId: number;
        try {
          eventId = audits.append(report.experimentId, "harness.activity", {
            role: "solver", attemptId: "g0001-solver", executionKind: "real-provider",
            protocolVersion: 1, sessionId: randomUUID(),
            harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
            providerId: requestBody.modelProfile.providerId, modelId: requestBody.modelProfile.modelId,
            outcome: "failed", failureKind: "provider", failureCode: "AUTH", usageTokens: null, usageCost: null,
            [field]: value,
          }).id;
        } finally { audits.close(); }
        const identityMismatch = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
        expect(identityMismatch.roles.solver.executionIdentityVerified, field).toBe(false);
        expect(identityMismatch.mechanismClosed, field).toBe(false);
        expect(identityMismatch.formalAcceptancePassed, field).toBe(false);
        const auditDatabase = new DatabaseSync(databasePath);
        try {
          auditDatabase.prepare("DELETE FROM experiment_audit_events WHERE id = ?").run(eventId);
        } finally { auditDatabase.close(); }
        const restored = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
        expect(restored.formalAcceptancePassed, field).toBe(true);
      }

      const database = new DatabaseSync(databasePath);
      try {
        const candidate = database.prepare(`SELECT attempt_id, target_commit, hypothesis, result_summary, outcome, generation
          FROM candidate_results WHERE experiment_id = ? AND role = 'generator'`).get(report.experimentId) as Record<string, unknown>;
        for (const outcome of ["tie", "failed"] as const) {
          const metadata = canonicalJson({
            attemptId: candidate.attempt_id, commit: candidate.target_commit, hypothesis: candidate.hypothesis,
            resultSummary: candidate.result_summary, outcome, generation: null,
          });
          database.prepare(`UPDATE candidate_results SET outcome = ?, generation = NULL, metadata_digest = ?
            WHERE experiment_id = ? AND role = 'generator'`).run(outcome, sha256(metadata), report.experimentId);
          const tampered = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
          expect(tampered.roles.generator.gitIntegrityVerified).toBe(false);
        }
        const restoreMetadata = canonicalJson({
          attemptId: candidate.attempt_id, commit: candidate.target_commit, hypothesis: candidate.hypothesis,
          resultSummary: candidate.result_summary, outcome: "promoted", generation: 1,
        });
        database.prepare(`UPDATE candidate_results SET outcome = 'promoted', generation = 1, metadata_digest = ?
          WHERE experiment_id = ? AND role = 'generator'`).run(sha256(restoreMetadata), report.experimentId);

        const generationDriftMetadata = canonicalJson({
          attemptId: candidate.attempt_id, commit: candidate.target_commit, hypothesis: candidate.hypothesis,
          resultSummary: candidate.result_summary, outcome: "promoted", generation: 2,
        });
        database.prepare(`UPDATE candidate_results SET generation = 2, metadata_digest = ?
          WHERE experiment_id = ? AND role = 'generator'`).run(sha256(generationDriftMetadata), report.experimentId);
        const generationDrift = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
        expect(generationDrift.roles.generator.gitIntegrityVerified).toBe(false);
        database.prepare(`UPDATE candidate_results SET generation = 1, metadata_digest = ?
          WHERE experiment_id = ? AND role = 'generator'`).run(sha256(restoreMetadata), report.experimentId);

        const checkpoint = database.prepare(`SELECT attempt_id, result_json FROM generation_role_checkpoints
          WHERE experiment_id = ? AND role = 'generator' AND generation = 1`).get(report.experimentId) as
          { attempt_id: string; result_json: string };
        const driftedResult = { ...JSON.parse(checkpoint.result_json) as Record<string, unknown>, attemptId: "drifted-attempt" };
        database.prepare(`UPDATE generation_role_checkpoints SET attempt_id = 'drifted-attempt', result_json = ?
          WHERE experiment_id = ? AND role = 'generator' AND generation = 1`).run(JSON.stringify(driftedResult), report.experimentId);
        const attemptDrift = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
        expect(attemptDrift.roles.generator.gitIntegrityVerified).toBe(false);
        database.prepare(`UPDATE generation_role_checkpoints SET attempt_id = ?, result_json = ?
          WHERE experiment_id = ? AND role = 'generator' AND generation = 1`)
          .run(checkpoint.attempt_id, checkpoint.result_json, report.experimentId);
      } finally { database.close(); }

      execFileSync("git", ["-C", join(lineageRoot, report.experimentId, "solver"), "reset", "--hard", report.roles.solver.championBefore!]);
      const commitTampered = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
      expect(commitTampered.formalAcceptancePassed).toBe(false);
      expect(commitTampered.roles.solver.gitIntegrityVerified).toBe(false);

      execFileSync("git", ["-C", join(lineageRoot, report.experimentId, "generator"), "tag", "-d", report.roles.generator.promotionTag!]);
      const tagTampered = (await server.inject({ method: "GET", url: `/api/canaries/${report.canaryId}` })).json<RealDshCanaryReport>();
      expect(tagTampered.formalAcceptancePassed).toBe(false);
      expect(tagTampered.roles.generator.promotionVerified).toBe(false);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("Server 明确拒绝把 deterministic-fixture 当作正式金丝雀", async () => {
    const server = createArenaServer({
      databasePath: ":memory:",
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      canaryPreflight: {
        executionKind: "deterministic-fixture",
        serverDoctor: async () => doctorEvidence(),
      },
    });
    try {
      const response = await server.inject({ method: "POST", url: "/api/canaries", payload: requestBody });
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain("拒绝 deterministic-fixture 或 Fake Harness");
    } finally { await server.close(); }
  });

  it("Server doctor 失败发生在租约与模型冒烟之前且不会遗留活动租约", async () => {
    const serverDoctor = vi.fn(async () => { throw new Error("doctor-runtime-identity-drift"); });
    const baseline = vi.fn();
    const server = createArenaServer({
      databasePath: ":memory:",
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      baselineValidationAdapter: baseline,
      backupManager: { create: () => undefined },
      canaryPreflight: { executionKind: "real-provider", serverDoctor },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await server.inject({ method: "POST", url: "/api/canaries", payload: requestBody });
        expect(response.statusCode).toBe(409);
        expect(response.body).toContain("doctor-runtime-identity-drift");
        expect(response.body).not.toContain("已有活动中的真实金丝雀");
      }
      expect(serverDoctor).toHaveBeenCalledTimes(2);
      expect(baseline).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it("模型冒烟失败将安全分类写入正式金丝雀审计且不保存提供方原文", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-smoke-failure-"));
    const databasePath = join(root, "arena.sqlite");
    const sensitiveText = "provider-secret-diagnostic";
    const server = createArenaServer({
      databasePath,
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      baselineValidationAdapter: () => ({
        runStep: async (step) => ({ step, passed: true, diagnostics: [] }),
        smokeProvider: async () => ({
          passed: false,
          providerText: sensitiveText,
          usage: { tokens: 13, cost: 0.03, modelCalls: 1 },
          failureKind: "transient-provider",
        }),
      }),
      backupManager: { create: () => undefined },
      canaryPreflight: { executionKind: "real-provider", serverDoctor: async () => doctorEvidence() },
    });
    try {
      const response = await server.inject({ method: "POST", url: "/api/canaries", payload: requestBody });
      expect(response.statusCode).toBe(409);
      const report = response.json<RealDshCanaryReport>();
      const audits = new AuditRepository(databasePath);
      try {
        const smoke = audits.list(report.experimentId!).events.find(({ type }) => type === "baseline.smoke");
        expect(smoke?.details).toEqual({
          outcome: "failed",
          usageTokens: 13,
          usageCost: 0.03,
          usageModelCalls: 1,
          failureKind: "transient-provider",
        });
        expect(JSON.stringify(audits.list(report.experimentId!))).not.toContain(sensitiveText);
      } finally { audits.close(); }
      expect(readFileSync(databasePath, "utf8")).not.toContain(sensitiveText);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("重启恢复会主动释放既有终态金丝雀租约并允许新的 POST 进入基线", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-restart-"));
    const databasePath = join(root, "arena.sqlite");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, join(root, "harness"));
    const runtime = new ExperimentRuntimeRepository(databasePath);
    const canaries = new CanaryAcceptanceRepository(databasePath);
    try {
      const profile = harness.validateModelProfile(requestBody.modelProfile);
      const experiment = experiments.create("重启前金丝雀", profile, requestBody.costLimit);
      const canaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "deterministic-fixture",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experiment.id);
      runtime.registerReady({
        experimentId: experiment.id,
        champions: { generator: "g0", solver: "s0" },
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        compatibilityFingerprint: "maze-arena-v1",
      });
      runtime.start(experiment.id);
      runtime.recordInfrastructureFailure(experiment.id, "simulated-crash-before-lease-release");
      experiments.setStatus(experiment.id, "paused");
    } finally {
      canaries.close();
      runtime.close();
      experiments.close();
    }

    const baselineReached = vi.fn();
    const server = createArenaServer({
      databasePath,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      baselineValidationAdapter: () => ({
        runStep: async (step) => {
          baselineReached(step);
          return { step, passed: false, diagnostics: ["restart-proof"] };
        },
        smokeProvider: async () => ({ passed: false, providerText: "", usage: { tokens: 1, cost: 0, modelCalls: 1 } }),
      }),
      backupManager: { create: () => undefined },
      canaryPreflight: {
        executionKind: "deterministic-fixture",
        serverDoctor: async () => doctorEvidence(),
        allowDeterministicTestRun: true,
      },
    });
    try {
      const response = await server.inject({ method: "POST", url: "/api/canaries", payload: { ...requestBody, name: "重启后金丝雀" } });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("已有活动中的真实金丝雀");
      expect(response.json<RealDshCanaryReport>()).toMatchObject({
        status: "preflight-failed",
        preflight: {
          modelSmokePassed: false,
          modelSmokeUsage: { tokens: 1, cost: 0, modelCalls: 1 },
        },
        limits: {
          consumedTokens: 1,
          consumedCost: 0,
          consumedModelCalls: 1,
          withinLimit: true,
          reconciled: true,
        },
        formalAcceptancePassed: false,
      });
      const failedReport = response.json<RealDshCanaryReport>();
      const audits = new AuditRepository(databasePath);
      try {
        audits.append(failedReport.experimentId!, "harness.activity", {
          role: "generator", attemptId: "g0001-generator", executionKind: "real-provider",
          protocolVersion: 1, sessionId: randomUUID(), harnessVersion: doctorEvidence().runtimeIdentity.harnessVersion,
          providerId: requestBody.modelProfile.providerId, modelId: requestBody.modelProfile.modelId,
          outcome: "failed", failureKind: "protocol", failureCode: "RESULT_JSON_INVALID",
          usageTokens: 17, usageCost: 0.001, usageModelCalls: 1,
        });
      } finally { audits.close(); }
      const diagnosed = (await server.inject({ method: "GET", url: `/api/canaries/${failedReport.canaryId}` }))
        .json<RealDshCanaryReport>();
      expect(diagnosed.roles.generator.reason).toBe("Harness 调用失败：protocol/RESULT_JSON_INVALID");
      expect(baselineReached).toHaveBeenCalled();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("重启会补写已关闭但尚未持久化的金丝雀终态报告", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-unreported-"));
    const databasePath = join(root, "arena.sqlite");
    const harnessRoot = join(root, "harness");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, harnessRoot);
    const runtime = new ExperimentRuntimeRepository(databasePath);
    const canaries = new CanaryAcceptanceRepository(databasePath);
    let canaryId = "";
    try {
      const experiment = experiments.create("终态 runtime 缺报告", harness.validateModelProfile(requestBody.modelProfile), requestBody.costLimit);
      canaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experiment.id);
      runtime.registerReady({
        experimentId: experiment.id,
        champions: { generator: "g0", solver: "s0" },
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        compatibilityFingerprint: "maze-arena-v1",
      });
      runtime.start(experiment.id);
      runtime.recordInfrastructureFailure(experiment.id, "simulated-terminal-before-report");
      canaries.failPreflight(canaryId, "模拟报告写入前进程崩溃");
    } finally { canaries.close(); }
    runtime.close();
    experiments.close();

    const backupCreate = vi.fn();
    const server = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("报告恢复测试不应运行比赛"); } },
      backupManager: { create: backupCreate },
    });
    try {
      const recovered = new CanaryAcceptanceRepository(databasePath);
      try {
        expect(recovered.get(canaryId)).toMatchObject({
          state: "closed",
          completed_at: expect.any(String),
          terminal_report_json: expect.any(String),
        });
      } finally { recovered.close(); }
      expect(backupCreate).toHaveBeenCalledTimes(1);
      expect(backupCreate).toHaveBeenCalledWith("experiment-terminal");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("重启识别已有终态 runtime 的活动金丝雀并保留正常终态语义", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-terminal-runtime-"));
    const databasePath = join(root, "arena.sqlite");
    const harnessRoot = join(root, "harness");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, harnessRoot);
    const runtime = new ExperimentRuntimeRepository(databasePath);
    const canaries = new CanaryAcceptanceRepository(databasePath);
    let canaryId = "";
    try {
      const experiment = experiments.create("已有终态 runtime 的金丝雀", harness.validateModelProfile(requestBody.modelProfile), requestBody.costLimit);
      canaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experiment.id);
      runtime.registerReady({
        experimentId: experiment.id,
        champions: { generator: "g0", solver: "s0" },
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        compatibilityFingerprint: "maze-arena-v1",
      });
      runtime.start(experiment.id);
      runtime.recordInfrastructureFailure(experiment.id, "simulated-terminal-before-report");
      // 故意保留 active canary，模拟 runtime 已提交终态但终态回调尚未来得及关闭金丝雀。
    } finally {
      canaries.close();
      runtime.close();
      experiments.close();
    }

    const backupCreate = vi.fn();
    const server = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("终态 runtime 恢复测试不应运行比赛"); } },
      backupManager: { create: backupCreate },
    });
    try {
      const recovered = new CanaryAcceptanceRepository(databasePath);
      try {
        const row = recovered.get(canaryId);
        expect(row).toMatchObject({
          state: "closed",
          completed_at: expect.any(String),
          preflight_failure: null,
          terminal_report_json: expect.any(String),
        });
        const report = JSON.parse(row!.terminal_report_json!) as RealDshCanaryReport;
        expect(report.status).toBe("failed");
        expect(report.reason).not.toContain("重启时未发现可恢复的运行时");
      } finally { recovered.close(); }
      expect(backupCreate).toHaveBeenCalledTimes(1);
      expect(backupCreate).toHaveBeenCalledWith("experiment-terminal");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("终态备份失败后重启会依据持久化成功事实重试且成功后不再重复", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-backup-retry-"));
    const databasePath = join(root, "arena.sqlite");
    const harnessRoot = join(root, "harness");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, harnessRoot);
    const canaries = new CanaryAcceptanceRepository(databasePath);
    let canaryId = "";
    let experimentId = "";
    try {
      const experiment = experiments.create("终态备份重试金丝雀", harness.validateModelProfile(requestBody.modelProfile), requestBody.costLimit);
      experimentId = experiment.id;
      canaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experiment.id);
      canaries.failPreflight(canaryId, "模拟终态备份前关闭");
    } finally {
      canaries.close();
      experiments.close();
    }

    const firstBackup = vi.fn(() => { throw new Error("simulated-terminal-backup-failure"); });
    const firstServer = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("终态备份失败测试不应运行比赛"); } },
      backupManager: { create: firstBackup },
    });
    try {
      expect(firstBackup).toHaveBeenCalledTimes(1);
      const persisted = new CanaryAcceptanceRepository(databasePath);
      try { expect(persisted.get(canaryId)?.terminal_report_json).toEqual(expect.any(String)); }
      finally { persisted.close(); }
    } finally { await firstServer.close(); }

    const secondBackup = vi.fn();
    const secondServer = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("终态备份重试测试不应运行比赛"); } },
      backupManager: { create: secondBackup },
    });
    try {
      expect(secondBackup).toHaveBeenCalledTimes(1);
      expect(secondBackup).toHaveBeenCalledWith("experiment-terminal");
    } finally { await secondServer.close(); }

    const thirdBackup = vi.fn();
    const thirdServer = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("终态备份成功事实测试不应运行比赛"); } },
      backupManager: { create: thirdBackup },
    });
    try {
      expect(thirdBackup).not.toHaveBeenCalled();
      const audits = new AuditRepository(databasePath);
      try {
        const events = audits.list(experimentId).events;
        expect(events.filter(({ type, details }) => type === "backup.created" && details.trigger === "experiment-terminal")).toHaveLength(1);
      } finally { audits.close(); }
    } finally {
      await thirdServer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("终态报告写入失败时不创建缺证据的终态备份", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-report-write-failure-"));
    const databasePath = join(root, "arena.sqlite");
    const canaries = new CanaryAcceptanceRepository(databasePath);
    let canaryId = "";
    try {
      canaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, "report-write-failure");
      canaries.failPreflight(canaryId, "模拟报告写入前进程崩溃");
    } finally { canaries.close(); }

    const persist = vi.spyOn(CanaryAcceptanceRepository.prototype, "persistTerminalReport")
      .mockImplementation(() => { throw new Error("simulated-terminal-report-write-failure"); });
    const backupCreate = vi.fn();
    const server = createArenaServer({
      databasePath,
      harnessAdapter: new DeterministicFakeHarnessAdapter(),
      matchRunner: { run: async () => { throw new Error("报告失败测试不应运行比赛"); } },
      backupManager: { create: backupCreate },
    });
    try {
      expect(backupCreate).not.toHaveBeenCalled();
      const persisted = new CanaryAcceptanceRepository(databasePath);
      try { expect(persisted.get(canaryId)?.terminal_report_json).toBeNull(); }
      finally { persisted.close(); }
    } finally {
      persist.mockRestore();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("重启收敛未注册运行时的孤儿金丝雀并允许下一次 POST 进入", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-orphan-"));
    const databasePath = join(root, "arena.sqlite");
    const harnessRoot = join(root, "harness");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, harnessRoot);
    const canaries = new CanaryAcceptanceRepository(databasePath);
    let orphanCanaryId = "";
    try {
      const profile = harness.validateModelProfile(requestBody.modelProfile);
      const experiment = experiments.create("attach 后崩溃的金丝雀", profile, requestBody.costLimit);
      orphanCanaryId = canaries.reserve({
        tokenLimit: requestBody.tokenLimit,
        costLimit: requestBody.costLimit,
        executionKind: "deterministic-fixture",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(orphanCanaryId, experiment.id);
      // 故意不创建 ExperimentRuntimeRepository 记录，模拟 registerReady 前的进程崩溃。
    } finally {
      canaries.close();
      experiments.close();
    }

    const server = createArenaServer({
      databasePath,
      harnessRoot,
      harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("孤儿回收测试不应运行比赛"); } },
      baselineValidationAdapter: () => ({
        runStep: async (step) => ({ step, passed: false, diagnostics: ["restart-orphan-proof"] }),
        smokeProvider: async () => ({ passed: true, providerText: "test-only", usage: { tokens: 1, cost: 0, modelCalls: 1 } }),
      }),
      backupManager: { create: () => undefined },
      canaryPreflight: {
        executionKind: "deterministic-fixture",
        allowDeterministicTestRun: true,
        serverDoctor: async () => doctorEvidence(),
      },
    });
    try {
      const recovered = new CanaryAcceptanceRepository(databasePath);
      try {
        expect(recovered.get(orphanCanaryId)).toMatchObject({
          state: "closed",
          completed_at: expect.any(String),
          preflight_failure: "金丝雀启动流程中断，重启时未发现可恢复的运行时",
          terminal_report_json: expect.any(String),
        });
      } finally { recovered.close(); }
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) AS count FROM real_dsh_canary_lease").get()).toEqual({ count: 0 });
      } finally { database.close(); }

      const response = await server.inject({
        method: "POST", url: "/api/canaries", payload: { ...requestBody, name: "孤儿回收后新金丝雀" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("已有活动中的真实金丝雀");
      expect(response.body).toContain("真实模型冒烟或基线验收未通过");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Provider usage batch 跨三个崩溃点恰好结算一次模型、金丝雀、审计与运行时", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-provider-usage-recovery-"));
    const databasePath = join(root, "arena.sqlite");
    const experimentId = "provider-ledger-recovery";
    let runtime = new ExperimentRuntimeRepository(databasePath);
    let canaries = new CanaryAcceptanceRepository(databasePath);
    const canaryId = canaries.reserve({
      tokenLimit: 1_000,
      costLimit: 1,
      executionKind: "real-provider",
      imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
      backupId: doctorEvidence().completeBackup.backupId,
      backupCreatedAt: doctorEvidence().completeBackup.createdAt,
      doctorCheckedAt: doctorEvidence().checkedAt,
      runtimeIdentity: doctorEvidence().runtimeIdentity,
    });
    canaries.attachExperiment(canaryId, experimentId);
    runtime.registerReady({
      experimentId,
      champions: { generator: "g0", solver: "s0" },
      tokenLimit: 1_000,
      costLimit: 1,
      compatibilityFingerprint: "compat",
    });
    runtime.start(experimentId);
    const reservedModelCalls = runtime.reserveRemainingModelCalls(experimentId, 1, "generator");
    const invocationId = "e".repeat(64);
    const auditDetails = {
      role: "generator", attemptId: "g0001-generator", executionKind: "real-provider",
      protocolVersion: 1, sessionId: "session-recovery", harnessVersion: "2026.09.2",
      providerId: "fake-basic", modelId: "compact-v1", outcome: "succeeded",
    };
    const settled = runtime.reserveProviderAttempt({
      experimentId, generation: 1, role: "generator", tokens: 500, cost: 0.5,
      invocationId, reservedModelCalls, auditDetails,
    });
    const transferred = runtime.settleProviderAttempt({ reservationId: settled, tokens: 120, cost: 0.12 });
    // 崩溃点一：FD5 settle 已原子提交 actual outbox 并清理 attempt，主进程尚未执行后续逻辑。
    runtime.close();
    canaries.close();

    runtime = new ExperimentRuntimeRepository(databasePath);
    expect(runtime.listPendingProviderUsageItems(experimentId, 1, "generator"))
      .toEqual([expect.objectContaining({ itemId: transferred.itemId, modelCallsAccounted: false })]);
    expect(runtime.accountProviderUsageItemModelCalls(transferred.itemId)).toBe(true);
    expect(runtime.accountProviderUsageItemModelCalls(transferred.itemId)).toBe(true);
    expect(runtime.get(experimentId)?.modelCallsReserved).toBe(1);
    // 崩溃点二：模型调用已结算，金丝雀尚未消费。
    runtime.close();

    canaries = new CanaryAcceptanceRepository(databasePath);
    expect(canaries.consumeOnce(transferred.itemId, experimentId, transferred)).toBe(true);
    canaries.close();
    // 崩溃点三：金丝雀已消费，但父账本确认与 checkpoint 尚未提交。
    canaries = new CanaryAcceptanceRepository(databasePath);
    expect(canaries.consumeOnce(transferred.itemId, experimentId, transferred)).toBe(true);
    expect(canaries.get(canaryId)).toMatchObject({
      tokens_consumed: 120, cost_consumed: 0.12, model_calls_consumed: 1,
    });
    canaries.close();

    runtime = new ExperimentRuntimeRepository(databasePath);
    runtime.markProviderUsageItemCanaryAccounted(transferred.itemId, true);
    const audits = new AuditRepository(databasePath);
    const details = { ...transferred.auditDetails, usageTokens: 120, usageCost: 0.12, usageModelCalls: 1 };
    audits.appendOnce(`provider-usage:${transferred.itemId}`, experimentId, "harness.activity", details);
    audits.appendOnce(`provider-usage:${transferred.itemId}`, experimentId, "harness.activity", details);
    runtime.markProviderUsageItemAuditAccounted(transferred.itemId);
    runtime.accountProviderUsageItemRuntime(transferred.itemId);
    runtime.saveRoleCheckpoint({
      experimentId, generation: 1, role: "generator", attemptId: "g0001-generator",
      result: {
        candidateCommit: "candidate", championBefore: "g0", championAfter: "g0", outcome: "failed",
        promotionTag: null, publicProgress: 1, hiddenProgress: 1, aggregate: { primary: 1 },
        hiddenCandidateAggregate: { primary: 1 },
      },
      tokens: 999, cost: 0.99, modelCalls: 8,
    });
    runtime.saveRoleCheckpoint({
      experimentId, generation: 1, role: "generator", attemptId: "g0001-generator",
      result: {
        candidateCommit: "candidate", championBefore: "g0", championAfter: "g0", outcome: "failed",
        promotionTag: null, publicProgress: 1, hiddenProgress: 1, aggregate: { primary: 1 },
        hiddenCandidateAggregate: { primary: 1 },
      },
      tokens: 999, cost: 0.99, modelCalls: 8,
    });
    expect(runtime.getRoleCheckpoint(experimentId, 1, "generator")).toMatchObject({
      tokens: 120, cost: 0.12, modelCalls: 1,
    });
    expect(runtime.get(experimentId)).toMatchObject({ usage: { tokens: 120, cost: 0.12, modelCalls: 1 } });
    expect(runtime.listPendingProviderUsageItems(experimentId, 1, "generator")).toEqual([]);
    expect(audits.list(experimentId).events.filter(({ type }) => type === "harness.activity")).toHaveLength(1);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT COUNT(*) AS count FROM generation_role_provider_usage_items").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM generation_role_provider_attempts").get()).toEqual({ count: 0 });
    database.close();
    audits.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("金丝雀模型调用上限同时覆盖 smoke 两次和双角色各八次", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-model-calls-"));
    const databasePath = join(root, "arena.sqlite");
    const experimentId = "canary-model-call-cap";
    const canaries = new CanaryAcceptanceRepository(databasePath);
    try {
      const canaryId = canaries.reserve({
        tokenLimit: 1_000,
        costLimit: 1,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experimentId);
      canaries.recordSmoke(canaryId, true, { tokens: 2, cost: 0.002, modelCalls: 2 });
      expect(canaries.consumeOnce("generator-full-session", experimentId, {
        tokens: 8,
        cost: 0.008,
        modelCalls: 8,
      })).toBe(true);
      expect(canaries.consumeOnce("solver-full-session", experimentId, {
        tokens: 8,
        cost: 0.008,
        modelCalls: 8,
      })).toBe(true);
      const fullyConsumed = canaries.get(canaryId)!;
      expect(fullyConsumed).toMatchObject({
        tokens_consumed: 18,
        model_calls_consumed: 18,
        budget_exceeded: 0,
      });
      expect(fullyConsumed.cost_consumed).toBeCloseTo(0.018);
      expect(canaries.consumeOnce("nineteenth-call", experimentId, {
        tokens: 1,
        cost: 0.001,
        modelCalls: 1,
      })).toBe(false);
      expect(canaries.get(canaryId)).toMatchObject({
        model_calls_consumed: 19,
        budget_exceeded: 1,
      });
    } finally {
      canaries.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FD5 settle 后主进程立即退出时全新 Server 原子恢复所有 usage 副作用", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-provider-server-restart-"));
    const databasePath = join(root, "arena.sqlite");
    const harnessRoot = join(root, "harness");
    const harness = new DeterministicFakeHarnessAdapter();
    const experiments = new ExperimentRepository(databasePath, harnessRoot);
    const profile = harness.validateModelProfile(requestBody.modelProfile);
    const experiment = experiments.create("FD5 settle 崩溃恢复", profile, 1);
    let runtime = new ExperimentRuntimeRepository(databasePath);
    let canaries = new CanaryAcceptanceRepository(databasePath);
    const canaryId = canaries.reserve({
      tokenLimit: 1_000, costLimit: 1, executionKind: "real-provider",
      imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
      backupId: doctorEvidence().completeBackup.backupId,
      backupCreatedAt: doctorEvidence().completeBackup.createdAt,
      doctorCheckedAt: doctorEvidence().checkedAt,
      runtimeIdentity: doctorEvidence().runtimeIdentity,
    });
    canaries.attachExperiment(canaryId, experiment.id);
    runtime.registerReady({
      experimentId: experiment.id, champions: { generator: "g0", solver: "s0" },
      tokenLimit: 1_000, costLimit: 1, compatibilityFingerprint: "maze-arena-v1",
    });
    runtime.start(experiment.id);
    const reservedModelCalls = runtime.reserveRemainingModelCalls(experiment.id, 1, "generator");
    const invocationId = "9".repeat(64);
    const reservationId = runtime.reserveProviderAttempt({
      experimentId: experiment.id, generation: 1, role: "generator", tokens: 500, cost: 0.5,
      invocationId, reservedModelCalls,
      auditDetails: {
        role: "generator", attemptId: "g0001-generator", executionKind: "real-provider",
        protocolVersion: 1, sessionId: "crashed-session", harnessVersion: "2026.09.2",
        providerId: "fake-basic", modelId: "compact-v1", outcome: "failed",
        failureKind: "process", failureCode: "PROVIDER_PROCESS_INTERRUPTED",
      },
    });
    runtime.settleProviderAttempt({ reservationId, tokens: 120, cost: 0.12 });
    // 模拟 FD5 已回复后主进程立即消失：没有 finalize、reconcile、audit、canary 或 checkpoint 调用。
    runtime.close();
    canaries.close();
    experiments.close();

    const runRole = vi.fn(async ({ role, generation, frozenChampions }: {
      role: EvolutionRole; generation: number; frozenChampions: Readonly<Record<EvolutionRole, string>>;
    }) => {
      if (role === "solver") throw new HarnessInvocationError("停止测试后续角色", "protocol");
      return {
        result: {
          candidateCommit: "retry-candidate", championBefore: frozenChampions[role],
          championAfter: frozenChampions[role], outcome: "failed" as const, promotionTag: null,
          publicProgress: 1, hiddenProgress: 1, aggregate: { primary: 1 },
          hiddenCandidateAggregate: { primary: 1 },
        },
        usage: { tokens: 999, cost: 0.99, modelCalls: 8 },
      };
    });
    const server = createArenaServer({
      databasePath, harnessRoot, harnessAdapter: harness,
      matchRunner: { run: async () => { throw new Error("不应运行"); } },
      autonomousEvolutionAdapter: { runRole },
      compatibilityFingerprint: "maze-arena-v1",
    });
    const observer = new ExperimentRuntimeRepository(databasePath);
    try {
      for (let attempt = 0; attempt < 500 && observer.get(experiment.id)?.state === "running"; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(observer.get(experiment.id)).toMatchObject({
        state: "paused", usage: { tokens: 120, cost: 0.12, modelCalls: 1 }, modelCallsReserved: 1,
      });
      expect(observer.getRoleCheckpoint(experiment.id, 1, "generator")).toMatchObject({
        tokens: 120, cost: 0.12, modelCalls: 1,
      });
      expect(observer.listPendingProviderUsageItems(experiment.id, 1, "generator")).toEqual([]);
      const recoveredCanaries = new CanaryAcceptanceRepository(databasePath);
      expect(recoveredCanaries.get(canaryId)).toMatchObject({
        tokens_consumed: 120, cost_consumed: 0.12, model_calls_consumed: 1,
      });
      recoveredCanaries.close();
      const audits = new AuditRepository(databasePath);
      expect(audits.list(experiment.id).events.filter(({ type }) => type === "harness.activity"))
        .toEqual([expect.objectContaining({ details: expect.objectContaining({
          outcome: "failed", failureCode: "PROVIDER_PROCESS_INTERRUPTED",
          usageTokens: 120, usageCost: 0.12, usageModelCalls: 1,
        }) })]);
      audits.close();
      const database = new DatabaseSync(databasePath);
      expect(database.prepare("SELECT COUNT(*) AS count FROM generation_role_provider_usage_items").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM generation_role_provider_attempts").get())
        .toEqual({ count: 0 });
      database.close();
      expect(runRole).toHaveBeenCalledTimes(2);
    } finally {
      observer.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("终态报告只绑定已关闭金丝雀并且重复写入必须幂等", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-canary-terminal-report-"));
    const databasePath = join(root, "arena.sqlite");
    const experimentId = "terminal-report-experiment";
    const canaries = new CanaryAcceptanceRepository(databasePath);
    try {
      const canaryId = canaries.reserve({
        tokenLimit: 1_000,
        costLimit: 1,
        executionKind: "real-provider",
        imageDigest: doctorEvidence().runtimeIdentity.imageDigest,
        backupId: doctorEvidence().completeBackup.backupId,
        backupCreatedAt: doctorEvidence().completeBackup.createdAt,
        doctorCheckedAt: doctorEvidence().checkedAt,
        runtimeIdentity: doctorEvidence().runtimeIdentity,
      });
      canaries.attachExperiment(canaryId, experimentId);
      const closed = canaries.finishExperiment(experimentId)!;
      expect(closed.state).toBe("closed");
      expect(closed.completed_at).toEqual(expect.any(String));
      const report = {
        schemaVersion: 1,
        canaryId,
        experimentId,
        status: "failed",
        startedAt: closed.started_at,
        completedAt: closed.completed_at,
        executionKind: "real-provider",
        limits: {
          tokens: closed.token_limit, cost: closed.cost_limit, consumedTokens: 0, consumedCost: 0,
          modelCalls: 18, consumedModelCalls: 0, withinLimit: true, reconciled: true,
        },
        preflight: {
          doctorPassed: true, doctorCheckedAt: closed.doctor_checked_at ?? "", modelSmokePassed: false,
          modelSmokeUsage: { tokens: 0, cost: 0, modelCalls: 0 }, immutableImage: closed.image_digest,
          completeBackupId: closed.backup_id, completeBackupCreatedAt: closed.backup_created_at ?? "",
          runtimeIdentity: doctorEvidence().runtimeIdentity,
        },
        roles: {},
        mechanismClosed: false,
        promoted: false,
        formalAcceptancePassed: false,
        reason: "测试终态",
        nonGuarantee: "测试报告",
      } as unknown as RealDshCanaryReport;
      canaries.persistTerminalReport(canaryId, report);
      canaries.persistTerminalReport(canaryId, report);
      expect(canaries.get(canaryId)?.terminal_report_json).toBe(JSON.stringify(report));
      expect(() => canaries.persistTerminalReport(canaryId, { ...report, reason: "冲突报告" }))
        .toThrow("金丝雀终态报告幂等载荷冲突");
      expect(canaries.finishExperiment(experimentId)?.terminal_report_json).toBe(JSON.stringify(report));
    } finally {
      canaries.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
