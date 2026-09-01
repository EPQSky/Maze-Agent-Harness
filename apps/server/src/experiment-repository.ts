import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Experiment,
  ExperimentStatus,
  ModelProfile,
} from "@maze-arena/contracts";
import { createHarnessAgentEnvironments } from "@maze-arena/dsh-integration";

interface ExperimentRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  created_at: string;
  model_profile_json: string | null;
  generator_home: string;
  generator_workspace: string;
  solver_home: string;
  solver_workspace: string;
}

export class ActiveExperimentExistsError extends Error {
  constructor() {
    super("当前 Arena 已有运行中的实验");
    this.name = "ActiveExperimentExistsError";
  }
}

export class ExperimentNotFoundError extends Error {
  constructor(id: string) {
    super(`未找到实验 ${id}`);
    this.name = "ExperimentNotFoundError";
  }
}

export class ModelProfileFrozenError extends Error {
  constructor() {
    super("实验启动后模型配置档已冻结；修改配置必须创建新实验");
    this.name = "ModelProfileFrozenError";
  }
}

export class InvalidExperimentStateError extends Error {
  constructor(status: ExperimentStatus) {
    super(`实验当前状态 ${status} 不允许启动`);
    this.name = "InvalidExperimentStateError";
  }
}

function toExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    modelProfile: row.model_profile_json ? JSON.parse(row.model_profile_json) as ModelProfile : null,
    harnessEnvironments: {
      generator: { home: row.generator_home, workspace: row.generator_workspace },
      solver: { home: row.solver_home, workspace: row.solver_workspace },
    },
  };
}

export class ExperimentRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string, private readonly harnessRoot: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 2) {
      throw new Error(`数据库版本 ${version.user_version} 高于当前支持版本 2`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const table = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'experiments'").get();
      if (!table) {
        this.database.exec(`CREATE TABLE experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'running', 'paused', 'completed', 'failed', 'cancelled')
        ),
        created_at TEXT NOT NULL,
        model_profile_json TEXT,
        generator_home TEXT,
        generator_workspace TEXT,
        solver_home TEXT,
        solver_workspace TEXT
      )`);
      } else {
        const columns = new Set((this.database.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>).map(({ name }) => name));
        for (const [name, type] of [
          ["model_profile_json", "TEXT"],
          ["generator_home", "TEXT"],
          ["generator_workspace", "TEXT"],
          ["solver_home", "TEXT"],
          ["solver_workspace", "TEXT"],
        ] as const) {
          if (!columns.has(name)) this.database.exec(`ALTER TABLE experiments ADD COLUMN ${name} ${type}`);
        }
      }

      const rows = this.database.prepare(`SELECT id FROM experiments
        WHERE generator_home IS NULL OR generator_workspace IS NULL OR solver_home IS NULL OR solver_workspace IS NULL`).all() as Array<{ id: string }>;
      const updateEnvironment = this.database.prepare(`UPDATE experiments SET
        generator_home = ?, generator_workspace = ?, solver_home = ?, solver_workspace = ? WHERE id = ?`);
      for (const row of rows) {
        const environments = createHarnessAgentEnvironments(this.harnessRoot, row.id);
        updateEnvironment.run(
          environments.generator.home,
          environments.generator.workspace,
          environments.solver.home,
          environments.solver.workspace,
          row.id,
        );
      }

      this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_running_experiment
        ON experiments ((status = 'running'))
        WHERE status = 'running'`);
      this.database.exec("PRAGMA user_version = 2");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  create(name: string, modelProfile: ModelProfile): Experiment {
    const id = randomUUID();
    const harnessEnvironments = createHarnessAgentEnvironments(this.harnessRoot, id);
    const experiment: Experiment = {
      id,
      name,
      status: "draft",
      createdAt: new Date().toISOString(),
      modelProfile,
      harnessEnvironments,
    };

    this.database
      .prepare(`INSERT INTO experiments (
        id, name, status, created_at, model_profile_json,
        generator_home, generator_workspace, solver_home, solver_workspace
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        experiment.id,
        experiment.name,
        experiment.status,
        experiment.createdAt,
        JSON.stringify(modelProfile),
        harnessEnvironments.generator.home,
        harnessEnvironments.generator.workspace,
        harnessEnvironments.solver.home,
        harnessEnvironments.solver.workspace,
      );

    return experiment;
  }

  list(): Experiment[] {
    const rows = this.database
      .prepare(`SELECT id, name, status, created_at, model_profile_json,
        generator_home, generator_workspace, solver_home, solver_workspace
        FROM experiments ORDER BY created_at DESC, id DESC`)
      .all() as unknown as ExperimentRow[];
    return rows.map(toExperiment);
  }

  find(id: string): Experiment | undefined {
    const row = this.database
      .prepare(`SELECT id, name, status, created_at, model_profile_json,
        generator_home, generator_workspace, solver_home, solver_workspace
        FROM experiments WHERE id = ?`)
      .get(id) as unknown as ExperimentRow | undefined;
    return row ? toExperiment(row) : undefined;
  }

  start(id: string, validateModelProfile: (profile: ModelProfile | null) => void): Experiment {
    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const experiment = this.find(id);
      if (!experiment) throw new ExperimentNotFoundError(id);
      if (experiment.status !== "draft") throw new InvalidExperimentStateError(experiment.status);

      validateModelProfile(experiment.modelProfile);
      const result = this.database
        .prepare("UPDATE experiments SET status = 'running' WHERE id = ? AND status = 'draft'")
        .run(id);
      if (Number(result.changes) !== 1) throw new ModelProfileFrozenError();
      this.database.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) this.database.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ActiveExperimentExistsError();
      }
      throw error;
    }

    return this.find(id) as Experiment;
  }

  updateModelProfile(id: string, modelProfile: ModelProfile): Experiment {
    const existing = this.find(id);
    if (!existing) throw new ExperimentNotFoundError(id);
    if (existing.status !== "draft") throw new ModelProfileFrozenError();

    const result = this.database
      .prepare("UPDATE experiments SET model_profile_json = ? WHERE id = ? AND status = 'draft'")
      .run(JSON.stringify(modelProfile), id);
    if (Number(result.changes) !== 1) throw new ModelProfileFrozenError();
    return this.find(id) as Experiment;
  }

  close(): void {
    this.database.close();
  }
}
