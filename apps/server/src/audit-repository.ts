import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExperimentAuditEvent, ExperimentAuditEventPage, ExperimentAuditEventType } from "@maze-arena/contracts";

interface AuditRow {
  id: number;
  experiment_id: string;
  event_type: ExperimentAuditEventType;
  occurred_at: string;
  details_json: string;
}

export class AuditRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`CREATE TABLE IF NOT EXISTS experiment_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      experiment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_by_experiment
      ON experiment_audit_events(experiment_id, id);`);
  }

  append(
    experimentId: string,
    type: ExperimentAuditEventType,
    details: ExperimentAuditEvent["details"] = {},
  ): ExperimentAuditEvent {
    const occurredAt = new Date().toISOString();
    const result = this.database.prepare(`INSERT INTO experiment_audit_events
      (experiment_id, event_type, occurred_at, details_json) VALUES (?, ?, ?, ?)`) 
      .run(experimentId, type, occurredAt, JSON.stringify(details));
    return { id: Number(result.lastInsertRowid), experimentId, type, occurredAt, details };
  }

  list(experimentId: string, afterId = 0, limit = 256): ExperimentAuditEventPage {
    const rows = this.database.prepare(`SELECT id, experiment_id, event_type, occurred_at, details_json
      FROM experiment_audit_events WHERE experiment_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .all(experimentId, Math.max(0, afterId), Math.max(1, Math.min(limit, 1_024))) as unknown as AuditRow[];
    const events = rows.map((row) => ({
      id: row.id,
      experimentId: row.experiment_id,
      type: row.event_type,
      occurredAt: row.occurred_at,
      details: JSON.parse(row.details_json) as ExperimentAuditEvent["details"],
    }));
    return { events, nextId: events.at(-1)?.id ?? Math.max(0, afterId) };
  }

  close(): void { this.database.close(); }
}
