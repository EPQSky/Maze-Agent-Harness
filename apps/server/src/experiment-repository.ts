import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Experiment, ExperimentStatus } from "@maze-arena/contracts";

interface ExperimentRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  created_at: string;
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

function toExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class ExperimentRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'running', 'paused', 'completed', 'failed', 'cancelled')
        ),
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS one_running_experiment
        ON experiments ((status = 'running'))
        WHERE status = 'running';
    `);
  }

  create(name: string): Experiment {
    const experiment: Experiment = {
      id: randomUUID(),
      name,
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    this.database
      .prepare("INSERT INTO experiments (id, name, status, created_at) VALUES (?, ?, ?, ?)")
      .run(experiment.id, experiment.name, experiment.status, experiment.createdAt);

    return experiment;
  }

  list(): Experiment[] {
    const rows = this.database
      .prepare("SELECT id, name, status, created_at FROM experiments ORDER BY created_at DESC, id DESC")
      .all() as unknown as ExperimentRow[];
    return rows.map(toExperiment);
  }

  find(id: string): Experiment | undefined {
    const row = this.database
      .prepare("SELECT id, name, status, created_at FROM experiments WHERE id = ?")
      .get(id) as unknown as ExperimentRow | undefined;
    return row ? toExperiment(row) : undefined;
  }

  start(id: string): Experiment {
    if (!this.find(id)) {
      throw new ExperimentNotFoundError(id);
    }

    try {
      this.database.prepare("UPDATE experiments SET status = 'running' WHERE id = ?").run(id);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ActiveExperimentExistsError();
      }
      throw error;
    }

    return this.find(id) as Experiment;
  }

  close(): void {
    this.database.close();
  }
}
