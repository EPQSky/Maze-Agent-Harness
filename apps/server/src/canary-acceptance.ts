import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  EvolutionRole,
  RealDshCanaryReport,
  RealDshCanaryRoleReport,
} from "@maze-arena/contracts";
import type { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import type { AuditRepository } from "./audit-repository.js";
import { isImmutableImageReference } from "./immutable-image-reference.js";

const CANARY_SMOKE_MODEL_CALLS = 2;
const CANARY_ROLE_MODEL_CALLS = 8;
const CANARY_TOTAL_MODEL_CALLS = CANARY_SMOKE_MODEL_CALLS + CANARY_ROLE_MODEL_CALLS * 2;

export interface CanaryRow {
  canary_id: string;
  experiment_id: string;
  started_at: string;
  token_limit: number;
  cost_limit: number;
  execution_kind: "real-provider" | "deterministic-fixture";
  doctor_passed: number;
  doctor_checked_at: string | null;
  doctor_identity_json: string;
  image_digest: string;
  backup_id: string;
  backup_created_at: string | null;
  preflight_failure: string | null;
  smoke_passed: number;
  smoke_usage_json: string;
  terminal_report_json: string | null;
  state: "active" | "closed";
  completed_at: string | null;
  tokens_consumed: number;
  cost_consumed: number;
  model_calls_consumed: number;
  budget_exceeded: number;
}

export interface ReserveCanaryInput {
  tokenLimit: number;
  costLimit: number;
  executionKind: "real-provider" | "deterministic-fixture";
  imageDigest: string;
  backupId: string;
  backupCreatedAt: string;
  doctorCheckedAt: string;
  runtimeIdentity: {
    harnessPackage: string;
    harnessVersion: string;
    modelCatalogRelease: string;
    modelReleaseSha256: string;
    imageDigest: string;
    harnessRuntimePayloadSha256: string;
  };
}

export class CanaryAcceptanceRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS real_dsh_canaries (
        canary_id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        token_limit INTEGER NOT NULL,
        cost_limit REAL NOT NULL,
        execution_kind TEXT NOT NULL,
        doctor_passed INTEGER NOT NULL,
        doctor_checked_at TEXT,
        doctor_identity_json TEXT NOT NULL DEFAULT '{}',
        image_digest TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        backup_created_at TEXT,
        preflight_failure TEXT,
        smoke_passed INTEGER NOT NULL DEFAULT 0,
        smoke_usage_json TEXT NOT NULL DEFAULT '{"tokens":0,"cost":0,"modelCalls":0}',
        terminal_report_json TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        completed_at TEXT,
        tokens_consumed INTEGER NOT NULL DEFAULT 0,
        cost_consumed REAL NOT NULL DEFAULT 0,
        model_calls_consumed INTEGER NOT NULL DEFAULT 0,
        budget_exceeded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS real_dsh_canary_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        canary_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS real_dsh_canary_usage_receipts (
        batch_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, tokens INTEGER NOT NULL,
        cost REAL NOT NULL, model_calls INTEGER NOT NULL, accepted INTEGER NOT NULL
      );`);
    const columns = new Set((this.database.prepare("PRAGMA table_info(real_dsh_canaries)").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has("smoke_passed")) {
      this.database.exec("ALTER TABLE real_dsh_canaries ADD COLUMN smoke_passed INTEGER NOT NULL DEFAULT 0");
    }
    for (const [name, definition] of [
      ["state", "TEXT NOT NULL DEFAULT 'closed'"],
      ["completed_at", "TEXT"],
      ["tokens_consumed", "INTEGER NOT NULL DEFAULT 0"],
      ["cost_consumed", "REAL NOT NULL DEFAULT 0"],
      ["budget_exceeded", "INTEGER NOT NULL DEFAULT 0"],
      ["doctor_checked_at", "TEXT"],
      ["doctor_identity_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["backup_created_at", "TEXT"],
      ["smoke_usage_json", "TEXT NOT NULL DEFAULT '{\"tokens\":0,\"cost\":0,\"modelCalls\":0}'"],
      ["terminal_report_json", "TEXT"],
      ["model_calls_consumed", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE real_dsh_canaries ADD COLUMN ${name} ${definition}`);
    }
  }

  reserve(input: ReserveCanaryInput): string {
    const canaryId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO real_dsh_canary_lease (singleton, canary_id) VALUES (1, ?)").run(canaryId);
      this.database.prepare(`INSERT INTO real_dsh_canaries (
        canary_id, experiment_id, started_at, token_limit, cost_limit, execution_kind,
        doctor_passed, doctor_checked_at, doctor_identity_json, image_digest, backup_id, backup_created_at,
        preflight_failure, smoke_passed, smoke_usage_json, terminal_report_json,
        state, completed_at, tokens_consumed, cost_consumed, model_calls_consumed, budget_exceeded
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, 0, '{"tokens":0,"cost":0,"modelCalls":0}', NULL,
        'active', NULL, 0, 0, 0, 0)`).run(
        canaryId,
        `pending-${canaryId}`,
        new Date().toISOString(),
        input.tokenLimit,
        input.costLimit,
        input.executionKind,
        input.doctorCheckedAt,
        JSON.stringify(input.runtimeIdentity),
        input.imageDigest,
        input.backupId,
        input.backupCreatedAt,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
        throw new Error("已有活动中的真实金丝雀，拒绝并发启动");
      }
      throw error;
    }
    return canaryId;
  }

  attachExperiment(canaryId: string, experimentId: string): void {
    const changed = this.database.prepare(`UPDATE real_dsh_canaries SET experiment_id = ?
      WHERE canary_id = ? AND state = 'active'`).run(experimentId, canaryId);
    if (Number(changed.changes) !== 1) throw new Error("金丝雀租约已失效");
  }

  failPreflight(canaryId: string, reason: string): void {
    this.closeCanary(canaryId, reason.slice(0, 200));
  }

  recordSmoke(canaryId: string, passed: boolean, usage: { tokens: number; cost: number; modelCalls: number }): void {
    assertCanaryUsage(usage);
    const changed = this.database.prepare(`UPDATE real_dsh_canaries SET smoke_passed = ?, smoke_usage_json = ?,
      tokens_consumed = tokens_consumed + ?, cost_consumed = cost_consumed + ?,
      model_calls_consumed = model_calls_consumed + ?
      WHERE canary_id = ? AND state = 'active' AND tokens_consumed + ? <= token_limit
        AND cost_consumed + ? <= cost_limit AND model_calls_consumed + ? <= ${CANARY_TOTAL_MODEL_CALLS}`).run(
      passed ? 1 : 0, JSON.stringify(usage), usage.tokens, usage.cost, usage.modelCalls, canaryId,
      usage.tokens, usage.cost, usage.modelCalls,
    );
    if (Number(changed.changes) !== 1) {
      this.database.prepare(`UPDATE real_dsh_canaries SET smoke_passed = 0, smoke_usage_json = ?,
        tokens_consumed = tokens_consumed + ?, cost_consumed = cost_consumed + ?,
        model_calls_consumed = model_calls_consumed + ?, budget_exceeded = 1
        WHERE canary_id = ? AND state = 'active'`).run(
        JSON.stringify(usage), usage.tokens, usage.cost, usage.modelCalls, canaryId,
      );
      throw new Error("真实模型冒烟用量超过金丝雀硬预算");
    }
  }

  get(canaryId: string): CanaryRow | undefined {
    return this.database.prepare("SELECT * FROM real_dsh_canaries WHERE canary_id = ?")
      .get(canaryId) as unknown as CanaryRow | undefined;
  }

  getByExperimentId(experimentId: string): CanaryRow | undefined {
    return this.database.prepare("SELECT * FROM real_dsh_canaries WHERE experiment_id = ?")
      .get(experimentId) as unknown as CanaryRow | undefined;
  }

  remaining(experimentId: string): { tokens: number; cost: number } | undefined {
    const row = this.database.prepare(`SELECT token_limit, cost_limit, tokens_consumed, cost_consumed
      FROM real_dsh_canaries WHERE experiment_id = ? AND state = 'active'`).get(experimentId) as
      { token_limit: number; cost_limit: number; tokens_consumed: number; cost_consumed: number } | undefined;
    return row ? {
      tokens: Math.max(0, row.token_limit - row.tokens_consumed),
      cost: Math.max(0, row.cost_limit - row.cost_consumed),
    } : undefined;
  }

  consume(experimentId: string, usage: { tokens: number; cost: number; modelCalls?: number }): boolean {
    const modelCalls = usage.modelCalls ?? 0;
    try { assertCanaryUsage({ ...usage, modelCalls }); } catch { return false; }
    const result = this.database.prepare(`UPDATE real_dsh_canaries
      SET tokens_consumed = tokens_consumed + ?, cost_consumed = cost_consumed + ?,
        model_calls_consumed = model_calls_consumed + ?
      WHERE experiment_id = ? AND state = 'active'
        AND tokens_consumed + ? <= token_limit AND cost_consumed + ? <= cost_limit
        AND model_calls_consumed + ? <= ${CANARY_TOTAL_MODEL_CALLS}`)
      .run(usage.tokens, usage.cost, modelCalls, experimentId, usage.tokens, usage.cost, modelCalls);
    if (Number(result.changes) === 1) return true;
    this.database.prepare(`UPDATE real_dsh_canaries SET tokens_consumed = tokens_consumed + ?,
      cost_consumed = cost_consumed + ?, model_calls_consumed = model_calls_consumed + ?, budget_exceeded = 1
      WHERE experiment_id = ? AND state = 'active'`).run(usage.tokens, usage.cost, modelCalls, experimentId);
    return false;
  }

  consumeOnce(batchId: string, experimentId: string, usage: { tokens: number; cost: number; modelCalls?: number }): boolean {
    const modelCalls = usage.modelCalls ?? 0;
    assertCanaryUsage({ ...usage, modelCalls });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`SELECT experiment_id, tokens, cost, model_calls, accepted
        FROM real_dsh_canary_usage_receipts WHERE batch_id = ?`).get(batchId) as {
          experiment_id: string; tokens: number; cost: number; model_calls: number; accepted: number;
        } | undefined;
      if (existing) {
        if (existing.experiment_id !== experimentId || existing.tokens !== usage.tokens
          || Math.abs(existing.cost - usage.cost) > 1e-12 || existing.model_calls !== modelCalls) {
          throw new Error("金丝雀 usage receipt 幂等载荷冲突");
        }
        this.database.exec("COMMIT");
        return existing.accepted === 1;
      }
      const result = this.database.prepare(`UPDATE real_dsh_canaries
        SET tokens_consumed = tokens_consumed + ?, cost_consumed = cost_consumed + ?,
          model_calls_consumed = model_calls_consumed + ? WHERE experiment_id = ? AND state = 'active'
          AND tokens_consumed + ? <= token_limit AND cost_consumed + ? <= cost_limit
          AND model_calls_consumed + ? <= ${CANARY_TOTAL_MODEL_CALLS}`).run(
        usage.tokens, usage.cost, modelCalls, experimentId, usage.tokens, usage.cost, modelCalls,
      );
      const accepted = Number(result.changes) === 1;
      if (!accepted) this.database.prepare(`UPDATE real_dsh_canaries SET tokens_consumed = tokens_consumed + ?,
        cost_consumed = cost_consumed + ?, model_calls_consumed = model_calls_consumed + ?, budget_exceeded = 1
        WHERE experiment_id = ? AND state = 'active'`).run(usage.tokens, usage.cost, modelCalls, experimentId);
      this.database.prepare(`INSERT INTO real_dsh_canary_usage_receipts
        (batch_id, experiment_id, tokens, cost, model_calls, accepted) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(batchId, experimentId, usage.tokens, usage.cost, modelCalls, accepted ? 1 : 0);
      this.database.exec("COMMIT");
      return accepted;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  finishExperiment(experimentId: string): CanaryRow | undefined {
    const row = this.database.prepare("SELECT canary_id, state FROM real_dsh_canaries WHERE experiment_id = ?")
      .get(experimentId) as { canary_id: string; state: CanaryRow["state"] } | undefined;
    if (!row) return undefined;
    if (row.state === "active") this.closeCanary(row.canary_id);
    return this.get(row.canary_id);
  }

  recoverOrphaned(
    activeExperimentIds: ReadonlySet<string>,
    terminalExperimentIds: ReadonlySet<string> = new Set(),
  ): CanaryRow[] {
    const activeRows = this.database.prepare(`SELECT canary_id, experiment_id
      FROM real_dsh_canaries WHERE state = 'active'`).all() as Array<{ canary_id: string; experiment_id: string }>;
    const recovered: CanaryRow[] = [];
    for (const row of activeRows) {
      if (activeExperimentIds.has(row.experiment_id)) continue;
      // 已有终态 runtime 说明运行代次已经合法收敛，只是终态回调尚未落盘，不能改写成前置失败。
      this.closeCanary(row.canary_id,
        terminalExperimentIds.has(row.experiment_id) ? undefined : "金丝雀启动流程中断，重启时未发现可恢复的运行时");
      const closed = this.get(row.canary_id);
      if (closed) recovered.push(closed);
    }
    return recovered;
  }

  listUnreportedTerminalReports(): CanaryRow[] {
    return this.database.prepare(`SELECT * FROM real_dsh_canaries
      WHERE state = 'closed' AND terminal_report_json IS NULL ORDER BY completed_at, canary_id`)
      .all() as unknown as CanaryRow[];
  }

  listReportedTerminalReports(): CanaryRow[] {
    return this.database.prepare(`SELECT * FROM real_dsh_canaries
      WHERE state = 'closed' AND terminal_report_json IS NOT NULL ORDER BY completed_at, canary_id`)
      .all() as unknown as CanaryRow[];
  }

  persistTerminalReport(canaryId: string, report: RealDshCanaryReport): void {
    if (report.canaryId !== canaryId || report.status === "running" || report.completedAt === null) {
      throw new Error("金丝雀终态报告必须绑定已完成的同一金丝雀");
    }
    const serialized = JSON.stringify(report);
    const existing = this.database.prepare("SELECT terminal_report_json, state FROM real_dsh_canaries WHERE canary_id = ?")
      .get(canaryId) as { terminal_report_json: string | null; state: CanaryRow["state"] } | undefined;
    if (!existing) throw new Error("未找到金丝雀记录，拒绝持久化终态报告");
    if (existing.state !== "closed") throw new Error("金丝雀尚未关闭，拒绝持久化终态报告");
    if (existing.terminal_report_json) {
      if (existing.terminal_report_json !== serialized) throw new Error("金丝雀终态报告幂等载荷冲突");
      return;
    }
    const changed = this.database.prepare(`UPDATE real_dsh_canaries SET terminal_report_json = ?
      WHERE canary_id = ? AND state = 'closed' AND terminal_report_json IS NULL`).run(serialized, canaryId);
    if (Number(changed.changes) !== 1) throw new Error("金丝雀尚未关闭，拒绝持久化终态报告");
  }

  private closeCanary(canaryId: string, preflightFailure?: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE real_dsh_canaries SET state = 'closed', completed_at = COALESCE(completed_at, ?),
        preflight_failure = COALESCE(?, preflight_failure) WHERE canary_id = ?`)
        .run(new Date().toISOString(), preflightFailure ?? null, canaryId);
      this.database.prepare("DELETE FROM real_dsh_canary_lease WHERE canary_id = ?").run(canaryId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.database.close(); }
}

export function buildCanaryReport(input: {
  row: CanaryRow;
  runtime: ExperimentRuntimeRepository;
  lineage: PluginLineageRepository;
  audits: AuditRepository;
  frozenModelProfile: Record<string, unknown> | null;
}): RealDshCanaryReport {
  const snapshot = input.runtime.get(input.row.experiment_id);
  const generation = snapshot?.generations[0];
  const runtimeIdentity = parseRuntimeIdentity(input.row.doctor_identity_json);
  const events = input.audits.list(input.row.experiment_id, 0, 1_024).events;
  const roles = Object.fromEntries((["generator", "solver"] as const).map((role) => [
    role,
    buildRoleReport(
      role,
      input.row.experiment_id,
      generation?.generation ?? null,
      snapshot?.champions[role] ?? null,
      generation?.[role] ?? null,
      input.runtime.getRoleCheckpoint(input.row.experiment_id, 1, role),
      events,
      input.lineage,
      input.row.execution_kind,
      {
        harnessVersion: runtimeIdentity?.harnessVersion ?? null,
        providerId: typeof input.frozenModelProfile?.providerId === "string" ? input.frozenModelProfile.providerId : null,
        modelId: typeof input.frozenModelProfile?.modelId === "string" ? input.frozenModelProfile.modelId : null,
      },
    ),
  ])) as Record<EvolutionRole, RealDshCanaryRoleReport>;
  const terminal = input.row.state === "closed"
    || Boolean(input.row.preflight_failure)
    || Boolean(snapshot && ["paused", "completed", "failed", "cancelled"].includes(snapshot.state));
  const doctorPassed = validPersistedDoctorEvidence(input.row, runtimeIdentity);
  const reportedRuntimeIdentity: RealDshCanaryReport["preflight"]["runtimeIdentity"] = runtimeIdentity ? {
    harnessPackage: runtimeIdentity.harnessPackage,
    harnessVersion: runtimeIdentity.harnessVersion,
    modelCatalogRelease: runtimeIdentity.modelCatalogRelease,
    modelReleaseSha256: runtimeIdentity.modelReleaseSha256,
    harnessRuntimePayloadSha256: runtimeIdentity.harnessRuntimePayloadSha256,
  } : { harnessPackage: "", harnessVersion: "", modelCatalogRelease: "", modelReleaseSha256: "", harnessRuntimePayloadSha256: "" };
  const roleMechanismsClosed = Object.values(roles).every((role) =>
    role.candidateCommit !== null
    && /^[0-9a-f]{40}$/.test(role.candidateCommit)
    && role.candidateCommit !== role.championBefore
    && role.diff !== null
    && role.diff.length > 0
    && role.evaluation.trustedBuildSha256 !== null
    && /^[0-9a-f]{64}$/.test(role.evaluation.trustedBuildSha256)
    && role.evaluation.publicCases > 0
    && role.evaluation.hiddenCases > 0
    && role.evaluation.isolatedInDocker
    && role.evidenceLevel === input.row.execution_kind
    && role.executionIdentityVerified
    && role.usageReconciled
    && role.gitIntegrityVerified
    && role.promotionVerified
    && role.sessionIds.length > 0);
  const allSessions = Object.values(roles).flatMap((role) => role.sessionIds);
  const freshSessions = new Set(allSessions).size === allSessions.length;
  const realProvider = input.row.execution_kind === "real-provider";
  const mechanismClosed = doctorPassed && Boolean(generation) && roleMechanismsClosed && freshSessions;
  const promoted = Object.values(roles).some((role) => role.outcome === "promoted");
  const promotionProofComplete = Object.values(roles).every((role) => role.outcome !== "promoted"
    || Boolean(role.promotionTag && role.candidateCommit === role.championAfter && role.championAfter === role.nextGenerationStart));
  const modelSmokePassed = input.row.smoke_passed === 1;
  const smokeUsage = parseUsage(input.row.smoke_usage_json);
  const auditedUsage = Object.values(roles).reduce((total, role) => ({
    tokens: total.tokens + role.usage.tokens,
    cost: total.cost + role.usage.cost,
    modelCalls: total.modelCalls + role.usage.modelCalls,
  }), { ...smokeUsage });
  const usageWithinLimit = auditedUsage.tokens <= input.row.token_limit && auditedUsage.cost <= input.row.cost_limit
    && input.row.tokens_consumed <= input.row.token_limit && input.row.cost_consumed <= input.row.cost_limit
    && input.row.model_calls_consumed <= CANARY_TOTAL_MODEL_CALLS
    && input.row.budget_exceeded === 0;
  const usageReconciled = Object.values(roles).every(({ usageReconciled }) => usageReconciled)
    && auditedUsage.tokens === input.row.tokens_consumed
    && Math.abs(auditedUsage.cost - input.row.cost_consumed) < 1e-9
    && auditedUsage.modelCalls === input.row.model_calls_consumed
    && (!snapshot || (snapshot.usage.tokens === auditedUsage.tokens - smokeUsage.tokens
      && Math.abs(snapshot.usage.cost - (auditedUsage.cost - smokeUsage.cost)) < 1e-9
      && snapshot.usage.modelCalls === auditedUsage.modelCalls - smokeUsage.modelCalls));
  const formalAcceptancePassed = terminal && doctorPassed && mechanismClosed && promotionProofComplete && modelSmokePassed && realProvider
    && usageWithinLimit && usageReconciled;
  const incompleteRoleFailure = Object.values(roles).find((role) => role.outcome === null && role.reason.startsWith("Harness 调用失败："));
  const status = input.row.preflight_failure
    ? "preflight-failed"
    : !terminal
      ? "running"
      : mechanismClosed
        ? "closed"
        : "failed";
  const reason = input.row.preflight_failure
    ?? (status === "running" ? "金丝雀正在执行受监督的一代进化"
      : !doctorPassed ? "Server doctor 运行身份或备份新鲜度证据不完整"
        : !modelSmokePassed ? "真实模型冒烟未通过"
        : !usageWithinLimit ? "金丝雀可信用量超过硬预算，已关闭失败"
          : !usageReconciled ? "Harness activity、预算账本与运行时用量无法对账"
            : !realProvider ? "确定性夹具只能验证机制，不能形成真实提供方正式验收"
              : incompleteRoleFailure ? incompleteRoleFailure.reason
          : !roleMechanismsClosed ? "至少一个角色未形成源码差异、可信重建、Docker 配对评测和 Git 候选证据"
            : !freshSessions ? "Harness Session 未满足每次调用全新且互不复用"
              : !promotionProofComplete ? "晋级标签或下一代冠军起点证据不完整"
                : promoted ? "真实自进化机制已闭环，本次至少一个候选晋级" : "真实自进化机制已闭环，本次候选未晋级");
  return {
    schemaVersion: 1,
    canaryId: input.row.canary_id,
    experimentId: input.row.experiment_id,
    status,
    startedAt: input.row.started_at,
    completedAt: input.row.completed_at,
    executionKind: input.row.execution_kind,
    limits: {
      tokens: input.row.token_limit,
      cost: input.row.cost_limit,
      consumedTokens: auditedUsage.tokens,
      consumedCost: auditedUsage.cost,
      modelCalls: CANARY_TOTAL_MODEL_CALLS,
      consumedModelCalls: auditedUsage.modelCalls,
      withinLimit: usageWithinLimit,
      reconciled: usageReconciled,
    },
    preflight: {
      doctorPassed,
      doctorCheckedAt: input.row.doctor_checked_at ?? "",
      modelSmokePassed,
      modelSmokeUsage: smokeUsage,
      immutableImage: input.row.image_digest,
      completeBackupId: input.row.backup_id,
      completeBackupCreatedAt: input.row.backup_created_at ?? "",
      runtimeIdentity: reportedRuntimeIdentity,
    },
    roles,
    mechanismClosed,
    promoted,
    formalAcceptancePassed,
    reason,
    nonGuarantee: "本次验收只证明真实自进化链路与晋级判定可审计，不保证模型持续产生更优算法。",
  };
}

function buildRoleReport(
  role: EvolutionRole,
  experimentId: string,
  generation: number | null,
  nextGenerationStart: string | null,
  generationResult: import("@maze-arena/contracts").GenerationRoleResult | null,
  checkpoint: ReturnType<ExperimentRuntimeRepository["getRoleCheckpoint"]>,
  events: ReturnType<AuditRepository["list"]>["events"],
  lineage: PluginLineageRepository,
  expectedKind: CanaryRow["execution_kind"],
  expectedIdentity: { harnessVersion: string | null; providerId: string | null; modelId: string | null },
): RealDshCanaryRoleReport {
  const result = checkpoint?.result ?? generationResult;
  const activity = [...new Map(events.filter((event) => event.type === "harness.activity"
    && event.details.role === role).map((event) => [event.id, event])).values()];
  const usageActivity = activity.filter((event) => typeof event.details.usageTokens === "number"
    && typeof event.details.usageCost === "number" && typeof event.details.usageModelCalls === "number");
  const usage = usageActivity.reduce((total, event) => ({
    tokens: total.tokens + (typeof event.details.usageTokens === "number" ? event.details.usageTokens : 0),
    cost: total.cost + (typeof event.details.usageCost === "number" ? event.details.usageCost : 0),
    modelCalls: total.modelCalls + (typeof event.details.usageModelCalls === "number" ? event.details.usageModelCalls : 0),
  }), { tokens: 0, cost: 0, modelCalls: 0 });
  const sessionIds = [...new Set(activity.flatMap((event) =>
    typeof event.details.sessionId === "string" ? [event.details.sessionId] : []))];
  const executionIdentityVerified = activity.length > 0 && activity.every((event) =>
    event.details.executionKind === expectedKind
    && event.details.attemptId === checkpoint?.attemptId
    && event.details.harnessVersion === expectedIdentity.harnessVersion
    && event.details.providerId === expectedIdentity.providerId
    && event.details.modelId === expectedIdentity.modelId
    && typeof event.details.sessionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.details.sessionId))
    // 一个 Harness Session 会为多个模型回合产生多条 activity；只要每条记录都绑定到合法身份，
    // 不能把“同一 Session 的多回合”误判为跨 Session 复用。跨角色的 Session 唯一性由 freshSessions 校验。
    && sessionIds.length > 0;
  const usageReconciled = checkpoint
    ? checkpoint.tokens === usage.tokens && Math.abs(checkpoint.cost - usage.cost) < 1e-9
      && checkpoint.modelCalls === usage.modelCalls
    : result === null;
  let diff: string | null = null;
  let diffSha256: string | null = null;
  let diffTruncated = false;
  let gitIntegrityVerified = false;
  let promotionVerified = result?.outcome !== "promoted";
  try {
    const history = lineage.listHistory(experimentId, role);
    const recorded = checkpoint ? lineage.candidateResult(experimentId, role, checkpoint.attemptId) : undefined;
    const runtimeReconciled = Boolean(generation === 1 && result && checkpoint && generationResult
      && JSON.stringify(checkpoint.result) === JSON.stringify(generationResult)
      && result.attemptId === checkpoint.attemptId);
    const candidateReconciled = Boolean(recorded && result
      && recorded.attemptId === checkpoint?.attemptId
      && recorded.commit === result.candidateCommit
      && recorded.outcome === result.outcome
      && recorded.generation === (result.outcome === "promoted" ? generation : null));
    gitIntegrityVerified = runtimeReconciled && candidateReconciled
      && history.some((entry) => entry.commit === result?.candidateCommit && entry.candidateStage === "final"
        && entry.attemptId === checkpoint?.attemptId && entry.outcome === result?.outcome
        && entry.generation === (result?.outcome === "promoted" ? generation : null));
    const nonPromotedConsistent = result?.outcome !== "promoted"
      && result?.promotionTag === null
      && result?.championAfter === result?.championBefore
      && nextGenerationStart === result?.championBefore;
    if (result?.outcome === "promoted") {
      promotionVerified = history.some((entry) => entry.commit === result.candidateCommit
        && result.promotionTag === `promotion/${experimentId}/${role}/g${String(generation).padStart(4, "0")}`
        && entry.tags.includes(result.promotionTag))
        && result.championAfter === result.candidateCommit
        && nextGenerationStart === result.candidateCommit;
    } else {
      promotionVerified = nonPromotedConsistent;
    }
  } catch {
    gitIntegrityVerified = false;
    promotionVerified = false;
  }
  if (gitIntegrityVerified && result && result.candidateCommit !== result.championBefore) {
    try {
      const completeDiff = lineage.diff(experimentId, role, result.championBefore, result.candidateCommit);
      diffSha256 = createHash("sha256").update(completeDiff).digest("hex");
      diffTruncated = Buffer.byteLength(completeDiff, "utf8") > 64 * 1024;
      diff = diffTruncated ? Buffer.from(completeDiff).subarray(0, 64 * 1024).toString("utf8") : completeDiff;
    }
    catch { diff = null; }
  }
  const lastFailedActivity = activity.filter((event) => event.details.outcome === "failed").at(-1);
  const reason = !result ? (lastFailedActivity
    ? `Harness 调用失败：${String(lastFailedActivity.details.failureKind ?? "unknown")}${
      typeof lastFailedActivity.details.failureCode === "string" ? `/${lastFailedActivity.details.failureCode}` : ""}`
    : "尚未持久化角色结果")
    : result.outcome === "promoted" ? "候选通过公开与隐藏配对评测并晋级"
      : result.gateDiagnostics?.join("；") || (result.outcome === "tie" ? "候选与冠军平局，按规则不晋级" : "候选未通过晋级规则");
  return {
    role,
    evidenceLevel: result?.evidenceLevel ?? null,
    candidateCommit: result?.candidateCommit ?? null,
    championBefore: result?.championBefore ?? null,
    championAfter: result?.championAfter ?? null,
    outcome: result?.outcome ?? null,
    promotionTag: result?.promotionTag ?? null,
    nextGenerationStart,
    diff,
    diffSha256,
    diffTruncated,
    usage,
    usageReconciled,
    executionIdentityVerified: executionIdentityVerified && result?.evidenceLevel === expectedKind,
    gitIntegrityVerified,
    promotionVerified,
    evaluation: {
      trustedBuildSha256: result?.trustedBuildSha256 ?? null,
      publicCases: result?.publicProgress ?? 0,
      hiddenCases: result?.hiddenProgress ?? 0,
      isolatedInDocker: result?.isolatedEvaluation === true,
    },
    sessionIds,
    reason,
  };
}

function parseRuntimeIdentity(value: string): (RealDshCanaryReport["preflight"]["runtimeIdentity"] & { imageDigest: string }) | null {
  try {
    const identity = JSON.parse(value) as Record<string, unknown>;
    if (typeof identity.harnessPackage !== "string" || typeof identity.harnessVersion !== "string"
      || typeof identity.modelCatalogRelease !== "string" || typeof identity.modelReleaseSha256 !== "string"
      || typeof identity.imageDigest !== "string"
      || typeof identity.harnessRuntimePayloadSha256 !== "string") return null;
    return identity as unknown as RealDshCanaryReport["preflight"]["runtimeIdentity"] & { imageDigest: string };
  } catch { return null; }
}

function validPersistedDoctorEvidence(
  row: CanaryRow,
  identity: (RealDshCanaryReport["preflight"]["runtimeIdentity"] & { imageDigest: string }) | null,
): boolean {
  if (row.doctor_passed !== 1 || !identity || !row.doctor_checked_at || !row.backup_created_at) return false;
  const checkedAt = new Date(row.doctor_checked_at);
  const backupCreatedAt = new Date(row.backup_created_at);
  const startedAt = new Date(row.started_at);
  try {
    return checkedAt.toISOString() === row.doctor_checked_at
      && backupCreatedAt.toISOString() === row.backup_created_at
      && startedAt.toISOString() === row.started_at
      && backupCreatedAt.getTime() <= checkedAt.getTime()
      && checkedAt.getTime() <= startedAt.getTime()
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(row.backup_id)
      && identity.harnessPackage === "@deepseek-ai/dsh"
      && identity.harnessVersion.length > 0
      && identity.modelCatalogRelease.length > 0
      && /^[0-9a-f]{64}$/.test(identity.modelReleaseSha256)
      && identity.modelCatalogRelease === identity.modelReleaseSha256
      && /^[0-9a-f]{64}$/.test(identity.harnessRuntimePayloadSha256)
      && identity.imageDigest === row.image_digest
      && isImmutableImageReference(identity.imageDigest);
  } catch { return false; }
}

function parseUsage(value: string): { tokens: number; cost: number; modelCalls: number } {
  try {
    const usage = JSON.parse(value) as { tokens: number; cost: number; modelCalls: number };
    assertCanaryUsage(usage);
    return usage;
  } catch { return { tokens: 0, cost: 0, modelCalls: 0 }; }
}

function assertCanaryUsage(usage: { tokens: number; cost: number; modelCalls: number }): void {
  if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.cost) || usage.cost < 0
    || !Number.isSafeInteger(usage.modelCalls) || usage.modelCalls < 0) {
    throw new Error("金丝雀可信用量非法");
  }
}
