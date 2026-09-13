import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import type { ExperimentRuntimeSnapshot, GenerationRecord, GenerationRoleResult, EvolutionRole } from "@maze-arena/contracts";

export const baselineValidationSteps = [
  "model-config",
  "native-plugin-install",
  "isolated-match",
  "event-replay",
  "determinism",
  "maze-legality",
  "persistence",
  "live-delivery",
  "paired-evaluation",
  "promotion-tag",
] as const;

// 八次模型回合中，正式 DSH 需要最多七次顶层工具调用后再返回最终 JSON。
export const MAX_TOP_LEVEL_TOOL_CALLS = 7;

export type BaselineValidationStep = (typeof baselineValidationSteps)[number];
export type BaselineValidationStatus = "pending" | "running" | "failed" | "passed" | "ready";
export type HarnessFailureKind = "transient-provider" | "provider" | "protocol" | "process";

export interface BaselineStepResult {
  step: BaselineValidationStep;
  passed: boolean;
  diagnostics: string[];
}

export interface FrozenExperimentConfiguration {
  modelProfile: Record<string, unknown>;
  tokenLimit: number;
  costLimit: number | null;
  rulesDigest: string;
  seedPolicyDigest: string;
  resourcePolicyDigest: string;
  scoringVersion: string;
  compatibilityFingerprint: string;
  modelReleaseSha256?: string;
}

export interface BaselineValidationRecord {
  experimentId: string;
  status: BaselineValidationStatus;
  steps: BaselineStepResult[];
  operatorConfirmed: boolean;
  frozenConfiguration: FrozenExperimentConfiguration | null;
  frozenDigest: string | null;
  smoke: { attempted: boolean; passed: boolean | null; usage: Usage | null; failureKind: HarnessFailureKind | null };
}

interface Usage { tokens: number; cost: number; modelCalls: number }

export interface ProviderUsageItem extends Usage {
  itemId: string;
  reservationId: string;
  invocationId: string;
  experimentId: string;
  generation: number;
  role: EvolutionRole;
  auditDetails: Record<string, unknown>;
  modelCallsAccounted: boolean;
  canaryAccounted: boolean;
  canaryAccepted: boolean | null;
  auditAccounted: boolean;
  runtimeAccounted: boolean;
}

interface ProviderUsageItemRow {
  item_id: string;
  reservation_id: string;
  invocation_id: string;
  experiment_id: string;
  generation: number;
  role: EvolutionRole;
  tokens: number;
  cost: number;
  model_calls: number;
  reserved_model_calls: number;
  audit_details_json: string;
  model_calls_accounted: number;
  canary_accounted: number;
  canary_accepted: number | null;
  audit_accounted: number;
  runtime_accounted: number;
}

export interface BaselineValidationAdapter {
  runStep(step: BaselineValidationStep): BaselineStepResult | Promise<BaselineStepResult>;
  smokeProvider?(): ({ passed: boolean; providerText?: string; usage?: Usage; failureKind?: HarnessFailureKind }
    | Promise<{ passed: boolean; providerText?: string; usage?: Usage; failureKind?: HarnessFailureKind }>);
}

interface ValidationRow {
  experiment_id: string;
  status: BaselineValidationStatus;
  steps_json: string;
  operator_confirmed: number;
  frozen_configuration_json: string | null;
  frozen_digest: string | null;
  smoke_attempted: number;
  smoke_passed: number | null;
  smoke_usage_json: string | null;
  smoke_failure_kind: HarnessFailureKind | null;
}

export class CompatibilityFingerprintChangedError extends Error {
  constructor() { super("兼容性指纹已变化，必须新建实验或重新执行尚未启动实验的基线验收"); this.name = "CompatibilityFingerprintChangedError"; }
}

export class ControlPlaneRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS baseline_validations (
      experiment_id TEXT PRIMARY KEY, status TEXT NOT NULL, steps_json TEXT NOT NULL,
      operator_confirmed INTEGER NOT NULL, frozen_configuration_json TEXT, frozen_digest TEXT,
      smoke_attempted INTEGER NOT NULL, smoke_passed INTEGER, smoke_usage_json TEXT, smoke_failure_kind TEXT
    );`);
    const columns = new Set((this.database.prepare("PRAGMA table_info(baseline_validations)").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has("smoke_usage_json")) this.database.exec("ALTER TABLE baseline_validations ADD COLUMN smoke_usage_json TEXT");
    if (!columns.has("smoke_failure_kind")) this.database.exec("ALTER TABLE baseline_validations ADD COLUMN smoke_failure_kind TEXT");
  }

  async runBaselineValidation(
    experimentId: string,
    adapter: BaselineValidationAdapter,
    options: { smokeProvider?: boolean } = {},
  ): Promise<BaselineValidationRecord> {
    this.upsert(experimentId, "running", [], false, null, null, false, null, null, null);
    const steps: BaselineStepResult[] = [];
    for (const step of baselineValidationSteps) {
      let result: BaselineStepResult;
      try { result = await adapter.runStep(step); }
      catch (error) {
        result = { step, passed: false, diagnostics: [error instanceof Error ? error.message : "基线步骤异常"] };
      }
      if (result.step !== step) throw new Error(`基线验收步骤响应错位：期望 ${step}`);
      steps.push({ step, passed: result.passed, diagnostics: [...result.diagnostics] });
      if (!result.passed) break;
    }
    let smokeAttempted = false;
    let smokePassed: boolean | null = null;
    let smokeUsage: Usage | null = null;
    let smokeFailureKind: HarnessFailureKind | null = null;
    if (options.smokeProvider) {
      smokeAttempted = true;
      if (!adapter.smokeProvider) {
        smokePassed = false;
        smokeUsage = { tokens: 0, cost: 0, modelCalls: 0 };
      }
      else {
        try {
          const smoke = await adapter.smokeProvider();
          if (smoke.usage) assertUsage(smoke.usage);
          smokePassed = smoke.passed;
          smokeUsage = smoke.usage ?? null;
          smokeFailureKind = smoke.failureKind ?? null;
        } catch { smokePassed = false; }
      }
    }
    const status: BaselineValidationStatus = steps.length === baselineValidationSteps.length && steps.every(({ passed }) => passed)
      ? "passed"
      : "failed";
    this.upsert(experimentId, status, steps, false, null, null, smokeAttempted, smokePassed, smokeUsage, smokeFailureKind);
    return this.getBaselineValidation(experimentId)!;
  }

  confirmBaseline(experimentId: string, configuration: FrozenExperimentConfiguration): BaselineValidationRecord {
    const current = this.getBaselineValidation(experimentId);
    if (!current || current.status !== "passed" || current.steps.length !== baselineValidationSteps.length) {
      throw new Error("基线验收尚未全部通过，不能确认就绪");
    }
    const canonical = canonicalJson(configuration);
    const digest = createHash("sha256").update(canonical).digest("hex");
    this.upsert(experimentId, "ready", current.steps, true, configuration, digest,
      current.smoke.attempted, current.smoke.passed, current.smoke.usage, current.smoke.failureKind);
    return this.getBaselineValidation(experimentId)!;
  }

  rollbackBaselineConfirmation(experimentId: string): BaselineValidationRecord {
    const current = this.getBaselineValidation(experimentId);
    if (!current || current.status !== "ready") throw new Error("基线尚未确认，无需回滚");
    this.upsert(experimentId, "passed", current.steps, false, null, null,
      current.smoke.attempted, current.smoke.passed, current.smoke.usage, current.smoke.failureKind);
    return this.getBaselineValidation(experimentId)!;
  }

  requireReady(experimentId: string, currentCompatibilityFingerprint?: string): BaselineValidationRecord {
    const record = this.getBaselineValidation(experimentId);
    if (!record || record.status !== "ready" || !record.operatorConfirmed || !record.frozenConfiguration) {
      throw new Error("实验尚未通过人工监督基线验收");
    }
    if (currentCompatibilityFingerprint !== undefined
      && record.frozenConfiguration.compatibilityFingerprint !== currentCompatibilityFingerprint) {
      throw new CompatibilityFingerprintChangedError();
    }
    return record;
  }

  invalidateUnstarted(experimentId: string): void {
    const current = this.getBaselineValidation(experimentId);
    if (!current) return;
    this.upsert(experimentId, "pending", [], false, null, null, false, null, null, null);
  }

  deriveReady(sourceId: string, childId: string, overrides: Partial<FrozenExperimentConfiguration>): BaselineValidationRecord {
    const source = this.requireReady(sourceId);
    const configuration = { ...source.frozenConfiguration!, ...overrides };
    const canonical = canonicalJson(configuration);
    const digest = createHash("sha256").update(canonical).digest("hex");
    this.upsert(childId, "ready", source.steps, true, configuration, digest, false, null, null, null);
    return this.getBaselineValidation(childId)!;
  }

  getBaselineValidation(experimentId: string): BaselineValidationRecord | undefined {
    const row = this.database.prepare(`SELECT experiment_id, status, steps_json, operator_confirmed,
      frozen_configuration_json, frozen_digest, smoke_attempted, smoke_passed, smoke_usage_json, smoke_failure_kind
      FROM baseline_validations WHERE experiment_id = ?`).get(experimentId) as unknown as ValidationRow | undefined;
    if (!row) return undefined;
    return {
      experimentId: row.experiment_id,
      status: row.status,
      steps: JSON.parse(row.steps_json) as BaselineStepResult[],
      operatorConfirmed: row.operator_confirmed === 1,
      frozenConfiguration: row.frozen_configuration_json ? JSON.parse(row.frozen_configuration_json) as FrozenExperimentConfiguration : null,
      frozenDigest: row.frozen_digest,
      smoke: {
        attempted: row.smoke_attempted === 1,
        passed: row.smoke_passed === null ? null : row.smoke_passed === 1,
        usage: row.smoke_usage_json ? JSON.parse(row.smoke_usage_json) as Usage : null,
        failureKind: row.smoke_failure_kind,
      },
    };
  }

  discardDerived(experimentId: string): void {
    this.database.prepare("DELETE FROM baseline_validations WHERE experiment_id = ?").run(experimentId);
  }

  close(): void { this.database.close(); }

  private upsert(
    experimentId: string,
    status: BaselineValidationStatus,
    steps: BaselineStepResult[],
    operatorConfirmed: boolean,
    configuration: FrozenExperimentConfiguration | null,
    digest: string | null,
    smokeAttempted: boolean,
    smokePassed: boolean | null,
    smokeUsage: Usage | null,
    smokeFailureKind: HarnessFailureKind | null,
  ): void {
    this.database.prepare(`INSERT INTO baseline_validations
      (experiment_id, status, steps_json, operator_confirmed, frozen_configuration_json, frozen_digest,
       smoke_attempted, smoke_passed, smoke_usage_json, smoke_failure_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET status = excluded.status, steps_json = excluded.steps_json,
      operator_confirmed = excluded.operator_confirmed, frozen_configuration_json = excluded.frozen_configuration_json,
      frozen_digest = excluded.frozen_digest, smoke_attempted = excluded.smoke_attempted,
      smoke_passed = excluded.smoke_passed, smoke_usage_json = excluded.smoke_usage_json,
      smoke_failure_kind = excluded.smoke_failure_kind`)
      .run(experimentId, status, JSON.stringify(steps), operatorConfirmed ? 1 : 0,
        configuration ? canonicalJson(configuration) : null, digest, smokeAttempted ? 1 : 0,
        smokePassed === null ? null : smokePassed ? 1 : 0, smokeUsage ? JSON.stringify(smokeUsage) : null, smokeFailureKind);
  }
}

interface RuntimeRow {
  experiment_id: string; state: ExperimentRuntimeSnapshot["state"]; phase: string; generation: number;
  stagnation_count: number; champions_json: string; pause_requested: number; tokens_used: number; cost_used: number;
  model_calls_used: number;
  token_limit: number; cost_limit: number | null; evaluation_suite_id: string; seal_group_id: string;
  sealed: number; evolution_permitted: number; compatibility_fingerprint: string;
}

export class RuntimeStateError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeStateError"; }
}

export class ModelCallBudgetError extends RuntimeStateError {
  constructor(message: string) { super(message); this.name = "ModelCallBudgetError"; }
}

const unpublishedProviderUsageTables = [
  "generation_role_provider_attempt_receipts",
  "generation_role_provider_usage_batches",
] as const;

function assertNoUnpublishedProviderUsageSchema(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN (?, ?) ORDER BY name`).all(...unpublishedProviderUsageTables) as Array<{ name: string }>;
  if (rows.length > 0) {
    throw new RuntimeStateError(`检测到未发布的 Repair66 Provider usage 中间表：${rows.map(({ name }) => name).join(", ")}`);
  }
}

export function assertSupportedRuntimeDatabaseSchema(databasePath: string): void {
  if (databasePath === ":memory:" || !existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { assertNoUnpublishedProviderUsageSchema(database); }
  finally { database.close(); }
}

export class ExperimentRuntimeRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    assertNoUnpublishedProviderUsageSchema(this.database);
    this.database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS experiment_runtime (
      experiment_id TEXT PRIMARY KEY, state TEXT NOT NULL, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      stagnation_count INTEGER NOT NULL, champions_json TEXT NOT NULL, pause_requested INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL, cost_used REAL NOT NULL, model_calls_used INTEGER NOT NULL DEFAULT 0,
      token_limit INTEGER NOT NULL, cost_limit REAL,
      evaluation_suite_id TEXT NOT NULL, seal_group_id TEXT NOT NULL, sealed INTEGER NOT NULL,
      evolution_permitted INTEGER NOT NULL, compatibility_fingerprint TEXT NOT NULL, checkpoint_key TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_runtime_running ON experiment_runtime ((state = 'running')) WHERE state = 'running';
    CREATE TABLE IF NOT EXISTS generation_records (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, checkpoint_key TEXT NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (experiment_id, generation)
    );
    CREATE TABLE IF NOT EXISTS generation_role_checkpoints (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      attempt_id TEXT NOT NULL, result_json TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL,
      model_calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (experiment_id, generation, role), UNIQUE (experiment_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS generation_role_model_calls (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      calls_used INTEGER NOT NULL CHECK (calls_used >= 0 AND calls_used <= 8),
      PRIMARY KEY (experiment_id, generation, role)
    );
    CREATE TABLE IF NOT EXISTS generation_role_tool_calls (
      experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      calls_used INTEGER NOT NULL CHECK (calls_used >= 0 AND calls_used <= ${MAX_TOP_LEVEL_TOOL_CALLS}),
      PRIMARY KEY (experiment_id, generation, role)
    );
    CREATE TABLE IF NOT EXISTS seal_groups (
      id TEXT PRIMARY KEY, evaluation_suite_id TEXT NOT NULL UNIQUE, sealed INTEGER NOT NULL,
      secret_digest TEXT, secret_material BLOB
    );
    CREATE TABLE IF NOT EXISTS experiment_relations (
      child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, kind TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exhibitions (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, generator_commit TEXT NOT NULL,
      solver_commit TEXT NOT NULL, public_seed TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
    const sealColumns = new Set((this.database.prepare("PRAGMA table_info(seal_groups)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!sealColumns.has("secret_digest")) this.database.exec("ALTER TABLE seal_groups ADD COLUMN secret_digest TEXT");
    if (!sealColumns.has("secret_material")) this.database.exec("ALTER TABLE seal_groups ADD COLUMN secret_material BLOB");
    const generationColumns = new Set((this.database.prepare("PRAGMA table_info(generation_records)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!generationColumns.has("checkpoint_key")) {
      this.database.exec("ALTER TABLE generation_records ADD COLUMN checkpoint_key TEXT");
      this.database.exec("UPDATE generation_records SET checkpoint_key = 'legacy-' || generation WHERE checkpoint_key IS NULL");
    }
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS generation_checkpoint ON generation_records (experiment_id, checkpoint_key)");
    const runtimeColumns = new Set((this.database.prepare("PRAGMA table_info(experiment_runtime)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!runtimeColumns.has("model_calls_used")) {
      this.database.exec("ALTER TABLE experiment_runtime ADD COLUMN model_calls_used INTEGER NOT NULL DEFAULT 0");
    }
    const checkpointColumns = new Set((this.database.prepare("PRAGMA table_info(generation_role_checkpoints)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!checkpointColumns.has("model_calls")) {
      this.database.exec("ALTER TABLE generation_role_checkpoints ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0");
    }
    this.migrateTopLevelToolCallBudget();
    this.migrateProviderUsageOutbox();
  }

  /** 将旧版六次工具额度表原子迁移到七次，保留已有 generation/role 账本。 */
  private migrateTopLevelToolCallBudget(): void {
    const table = this.database.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'generation_role_tool_calls'`).get() as { sql?: string } | undefined;
    if (!table?.sql || table.sql.includes(`<= ${MAX_TOP_LEVEL_TOOL_CALLS}`)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("ALTER TABLE generation_role_tool_calls RENAME TO generation_role_tool_calls_legacy");
      this.database.exec(`CREATE TABLE generation_role_tool_calls (
        experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
        calls_used INTEGER NOT NULL CHECK (calls_used >= 0 AND calls_used <= ${MAX_TOP_LEVEL_TOOL_CALLS}),
        PRIMARY KEY (experiment_id, generation, role)
      )`);
      this.database.exec(`INSERT INTO generation_role_tool_calls (experiment_id, generation, role, calls_used)
        SELECT experiment_id, generation, role, calls_used FROM generation_role_tool_calls_legacy`);
      this.database.exec("DROP TABLE generation_role_tool_calls_legacy");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateProviderUsageOutbox(): void {
    const tableExists = (name: string): boolean => Boolean(this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    const columns = (name: string): Set<string> => new Set((this.database.prepare(`PRAGMA table_info(${name})`)
      .all() as Array<{ name: string }>).map(({ name: column }) => column));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const legacyAttempts = tableExists("generation_role_provider_attempts")
        && !columns("generation_role_provider_attempts").has("invocation_id");
      if (legacyAttempts) {
        this.database.exec(`CREATE TABLE generation_role_provider_attempts_v2 (
          reservation_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
          reserved_cost REAL NOT NULL CHECK (reserved_cost > 0), invocation_id TEXT NOT NULL,
          reserved_model_calls INTEGER NOT NULL CHECK (reserved_model_calls >= 1 AND reserved_model_calls <= 8),
          audit_details_json TEXT NOT NULL
        )`);
      } else {
        this.database.exec(`CREATE TABLE IF NOT EXISTS generation_role_provider_attempts (
          reservation_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
          reserved_cost REAL NOT NULL CHECK (reserved_cost > 0), invocation_id TEXT NOT NULL,
          reserved_model_calls INTEGER NOT NULL CHECK (reserved_model_calls >= 1 AND reserved_model_calls <= 8),
          audit_details_json TEXT NOT NULL
        )`);
      }
      this.database.exec(`CREATE TABLE IF NOT EXISTS generation_role_provider_usage_items (
        item_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE, invocation_id TEXT NOT NULL,
        experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK (tokens >= 0), cost REAL NOT NULL CHECK (cost >= 0),
        model_calls INTEGER NOT NULL CHECK (model_calls = 1),
        reserved_model_calls INTEGER NOT NULL CHECK (reserved_model_calls >= 1 AND reserved_model_calls <= 8),
        audit_details_json TEXT NOT NULL, model_calls_accounted INTEGER NOT NULL DEFAULT 0,
        canary_accounted INTEGER NOT NULL DEFAULT 0, canary_accepted INTEGER,
        audit_accounted INTEGER NOT NULL DEFAULT 0, runtime_accounted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS generation_role_provider_model_call_receipts (
        invocation_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
        reserved_model_calls INTEGER NOT NULL, used_model_calls INTEGER NOT NULL
      )`);

      if (legacyAttempts) {
        const attemptColumns = columns("generation_role_provider_attempts");
        const invocationId = attemptColumns.has("batch_id") ? "COALESCE(batch_id, reservation_id)" : "reservation_id";
        const reservedModelCalls = attemptColumns.has("reserved_model_calls")
          ? "COALESCE(reserved_model_calls, 1)" : "1";
        const auditDetails = attemptColumns.has("audit_details_json")
          ? "COALESCE(audit_details_json, '{}')" : "'{}'";
        if (attemptColumns.has("actual_tokens") && attemptColumns.has("actual_cost")) {
          this.database.exec(`INSERT OR IGNORE INTO generation_role_provider_usage_items (
            item_id, reservation_id, invocation_id, experiment_id, generation, role, tokens, cost, model_calls,
            reserved_model_calls, audit_details_json
          ) SELECT reservation_id, reservation_id, ${invocationId}, experiment_id, generation, role,
            actual_tokens, actual_cost, 1, ${reservedModelCalls}, ${auditDetails} FROM generation_role_provider_attempts
            WHERE actual_tokens IS NOT NULL AND actual_cost IS NOT NULL`);
        }
        this.database.exec(`INSERT INTO generation_role_provider_attempts_v2
          (reservation_id, experiment_id, generation, role, reserved_tokens, reserved_cost, invocation_id,
            reserved_model_calls, audit_details_json)
          SELECT reservation_id, experiment_id, generation, role, reserved_tokens, reserved_cost,
            ${invocationId}, ${reservedModelCalls}, ${auditDetails} FROM generation_role_provider_attempts
          WHERE actual_tokens IS NULL AND actual_cost IS NULL`);
        this.database.exec(`DROP TABLE generation_role_provider_attempts;
          ALTER TABLE generation_role_provider_attempts_v2 RENAME TO generation_role_provider_attempts`);
      }
      this.database.exec(`CREATE INDEX IF NOT EXISTS generation_role_provider_attempt_owner
        ON generation_role_provider_attempts (experiment_id, generation, role);
        CREATE INDEX IF NOT EXISTS provider_usage_items_by_role
        ON generation_role_provider_usage_items (experiment_id, generation, role, runtime_accounted);
        CREATE INDEX IF NOT EXISTS provider_usage_items_by_invocation
        ON generation_role_provider_usage_items (invocation_id, model_calls_accounted)`);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  registerReady(input: {
    experimentId: string; champions: Record<EvolutionRole, string>; tokenLimit: number; costLimit?: number;
    compatibilityFingerprint: string; evaluationSuiteId?: string;
  }): ExperimentRuntimeSnapshot {
    const suite = input.evaluationSuiteId ?? randomUUID();
    const group = randomUUID();
    const secret = randomBytes(32);
    const secretDigest = createHash("sha256").update(secret).digest("hex");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO seal_groups (id, evaluation_suite_id, sealed, secret_digest, secret_material) VALUES (?, ?, 1, ?, ?)").run(group, suite, secretDigest, secret);
      this.database.prepare(`INSERT INTO experiment_runtime (
        experiment_id, state, phase, generation, stagnation_count, champions_json, pause_requested,
        tokens_used, cost_used, token_limit, cost_limit, evaluation_suite_id, seal_group_id,
        sealed, evolution_permitted, compatibility_fingerprint, checkpoint_key
      ) VALUES (?, 'ready', 'ready', 0, 0, ?, 0, 0, 0, ?, ?, ?, ?, 1, 1, ?, NULL)`)
        .run(input.experimentId, JSON.stringify(input.champions), input.tokenLimit, input.costLimit ?? null,
          suite, group, input.compatibilityFingerprint);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(input.experimentId)!;
  }

  start(experimentId: string): ExperimentRuntimeSnapshot {
    const current = this.require(experimentId);
    if (!current.evolutionPermitted || !current.sealed) throw new RuntimeStateError("实验已解封，永久禁止继续进化");
    if (!(["ready", "paused"] as const).includes(current.state as "ready" | "paused")) throw new RuntimeStateError(`状态 ${current.state} 不允许启动或恢复`);
    try {
      this.database.prepare("UPDATE experiment_runtime SET state = 'running', phase = 'generation.snapshot', pause_requested = 0 WHERE experiment_id = ?").run(experimentId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) throw new RuntimeStateError("当前 Arena 已有运行中的实验");
      throw error;
    }
    return this.get(experimentId)!;
  }

  requestPause(experimentId: string): ExperimentRuntimeSnapshot {
    const current = this.require(experimentId);
    if (current.state !== "running") throw new RuntimeStateError("仅运行中的实验可以请求安全暂停");
    this.database.prepare("UPDATE experiment_runtime SET pause_requested = 1 WHERE experiment_id = ?").run(experimentId);
    return this.get(experimentId)!;
  }

  completeRequestedPause(experimentId: string): ExperimentRuntimeSnapshot {
    const current = this.require(experimentId);
    if (current.state !== "running" || !current.pauseRequested) {
      throw new RuntimeStateError("实验没有待完成的安全暂停请求");
    }
    this.database.prepare("UPDATE experiment_runtime SET state = 'paused', phase = 'paused', pause_requested = 0 WHERE experiment_id = ?")
      .run(experimentId);
    return this.get(experimentId)!;
  }

  cancel(experimentId: string): ExperimentRuntimeSnapshot {
    const current = this.require(experimentId);
    if (["completed", "cancelled"].includes(current.state)) throw new RuntimeStateError("终态实验不能再次终止");
    this.database.prepare("UPDATE experiment_runtime SET state = 'cancelled', phase = 'cancelled', pause_requested = 0 WHERE experiment_id = ?").run(experimentId);
    return this.get(experimentId)!;
  }

  fail(experimentId: string, reason: string): ExperimentRuntimeSnapshot {
    const current = this.require(experimentId);
    if (["completed", "cancelled"].includes(current.state)) throw new RuntimeStateError("终态实验不能标记失败");
    this.database.prepare("UPDATE experiment_runtime SET state = 'failed', phase = ?, pause_requested = 0 WHERE experiment_id = ?")
      .run(`failed:${reason.slice(0, 200)}`, experimentId);
    return this.get(experimentId)!;
  }

  recordUsage(experimentId: string, tokens: number, cost = 0, modelCalls = 0): ExperimentRuntimeSnapshot {
    assertUsage({ tokens, cost, modelCalls });
    this.database.prepare(`UPDATE experiment_runtime SET tokens_used = tokens_used + ?, cost_used = cost_used + ?,
      model_calls_used = model_calls_used + ? WHERE experiment_id = ?`).run(tokens, cost, modelCalls, experimentId);
    const current = this.require(experimentId);
    if (current.usage.tokens >= current.budget.tokenLimit
      || (current.budget.costLimit !== null && current.usage.cost >= current.budget.costLimit)) {
      this.database.prepare("UPDATE experiment_runtime SET pause_requested = 1, phase = 'budget-boundary' WHERE experiment_id = ?").run(experimentId);
    }
    return this.get(experimentId)!;
  }

  reserveRemainingModelCalls(
    experimentId: string,
    generation: number,
    role: EvolutionRole,
    minimumRequired = 1,
    maximumAllowed = 8,
  ): number {
    if (!Number.isSafeInteger(minimumRequired) || minimumRequired < 1 || minimumRequired > 8) {
      throw new Error("模型调用最小收尾额度非法");
    }
    if (!Number.isSafeInteger(maximumAllowed) || maximumAllowed < minimumRequired || maximumAllowed > 8) {
      throw new Error("模型调用单 Session 预留额度非法");
    }
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("模型调用代次非法");
    this.require(experimentId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO generation_role_model_calls (experiment_id, generation, role, calls_used)
        VALUES (?, ?, ?, 0) ON CONFLICT (experiment_id, generation, role) DO NOTHING`).run(experimentId, generation, role);
      const row = this.database.prepare(`SELECT calls_used FROM generation_role_model_calls
        WHERE experiment_id = ? AND generation = ? AND role = ?`).get(experimentId, generation, role) as { calls_used: number };
      const remaining = 8 - row.calls_used;
      if (remaining <= 0) throw new ModelCallBudgetError("父 Harness Session 的八次模型调用额度已耗尽");
      if (remaining < minimumRequired) {
        throw new ModelCallBudgetError(`父 Harness Session 剩余模型调用额度不足以完成最小收尾：需要至少 ${minimumRequired} 次，当前仅剩 ${remaining} 次`);
      }
      const reserved = Math.min(remaining, maximumAllowed);
      this.database.prepare(`UPDATE generation_role_model_calls SET calls_used = calls_used + ?
        WHERE experiment_id = ? AND generation = ? AND role = ?`).run(reserved, experimentId, generation, role);
      this.database.exec("COMMIT");
      return reserved;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  settleModelCallReservation(input: {
    experimentId: string; generation: number; role: EvolutionRole; reserved: number; used: number;
  }): void {
    if (!Number.isSafeInteger(input.reserved) || input.reserved < 1 || input.reserved > 8
      || !Number.isSafeInteger(input.used) || input.used < 0 || input.used > input.reserved) {
      throw new Error("模型调用预留结算字段非法");
    }
    const changed = this.database.prepare(`UPDATE generation_role_model_calls
      SET calls_used = calls_used - ? WHERE experiment_id = ? AND generation = ? AND role = ?
      AND calls_used >= ?`).run(input.reserved - input.used, input.experimentId, input.generation, input.role, input.reserved);
    if (changed.changes !== 1) throw new RuntimeStateError("模型调用预留状态冲突");
  }

  reserveProviderAttempt(input: {
    experimentId: string; generation: number; role: EvolutionRole; tokens: number; cost: number;
    invocationId: string; reservedModelCalls: number; auditDetails: Record<string, unknown>;
    availableTokens?: number; availableCost?: number;
  }): string {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1
      || !Number.isSafeInteger(input.tokens) || input.tokens < 1
      || !Number.isFinite(input.cost) || input.cost <= 0
      || !/^[0-9a-f]{64}$/.test(input.invocationId)
      || !Number.isSafeInteger(input.reservedModelCalls) || input.reservedModelCalls < 1 || input.reservedModelCalls > 8
      || (input.availableTokens !== undefined
        && (!Number.isSafeInteger(input.availableTokens) || input.availableTokens < 0))
      || (input.availableCost !== undefined
        && (!Number.isFinite(input.availableCost) || input.availableCost < 0))) {
      throw new Error("Provider attempt 预留字段非法");
    }
    const reservationId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const runtime = this.require(input.experimentId);
      const charged = this.database.prepare(`SELECT
        (SELECT COALESCE(SUM(reserved_tokens), 0)
          FROM generation_role_provider_attempts WHERE experiment_id = ?) +
        (SELECT COALESCE(SUM(tokens), 0) FROM generation_role_provider_usage_items
          WHERE experiment_id = ? AND ${input.availableTokens === undefined ? "runtime_accounted" : "canary_accounted"} = 0) AS tokens,
        (SELECT COALESCE(SUM(reserved_cost), 0)
          FROM generation_role_provider_attempts WHERE experiment_id = ?) +
        (SELECT COALESCE(SUM(cost), 0) FROM generation_role_provider_usage_items
          WHERE experiment_id = ? AND ${input.availableCost === undefined ? "runtime_accounted" : "canary_accounted"} = 0) AS cost`)
        .get(input.experimentId, input.experimentId, input.experimentId, input.experimentId) as { tokens: number; cost: number };
      const availableTokens = input.availableTokens ?? runtime.budget.tokenLimit - runtime.usage.tokens;
      const availableCost = input.availableCost ?? (runtime.budget.costLimit === null
        ? Number.MAX_VALUE : runtime.budget.costLimit - runtime.usage.cost);
      if (charged.tokens + input.tokens > availableTokens
        || charged.cost + input.cost > availableCost + 1e-12) {
        throw new RuntimeStateError("父角色 Provider attempt 保守预算不足");
      }
      const owner = this.database.prepare(`SELECT experiment_id, generation, role, reserved_model_calls
        FROM generation_role_provider_attempts WHERE invocation_id = ? UNION ALL
        SELECT experiment_id, generation, role, reserved_model_calls
        FROM generation_role_provider_usage_items WHERE invocation_id = ? LIMIT 1`)
        .get(input.invocationId, input.invocationId) as {
          experiment_id: string; generation: number; role: EvolutionRole; reserved_model_calls: number;
        } | undefined;
      const auditDetailsJson = JSON.stringify(input.auditDetails);
      if (owner && (owner.experiment_id !== input.experimentId || owner.generation !== input.generation
        || owner.role !== input.role || owner.reserved_model_calls !== input.reservedModelCalls)) {
        throw new RuntimeStateError("Provider invocation owner 冲突");
      }
      const usage = this.database.prepare(`SELECT
        (SELECT COUNT(*) FROM generation_role_provider_attempts WHERE invocation_id = ?) +
        (SELECT COUNT(*) FROM generation_role_provider_usage_items WHERE invocation_id = ?) AS calls,
        EXISTS (SELECT 1 FROM generation_role_provider_model_call_receipts WHERE invocation_id = ?) AS closed`)
        .get(input.invocationId, input.invocationId, input.invocationId) as { calls: number; closed: number };
      if (usage.closed === 1) throw new RuntimeStateError("Provider invocation 模型调用预留已结算");
      if (usage.calls >= input.reservedModelCalls) throw new RuntimeStateError("Provider invocation 模型调用预留已耗尽");
      this.database.prepare(`INSERT INTO generation_role_provider_attempts
        (reservation_id, experiment_id, generation, role, reserved_tokens, reserved_cost,
          invocation_id, reserved_model_calls, audit_details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        reservationId, input.experimentId, input.generation, input.role, input.tokens, input.cost,
        input.invocationId, input.reservedModelCalls, auditDetailsJson,
      );
      this.database.exec("COMMIT");
      return reservationId;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  settleProviderAttempt(input: { reservationId: string; tokens: number; cost: number }): ProviderUsageItem {
    if (!input.reservationId || !Number.isSafeInteger(input.tokens) || input.tokens < 0
      || !Number.isFinite(input.cost) || input.cost < 0) throw new Error("Provider attempt 结算字段非法");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getProviderUsageItemByReservation(input.reservationId);
      if (existing) {
        if (existing.tokens !== input.tokens || Math.abs(existing.cost - input.cost) > 1e-12) {
          throw new RuntimeStateError("Provider attempt 幂等结算载荷冲突");
        }
        this.database.exec("COMMIT");
        return existing;
      }
      const attempt = this.database.prepare(`SELECT experiment_id, generation, role, reserved_tokens, reserved_cost,
        invocation_id, reserved_model_calls, audit_details_json FROM generation_role_provider_attempts
        WHERE reservation_id = ?`).get(input.reservationId) as {
          experiment_id: string; generation: number; role: EvolutionRole; reserved_tokens: number; reserved_cost: number;
          invocation_id: string; reserved_model_calls: number; audit_details_json: string;
        } | undefined;
      if (!attempt || attempt.reserved_tokens < input.tokens || attempt.reserved_cost + 1e-12 < input.cost
        || !attempt.invocation_id || !attempt.audit_details_json) {
        throw new RuntimeStateError("Provider attempt 预留结算冲突");
      }
      this.database.prepare(`INSERT INTO generation_role_provider_usage_items (
        item_id, reservation_id, invocation_id, experiment_id, generation, role, tokens, cost, model_calls,
        reserved_model_calls, audit_details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        input.reservationId, input.reservationId, attempt.invocation_id, attempt.experiment_id,
        attempt.generation, attempt.role, input.tokens, input.cost, attempt.reserved_model_calls,
        attempt.audit_details_json,
      );
      this.database.prepare("DELETE FROM generation_role_provider_attempts WHERE reservation_id = ?")
        .run(input.reservationId);
      this.database.exec("COMMIT");
      return this.getProviderUsageItem(input.reservationId)!;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  reserveTopLevelToolCall(experimentId: string, generation: number, role: EvolutionRole): boolean {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("工具调用代次非法");
    this.require(experimentId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO generation_role_tool_calls (experiment_id, generation, role, calls_used)
        VALUES (?, ?, ?, 0) ON CONFLICT (experiment_id, generation, role) DO NOTHING`)
        .run(experimentId, generation, role);
      const changed = this.database.prepare(`UPDATE generation_role_tool_calls SET calls_used = calls_used + 1
        WHERE experiment_id = ? AND generation = ? AND role = ? AND calls_used < ${MAX_TOP_LEVEL_TOOL_CALLS}`)
        .run(experimentId, generation, role);
      this.database.exec("COMMIT");
      return changed.changes === 1;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  listPendingProviderUsageItems(experimentId: string, generation: number, role: EvolutionRole): ProviderUsageItem[] {
    return (this.database.prepare(`SELECT * FROM generation_role_provider_usage_items
      WHERE experiment_id = ? AND generation = ? AND role = ?
      AND (model_calls_accounted = 0 OR canary_accounted = 0 OR audit_accounted = 0 OR runtime_accounted = 0)
      ORDER BY rowid`)
      .all(experimentId, generation, role) as unknown as ProviderUsageItemRow[]).map(providerUsageItem);
  }

  getProviderInvocationUsage(invocationId: string): Usage | undefined {
    const row = this.database.prepare(`SELECT COALESCE(SUM(tokens), 0) AS tokens,
      COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS model_calls, COUNT(*) AS items
      FROM generation_role_provider_usage_items WHERE invocation_id = ?`).get(invocationId) as {
        tokens: number; cost: number; model_calls: number; items: number;
      };
    return row.items === 0 ? undefined : { tokens: row.tokens, cost: row.cost, modelCalls: row.model_calls };
  }

  accountProviderUsageItemModelCalls(itemId: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.requireProviderUsageItem(itemId);
      if (row.model_calls_accounted === 1) { this.database.exec("COMMIT"); return true; }
      const pending = this.database.prepare(`SELECT COUNT(*) AS count FROM generation_role_provider_attempts
        WHERE invocation_id = ?`).get(row.invocation_id) as { count: number };
      if (pending.count === 0) {
        const used = this.database.prepare(`SELECT COUNT(*) AS count FROM generation_role_provider_usage_items
          WHERE invocation_id = ?`).get(row.invocation_id) as { count: number };
        const receipt = this.database.prepare(`SELECT reserved_model_calls, used_model_calls
          FROM generation_role_provider_model_call_receipts WHERE invocation_id = ?`).get(row.invocation_id) as {
            reserved_model_calls: number; used_model_calls: number;
          } | undefined;
        if (receipt) {
          if (receipt.reserved_model_calls !== row.reserved_model_calls || receipt.used_model_calls !== used.count) {
            throw new RuntimeStateError("Provider invocation 模型调用结算 receipt 冲突");
          }
        } else {
          const changed = this.database.prepare(`UPDATE generation_role_model_calls SET calls_used = calls_used - ?
            WHERE experiment_id = ? AND generation = ? AND role = ? AND calls_used >= ?`).run(
            row.reserved_model_calls - used.count, row.experiment_id, row.generation, row.role, row.reserved_model_calls,
          );
          if (changed.changes !== 1) throw new RuntimeStateError("Provider invocation 模型调用预留状态冲突");
          this.database.prepare(`INSERT INTO generation_role_provider_model_call_receipts
            (invocation_id, experiment_id, generation, role, reserved_model_calls, used_model_calls)
            VALUES (?, ?, ?, ?, ?, ?)`).run(row.invocation_id, row.experiment_id, row.generation, row.role,
            row.reserved_model_calls, used.count);
        }
      }
      this.database.prepare(`UPDATE generation_role_provider_usage_items SET model_calls_accounted = 1
        WHERE item_id = ?`).run(itemId);
      this.database.exec("COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  markProviderUsageItemCanaryAccounted(itemId: string, accepted: boolean): void {
    const changed = this.database.prepare(`UPDATE generation_role_provider_usage_items
      SET canary_accounted = 1, canary_accepted = ? WHERE item_id = ?
      AND (canary_accounted = 0 OR canary_accepted = ?)`).run(accepted ? 1 : 0, itemId, accepted ? 1 : 0);
    if (changed.changes === 1) return;
    const existing = this.requireProviderUsageItem(itemId);
    if (existing.canary_accounted !== 1 || existing.canary_accepted !== (accepted ? 1 : 0)) {
      throw new RuntimeStateError("Provider usage item 金丝雀确认冲突");
    }
  }

  markProviderUsageItemAuditAccounted(itemId: string): void {
    this.markProviderUsageItemAccounted(itemId, "audit_accounted");
  }

  accountProviderUsageItemRuntime(itemId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const item = this.requireProviderUsageItem(itemId);
      if (item.runtime_accounted === 1) { this.database.exec("COMMIT"); return; }
      const runtime = this.database.prepare(`UPDATE experiment_runtime
        SET tokens_used = tokens_used + ?, cost_used = cost_used + ?, model_calls_used = model_calls_used + ?
        WHERE experiment_id = ?`).run(item.tokens, item.cost, item.model_calls, item.experiment_id);
      if (runtime.changes !== 1) throw new RuntimeStateError("Provider usage item 缺少所属运行时");
      this.database.prepare(`UPDATE generation_role_checkpoints
        SET tokens = tokens + ?, cost = cost + ?, model_calls = model_calls + ?
        WHERE experiment_id = ? AND generation = ? AND role = ?`).run(
        item.tokens, item.cost, item.model_calls, item.experiment_id, item.generation, item.role,
      );
      this.database.prepare(`UPDATE generation_role_provider_usage_items SET runtime_accounted = 1
        WHERE item_id = ?`).run(itemId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private markProviderUsageItemAccounted(itemId: string, column: "audit_accounted"): void {
    const changed = this.database.prepare(`UPDATE generation_role_provider_usage_items SET ${column} = 1
      WHERE item_id = ?`).run(itemId);
    if (changed.changes !== 1) throw new RuntimeStateError("Provider usage item 不存在");
  }

  private getProviderUsageItem(itemId: string): ProviderUsageItem | undefined {
    const row = this.database.prepare("SELECT * FROM generation_role_provider_usage_items WHERE item_id = ?")
      .get(itemId) as unknown as ProviderUsageItemRow | undefined;
    return row ? providerUsageItem(row) : undefined;
  }

  private getProviderUsageItemByReservation(reservationId: string): ProviderUsageItem | undefined {
    const row = this.database.prepare("SELECT * FROM generation_role_provider_usage_items WHERE reservation_id = ?")
      .get(reservationId) as unknown as ProviderUsageItemRow | undefined;
    return row ? providerUsageItem(row) : undefined;
  }

  private requireProviderUsageItem(itemId: string): ProviderUsageItemRow {
    const row = this.database.prepare("SELECT * FROM generation_role_provider_usage_items WHERE item_id = ?")
      .get(itemId) as unknown as ProviderUsageItemRow | undefined;
    if (!row) throw new RuntimeStateError("Provider usage item 不存在");
    return row;
  }

  private providerUsage(experimentId: string, generation: number, role: EvolutionRole): Usage & { items: number } {
    const row = this.database.prepare(`SELECT COALESCE(SUM(tokens), 0) AS tokens,
      COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(model_calls), 0) AS model_calls, COUNT(*) AS items
      FROM generation_role_provider_usage_items WHERE experiment_id = ? AND generation = ? AND role = ?`)
      .get(experimentId, generation, role) as {
        tokens: number; cost: number; model_calls: number; items: number;
      };
    return { tokens: row.tokens, cost: row.cost, modelCalls: row.model_calls, items: row.items };
  }

  recordRoleFailureUsage(input: {
    experimentId: string; generation: number; role: EvolutionRole; tokens: number; cost: number; modelCalls?: number;
  }): ExperimentRuntimeSnapshot {
    const usage = { tokens: input.tokens, cost: input.cost, modelCalls: input.modelCalls ?? 0 };
    assertUsage(usage);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const provider = this.providerUsage(input.experimentId, input.generation, input.role);
      if (provider.items === 0) this.database.prepare(`UPDATE experiment_runtime
        SET tokens_used = tokens_used + ?, cost_used = cost_used + ?, model_calls_used = model_calls_used + ?
        WHERE experiment_id = ?`).run(usage.tokens, usage.cost, usage.modelCalls, input.experimentId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(input.experimentId)!;
  }

  saveRoleCheckpoint(input: {
    experimentId: string; generation: number; role: EvolutionRole; attemptId: string;
    result: GenerationRoleResult; tokens: number; cost: number; modelCalls?: number;
  }): void {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("角色检查点字段非法");
    const usage = { tokens: input.tokens, cost: input.cost, modelCalls: input.modelCalls ?? 0 };
    assertUsage(usage);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getRoleCheckpoint(input.experimentId, input.generation, input.role);
      if (!existing) {
        const provider = this.providerUsage(input.experimentId, input.generation, input.role);
        const effective = provider.items > 0 ? provider : usage;
        this.database.prepare(`INSERT INTO generation_role_checkpoints
          (experiment_id, generation, role, attempt_id, result_json, tokens, cost, model_calls)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.experimentId, input.generation, input.role, input.attemptId, JSON.stringify(input.result),
            effective.tokens, effective.cost, effective.modelCalls);
        if (provider.items === 0) this.database.prepare(`UPDATE experiment_runtime
          SET tokens_used = tokens_used + ?, cost_used = cost_used + ?, model_calls_used = model_calls_used + ?, phase = ?
          WHERE experiment_id = ?`).run(effective.tokens, effective.cost, effective.modelCalls,
          `generation.${input.generation}.${input.role}.complete`, input.experimentId);
        else this.database.prepare("UPDATE experiment_runtime SET phase = ? WHERE experiment_id = ?")
          .run(`generation.${input.generation}.${input.role}.complete`, input.experimentId);
      } else if (existing.attemptId !== input.attemptId || JSON.stringify(existing.result) !== JSON.stringify(input.result)) {
        throw new RuntimeStateError("角色检查点与既有原子结果冲突");
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getRoleCheckpoint(experimentId: string, generation: number, role: EvolutionRole): {
    attemptId: string; result: GenerationRoleResult; tokens: number; cost: number; modelCalls: number;
  } | undefined {
    const row = this.database.prepare(`SELECT attempt_id, result_json, tokens, cost, model_calls
      FROM generation_role_checkpoints WHERE experiment_id = ? AND generation = ? AND role = ?`)
      .get(experimentId, generation, role) as { attempt_id: string; result_json: string; tokens: number; cost: number; model_calls: number } | undefined;
    return row ? { attemptId: row.attempt_id, result: JSON.parse(row.result_json) as GenerationRoleResult,
      tokens: row.tokens, cost: row.cost, modelCalls: row.model_calls } : undefined;
  }

  listRoleCheckpoints(experimentId: string, role: EvolutionRole, beforeGeneration: number): Array<{
    generation: number; attemptId: string; result: GenerationRoleResult;
  }> {
    if (!Number.isSafeInteger(beforeGeneration) || beforeGeneration < 1) throw new Error("反馈代次边界非法");
    const rows = this.database.prepare(`SELECT generation, attempt_id, result_json
      FROM generation_role_checkpoints
      WHERE experiment_id = ? AND role = ? AND generation < ? ORDER BY generation`)
      .all(experimentId, role, beforeGeneration) as Array<{ generation: number; attempt_id: string; result_json: string }>;
    return rows.map((row) => ({
      generation: row.generation,
      attemptId: row.attempt_id,
      result: JSON.parse(row.result_json) as GenerationRoleResult,
    }));
  }

  running(): ExperimentRuntimeSnapshot[] {
    const rows = this.database.prepare("SELECT experiment_id FROM experiment_runtime WHERE state = 'running'").all() as Array<{ experiment_id: string }>;
    return rows.map(({ experiment_id }) => this.get(experiment_id)!).filter(Boolean);
  }

  list(): ExperimentRuntimeSnapshot[] {
    const rows = this.database.prepare("SELECT * FROM experiment_runtime ORDER BY experiment_id").all() as unknown as RuntimeRow[];
    return rows.map((row) => this.toSnapshot(row));
  }

  commitGeneration(input: {
    experimentId: string; generator: GenerationRoleResult; solver: GenerationRoleResult;
    exhibitionMatchId?: string; checkpointKey: string;
  }): ExperimentRuntimeSnapshot {
    const current = this.require(input.experimentId);
    if (current.state !== "running") throw new RuntimeStateError("仅运行中的实验可以提交进化代");
    const existing = this.database.prepare("SELECT record_json FROM generation_records WHERE experiment_id = ? AND checkpoint_key = ?")
      .get(input.experimentId, input.checkpointKey) as { record_json: string } | undefined;
    if (existing) return this.get(input.experimentId)!;
    const generation = current.generation + 1;
    const promoted = input.generator.outcome === "promoted" || input.solver.outcome === "promoted";
    const stagnation = promoted ? 0 : current.stagnationCount + 1;
    const record: GenerationRecord = {
      generation, status: "completed", generator: input.generator, solver: input.solver,
      exhibitionMatchId: input.exhibitionMatchId ?? null, stagnationCount: stagnation,
    };
    const shouldComplete = stagnation >= 5 || generation >= 20;
    const shouldPause = current.pauseRequested
      || current.usage.tokens >= current.budget.tokenLimit
      || (current.budget.costLimit !== null && current.usage.cost >= current.budget.costLimit);
    const state = shouldComplete ? "completed" : shouldPause ? "paused" : "running";
    const phase = shouldComplete ? "completed" : shouldPause ? "paused" : "generation.snapshot";
    const champions = { generator: input.generator.championAfter, solver: input.solver.championAfter };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO generation_records (experiment_id, generation, checkpoint_key, record_json) VALUES (?, ?, ?, ?)")
        .run(input.experimentId, generation, input.checkpointKey, JSON.stringify(record));
      this.database.prepare(`UPDATE experiment_runtime SET generation = ?, stagnation_count = ?, champions_json = ?,
        state = ?, phase = ?, pause_requested = 0, checkpoint_key = ? WHERE experiment_id = ?`)
        .run(generation, stagnation, JSON.stringify(champions), state, phase, input.checkpointKey, input.experimentId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(input.experimentId)!;
  }

  recordInfrastructureFailure(experimentId: string, diagnostics: string): ExperimentRuntimeSnapshot {
    this.require(experimentId);
    this.database.prepare("UPDATE experiment_runtime SET state = 'paused', phase = ?, pause_requested = 0 WHERE experiment_id = ?")
      .run(`infrastructure-failed:${diagnostics.slice(0, 200)}`, experimentId);
    return this.get(experimentId)!;
  }

  cloneComparison(
    sourceId: string,
    childId: string,
    compatibilityFingerprint: string,
    budget?: ExperimentRuntimeSnapshot["budget"],
    champions?: Record<EvolutionRole, string>,
  ): ExperimentRuntimeSnapshot {
    const source = this.require(sourceId);
    if (source.compatibilityFingerprint !== compatibilityFingerprint) throw new RuntimeStateError("比较克隆必须使用相同兼容性指纹");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertDerived({ ...source, budget: budget ?? source.budget, champions: champions ?? source.champions },
        childId, source.evaluationSuiteId, source.sealGroupId,
        source.sealed, source.evolutionPermitted, compatibilityFingerprint);
      this.database.prepare("INSERT INTO experiment_relations (child_id, parent_id, kind) VALUES (?, ?, 'comparison-clone')").run(childId, sourceId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(childId)!;
  }

  forkContinuation(
    sourceId: string,
    childId: string,
    compatibilityFingerprint: string,
    champions?: Record<EvolutionRole, string>,
    budget?: ExperimentRuntimeSnapshot["budget"],
  ): ExperimentRuntimeSnapshot {
    const source = this.require(sourceId);
    const suite = randomUUID();
    const group = randomUUID();
    const secret = randomBytes(32);
    const secretDigest = createHash("sha256").update(secret).digest("hex");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO seal_groups (id, evaluation_suite_id, sealed, secret_digest, secret_material) VALUES (?, ?, 1, ?, ?)").run(group, suite, secretDigest, secret);
      this.insertDerived({ ...source, champions: champions ?? source.champions, budget: budget ?? source.budget },
        childId, suite, group, true, true, compatibilityFingerprint);
      this.database.prepare("INSERT INTO experiment_relations (child_id, parent_id, kind) VALUES (?, ?, 'continuation-fork')").run(childId, sourceId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.get(childId)!;
  }

  deriveHiddenSeed(experimentId: string, generation: number, caseId: string): string {
    if (!Number.isSafeInteger(generation) || generation < 1 || !caseId) throw new Error("隐藏种子坐标非法");
    const snapshot = this.require(experimentId);
    const row = this.database.prepare("SELECT secret_material FROM seal_groups WHERE id = ?")
      .get(snapshot.sealGroupId) as { secret_material: Uint8Array | null } | undefined;
    if (!row?.secret_material) throw new RuntimeStateError("密封组缺少可用隐藏主秘密");
    return createHmac("sha256", Buffer.from(row.secret_material))
      .update(`${snapshot.evaluationSuiteId}:${generation}:${caseId}`).digest("hex");
  }

  unsealGroup(experimentId: string): ExperimentRuntimeSnapshot[] {
    const source = this.require(experimentId);
    const rows = this.database.prepare("SELECT state FROM experiment_runtime WHERE seal_group_id = ?").all(source.sealGroupId) as Array<{ state: string }>;
    if (rows.some(({ state }) => state === "running")) throw new RuntimeStateError("密封组仍有运行中的实验，不能解封");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE seal_groups SET sealed = 0 WHERE id = ?").run(source.sealGroupId);
      this.database.prepare("UPDATE experiment_runtime SET sealed = 0, evolution_permitted = 0 WHERE seal_group_id = ?").run(source.sealGroupId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.listGroup(source.sealGroupId);
  }

  createExhibition(input: { experimentId: string; generatorCommit: string; solverCommit: string; publicSeed: string }): string {
    if (!input.publicSeed || input.publicSeed.length > 200) throw new Error("展示局必须提供不超过 200 字符的公开种子");
    this.require(input.experimentId);
    const id = randomUUID();
    this.database.prepare(`INSERT INTO exhibitions (id, experiment_id, generator_commit, solver_commit, public_seed, created_at)
      VALUES (?, ?, ?, ?, ?, ?)` ).run(id, input.experimentId, input.generatorCommit, input.solverCommit, input.publicSeed, new Date().toISOString());
    return id;
  }

  discardExhibition(id: string): void {
    this.database.prepare("DELETE FROM exhibitions WHERE id = ?").run(id);
  }

  isRetainedChampion(experimentId: string, role: EvolutionRole, commit: string): boolean {
    const snapshot = this.require(experimentId);
    return new Set([
      snapshot.champions[role],
      ...snapshot.generations.flatMap((generation) => {
        const result = generation[role];
        return result ? [result.championBefore, result.championAfter] : [];
      }),
    ]).has(commit);
  }

  discardDerived(experimentId: string): void {
    const snapshot = this.get(experimentId);
    if (!snapshot) return;
    if (snapshot.generation !== 0 || snapshot.state !== "ready") throw new RuntimeStateError("只能清理尚未启动的派生运行时");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM exhibitions WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_checkpoints WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_model_calls WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_provider_attempts WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_provider_usage_items WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_provider_model_call_receipts WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_role_tool_calls WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM generation_records WHERE experiment_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM experiment_relations WHERE child_id = ?").run(experimentId);
      this.database.prepare("DELETE FROM experiment_runtime WHERE experiment_id = ?").run(experimentId);
      this.database.prepare(`DELETE FROM seal_groups WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM experiment_runtime WHERE seal_group_id = ?)`)
        .run(snapshot.sealGroupId, snapshot.sealGroupId);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  get(experimentId: string): ExperimentRuntimeSnapshot | undefined {
    const row = this.database.prepare("SELECT * FROM experiment_runtime WHERE experiment_id = ?").get(experimentId) as unknown as RuntimeRow | undefined;
    return row ? this.toSnapshot(row) : undefined;
  }

  close(): void { this.database.close(); }

  private require(id: string): ExperimentRuntimeSnapshot {
    const value = this.get(id); if (!value) throw new RuntimeStateError(`实验 ${id} 尚未完成基线确认`); return value;
  }

  private listGroup(groupId: string): ExperimentRuntimeSnapshot[] {
    return (this.database.prepare("SELECT * FROM experiment_runtime WHERE seal_group_id = ? ORDER BY experiment_id").all(groupId) as unknown as RuntimeRow[])
      .map((row) => this.toSnapshot(row));
  }

  private insertDerived(source: ExperimentRuntimeSnapshot, childId: string, suite: string, group: string, sealed: boolean, permitted: boolean, fingerprint: string): void {
    this.database.prepare(`INSERT INTO experiment_runtime (
      experiment_id, state, phase, generation, stagnation_count, champions_json, pause_requested, tokens_used,
      cost_used, token_limit, cost_limit, evaluation_suite_id, seal_group_id, sealed, evolution_permitted,
      compatibility_fingerprint, checkpoint_key
    ) VALUES (?, 'ready', 'ready', 0, 0, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(childId, JSON.stringify(source.champions), source.budget.tokenLimit, source.budget.costLimit, suite, group,
        sealed ? 1 : 0, permitted ? 1 : 0, fingerprint);
  }

  private toSnapshot(row: RuntimeRow): ExperimentRuntimeSnapshot {
    const records = this.database.prepare("SELECT record_json FROM generation_records WHERE experiment_id = ? ORDER BY generation")
      .all(row.experiment_id) as Array<{ record_json: string }>;
    const modelCalls = this.database.prepare(`SELECT COALESCE(SUM(calls_used), 0) AS calls_used
      FROM generation_role_model_calls WHERE experiment_id = ?`).get(row.experiment_id) as { calls_used: number };
    return {
      experimentId: row.experiment_id, state: row.state, phase: row.phase, generation: row.generation,
      stagnationCount: row.stagnation_count, champions: JSON.parse(row.champions_json) as Record<EvolutionRole, string>,
      pauseRequested: row.pause_requested === 1,
      usage: { tokens: row.tokens_used, cost: row.cost_used, modelCalls: row.model_calls_used },
      modelCallsUsed: row.model_calls_used,
      modelCallsReserved: modelCalls.calls_used,
      budget: { tokenLimit: row.token_limit, costLimit: row.cost_limit }, evaluationSuiteId: row.evaluation_suite_id,
      sealGroupId: row.seal_group_id, sealed: row.sealed === 1, evolutionPermitted: row.evolution_permitted === 1,
      compatibilityFingerprint: row.compatibility_fingerprint,
      generations: records.map(({ record_json }) => JSON.parse(record_json) as GenerationRecord),
    };
  }
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  wait: (attempt: number) => Promise<void> = async () => undefined,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === 3) break;
      await wait(attempt);
    }
  }
  throw lastError;
}

export interface SynchronousGenerationAdapter {
  evolve(role: EvolutionRole, frozen: {
    generation: number;
    champions: Readonly<Record<EvolutionRole, string>>;
    compatibilityFingerprint: string;
  }): Promise<GenerationRoleResult>;
  createChampionExhibition?(generatorCommit: string, solverCommit: string): Promise<string>;
}

export async function runSynchronousGeneration(options: {
  experimentId: string;
  repository: ExperimentRuntimeRepository;
  adapter: SynchronousGenerationAdapter;
  order?: readonly EvolutionRole[];
  checkpointKey: string;
  waitBeforeRetry?: (attempt: number) => Promise<void>;
}): Promise<ExperimentRuntimeSnapshot> {
  const before = options.repository.get(options.experimentId);
  if (!before || before.state !== "running") throw new RuntimeStateError("实验未运行，不能执行同步进化代");
  const frozen = {
    generation: before.generation + 1,
    champions: Object.freeze({ ...before.champions }),
    compatibilityFingerprint: before.compatibilityFingerprint,
  };
  const results = {} as Record<EvolutionRole, GenerationRoleResult>;
  try {
    for (const role of options.order ?? ["generator", "solver"] as const) {
      results[role] = await withProviderRetry(
        () => options.adapter.evolve(role, frozen),
        options.waitBeforeRetry,
      );
    }
  } catch (error) {
    return options.repository.recordInfrastructureFailure(
      options.experimentId,
      error instanceof Error ? error.message : "未知基础设施故障",
    );
  }
  for (const role of ["generator", "solver"] as const) {
    const result = results[role];
    if (result.championBefore !== frozen.champions[role]) throw new RuntimeStateError(`${role} 候选未使用冻结冠军快照`);
    if (result.outcome === "promoted" && !result.promotionTag) throw new RuntimeStateError(`${role} 晋级缺少 Promotion Tag`);
  }
  const exhibitionMatchId = options.adapter.createChampionExhibition
    ? await options.adapter.createChampionExhibition(results.generator.championAfter, results.solver.championAfter)
    : undefined;
  return options.repository.commitGeneration({
    experimentId: options.experimentId,
    generator: results.generator,
    solver: results.solver,
    exhibitionMatchId,
    checkpointKey: options.checkpointKey,
  });
}

function canonicalJson(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function providerUsageItem(row: ProviderUsageItemRow): ProviderUsageItem {
  return {
    itemId: row.item_id,
    reservationId: row.reservation_id,
    invocationId: row.invocation_id,
    experimentId: row.experiment_id,
    generation: row.generation,
    role: row.role,
    tokens: row.tokens,
    cost: row.cost,
    modelCalls: row.model_calls,
    auditDetails: JSON.parse(row.audit_details_json) as Record<string, unknown>,
    modelCallsAccounted: row.model_calls_accounted === 1,
    canaryAccounted: row.canary_accounted === 1,
    canaryAccepted: row.canary_accepted === null ? null : row.canary_accepted === 1,
    auditAccounted: row.audit_accounted === 1,
    runtimeAccounted: row.runtime_accounted === 1,
  };
}

function assertUsage(usage: Usage): void {
  if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.cost) || usage.cost < 0
    || !Number.isSafeInteger(usage.modelCalls) || usage.modelCalls < 0) {
    throw new Error("用量必须为非负有限值");
  }
}
