import { createHash, createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
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

export type BaselineValidationStep = (typeof baselineValidationSteps)[number];
export type BaselineValidationStatus = "pending" | "running" | "failed" | "passed" | "ready";

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
}

export interface BaselineValidationRecord {
  experimentId: string;
  status: BaselineValidationStatus;
  steps: BaselineStepResult[];
  operatorConfirmed: boolean;
  frozenConfiguration: FrozenExperimentConfiguration | null;
  frozenDigest: string | null;
  smoke: { attempted: boolean; passed: boolean | null };
}

export interface BaselineValidationAdapter {
  runStep(step: BaselineValidationStep): BaselineStepResult | Promise<BaselineStepResult>;
  smokeProvider?(): { passed: boolean; providerText?: string } | Promise<{ passed: boolean; providerText?: string }>;
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
      smoke_attempted INTEGER NOT NULL, smoke_passed INTEGER
    );`);
  }

  async runBaselineValidation(
    experimentId: string,
    adapter: BaselineValidationAdapter,
    options: { smokeProvider?: boolean } = {},
  ): Promise<BaselineValidationRecord> {
    this.upsert(experimentId, "running", [], false, null, null, false, null);
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
    if (options.smokeProvider) {
      smokeAttempted = true;
      if (!adapter.smokeProvider) smokePassed = false;
      else {
        try { smokePassed = (await adapter.smokeProvider()).passed; }
        catch { smokePassed = false; }
      }
    }
    const status: BaselineValidationStatus = steps.length === baselineValidationSteps.length && steps.every(({ passed }) => passed)
      ? "passed"
      : "failed";
    this.upsert(experimentId, status, steps, false, null, null, smokeAttempted, smokePassed);
    return this.getBaselineValidation(experimentId)!;
  }

  confirmBaseline(experimentId: string, configuration: FrozenExperimentConfiguration): BaselineValidationRecord {
    const current = this.getBaselineValidation(experimentId);
    if (!current || current.status !== "passed" || current.steps.length !== baselineValidationSteps.length) {
      throw new Error("基线验收尚未全部通过，不能确认就绪");
    }
    const canonical = canonicalJson(configuration);
    const digest = createHash("sha256").update(canonical).digest("hex");
    this.upsert(experimentId, "ready", current.steps, true, configuration, digest, current.smoke.attempted, current.smoke.passed);
    return this.getBaselineValidation(experimentId)!;
  }

  rollbackBaselineConfirmation(experimentId: string): BaselineValidationRecord {
    const current = this.getBaselineValidation(experimentId);
    if (!current || current.status !== "ready") throw new Error("基线尚未确认，无需回滚");
    this.upsert(experimentId, "passed", current.steps, false, null, null, current.smoke.attempted, current.smoke.passed);
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
    this.upsert(experimentId, "pending", [], false, null, null, false, null);
  }

  deriveReady(sourceId: string, childId: string, overrides: Partial<FrozenExperimentConfiguration>): BaselineValidationRecord {
    const source = this.requireReady(sourceId);
    const configuration = { ...source.frozenConfiguration!, ...overrides };
    const canonical = canonicalJson(configuration);
    const digest = createHash("sha256").update(canonical).digest("hex");
    this.upsert(childId, "ready", source.steps, true, configuration, digest, false, null);
    return this.getBaselineValidation(childId)!;
  }

  getBaselineValidation(experimentId: string): BaselineValidationRecord | undefined {
    const row = this.database.prepare(`SELECT experiment_id, status, steps_json, operator_confirmed,
      frozen_configuration_json, frozen_digest, smoke_attempted, smoke_passed
      FROM baseline_validations WHERE experiment_id = ?`).get(experimentId) as unknown as ValidationRow | undefined;
    if (!row) return undefined;
    return {
      experimentId: row.experiment_id,
      status: row.status,
      steps: JSON.parse(row.steps_json) as BaselineStepResult[],
      operatorConfirmed: row.operator_confirmed === 1,
      frozenConfiguration: row.frozen_configuration_json ? JSON.parse(row.frozen_configuration_json) as FrozenExperimentConfiguration : null,
      frozenDigest: row.frozen_digest,
      smoke: { attempted: row.smoke_attempted === 1, passed: row.smoke_passed === null ? null : row.smoke_passed === 1 },
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
  ): void {
    this.database.prepare(`INSERT INTO baseline_validations
      (experiment_id, status, steps_json, operator_confirmed, frozen_configuration_json, frozen_digest, smoke_attempted, smoke_passed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id) DO UPDATE SET status = excluded.status, steps_json = excluded.steps_json,
      operator_confirmed = excluded.operator_confirmed, frozen_configuration_json = excluded.frozen_configuration_json,
      frozen_digest = excluded.frozen_digest, smoke_attempted = excluded.smoke_attempted, smoke_passed = excluded.smoke_passed`)
      .run(experimentId, status, JSON.stringify(steps), operatorConfirmed ? 1 : 0,
        configuration ? canonicalJson(configuration) : null, digest, smokeAttempted ? 1 : 0,
        smokePassed === null ? null : smokePassed ? 1 : 0);
  }
}

interface RuntimeRow {
  experiment_id: string; state: ExperimentRuntimeSnapshot["state"]; phase: string; generation: number;
  stagnation_count: number; champions_json: string; pause_requested: number; tokens_used: number; cost_used: number;
  token_limit: number; cost_limit: number | null; evaluation_suite_id: string; seal_group_id: string;
  sealed: number; evolution_permitted: number; compatibility_fingerprint: string;
}

export class RuntimeStateError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeStateError"; }
}

export class ExperimentRuntimeRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS experiment_runtime (
      experiment_id TEXT PRIMARY KEY, state TEXT NOT NULL, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      stagnation_count INTEGER NOT NULL, champions_json TEXT NOT NULL, pause_requested INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL, cost_used REAL NOT NULL, token_limit INTEGER NOT NULL, cost_limit REAL,
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
      PRIMARY KEY (experiment_id, generation, role), UNIQUE (experiment_id, attempt_id)
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

  recordUsage(experimentId: string, tokens: number, cost = 0): ExperimentRuntimeSnapshot {
    if (!Number.isInteger(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) throw new Error("用量必须为非负有限值");
    this.database.prepare("UPDATE experiment_runtime SET tokens_used = tokens_used + ?, cost_used = cost_used + ? WHERE experiment_id = ?")
      .run(tokens, cost, experimentId);
    const current = this.require(experimentId);
    if (current.usage.tokens >= current.budget.tokenLimit
      || (current.budget.costLimit !== null && current.usage.cost >= current.budget.costLimit)) {
      this.database.prepare("UPDATE experiment_runtime SET pause_requested = 1, phase = 'budget-boundary' WHERE experiment_id = ?").run(experimentId);
    }
    return this.get(experimentId)!;
  }

  saveRoleCheckpoint(input: {
    experimentId: string; generation: number; role: EvolutionRole; attemptId: string;
    result: GenerationRoleResult; tokens: number; cost: number;
  }): void {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isInteger(input.tokens)
      || input.tokens < 0 || !Number.isFinite(input.cost) || input.cost < 0) throw new Error("角色检查点字段非法");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getRoleCheckpoint(input.experimentId, input.generation, input.role);
      if (!existing) {
        this.database.prepare(`INSERT INTO generation_role_checkpoints
          (experiment_id, generation, role, attempt_id, result_json, tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(input.experimentId, input.generation, input.role, input.attemptId, JSON.stringify(input.result), input.tokens, input.cost);
        this.database.prepare("UPDATE experiment_runtime SET tokens_used = tokens_used + ?, cost_used = cost_used + ?, phase = ? WHERE experiment_id = ?")
          .run(input.tokens, input.cost, `generation.${input.generation}.${input.role}.complete`, input.experimentId);
      } else if (existing.attemptId !== input.attemptId || JSON.stringify(existing.result) !== JSON.stringify(input.result)) {
        throw new RuntimeStateError("角色检查点与既有原子结果冲突");
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getRoleCheckpoint(experimentId: string, generation: number, role: EvolutionRole): {
    attemptId: string; result: GenerationRoleResult; tokens: number; cost: number;
  } | undefined {
    const row = this.database.prepare(`SELECT attempt_id, result_json, tokens, cost
      FROM generation_role_checkpoints WHERE experiment_id = ? AND generation = ? AND role = ?`)
      .get(experimentId, generation, role) as { attempt_id: string; result_json: string; tokens: number; cost: number } | undefined;
    return row ? { attemptId: row.attempt_id, result: JSON.parse(row.result_json) as GenerationRoleResult, tokens: row.tokens, cost: row.cost } : undefined;
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
    return {
      experimentId: row.experiment_id, state: row.state, phase: row.phase, generation: row.generation,
      stagnationCount: row.stagnation_count, champions: JSON.parse(row.champions_json) as Record<EvolutionRole, string>,
      pauseRequested: row.pause_requested === 1, usage: { tokens: row.tokens_used, cost: row.cost_used },
      budget: { tokenLimit: row.token_limit, costLimit: row.cost_limit }, evaluationSuiteId: row.evaluation_suite_id,
      sealGroupId: row.seal_group_id, sealed: row.sealed === 1, evolutionPermitted: row.evolution_permitted === 1,
      compatibilityFingerprint: row.compatibility_fingerprint,
      generations: records.map(({ record_json }) => JSON.parse(record_json) as GenerationRecord),
    };
  }
}

export async function withProviderRetry<T>(operation: () => Promise<T>, wait: (attempt: number) => Promise<void> = async () => undefined): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); }
    catch (error) { lastError = error; if (attempt < 3) await wait(attempt); }
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
