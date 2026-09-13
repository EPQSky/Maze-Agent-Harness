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
      details_json TEXT NOT NULL,
      idempotency_key TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_events_by_experiment
      ON experiment_audit_events(experiment_id, id);`);
    const columns = new Set((this.database.prepare("PRAGMA table_info(experiment_audit_events)").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has("idempotency_key")) {
      this.database.exec("ALTER TABLE experiment_audit_events ADD COLUMN idempotency_key TEXT");
    }
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS audit_event_idempotency
      ON experiment_audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL`);
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

  appendOnce(
    idempotencyKey: string,
    experimentId: string,
    type: ExperimentAuditEventType,
    details: ExperimentAuditEvent["details"] = {},
  ): ExperimentAuditEvent {
    if (!idempotencyKey) throw new Error("审计幂等键不能为空");
    const occurredAt = new Date().toISOString();
    const detailsJson = JSON.stringify(details);
    this.database.prepare(`INSERT INTO experiment_audit_events
      (experiment_id, event_type, occurred_at, details_json, idempotency_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`)
      .run(experimentId, type, occurredAt, detailsJson, idempotencyKey);
    const persisted = this.database.prepare(`SELECT id, experiment_id, event_type, occurred_at, details_json
      FROM experiment_audit_events WHERE idempotency_key = ?`).get(idempotencyKey) as unknown as AuditRow | undefined;
    if (!persisted) throw new Error("审计幂等写入失败");
    if (persisted.experiment_id !== experimentId || persisted.event_type !== type
      || persisted.details_json !== detailsJson) throw new Error("审计幂等键载荷冲突");
    return { id: persisted.id, experimentId, type, occurredAt: persisted.occurred_at, details };
  }

  hasBackupCreated(
    experimentId: string,
    trigger: "experiment-start" | "experiment-terminal",
    marker: Record<string, string> = {},
  ): boolean {
    const rows = this.database.prepare(`SELECT details_json FROM experiment_audit_events
      WHERE experiment_id = ? AND event_type = 'backup.created'`).all(experimentId) as Array<{ details_json: string }>;
    return rows.some(({ details_json }) => {
      try {
        const details = JSON.parse(details_json) as Record<string, unknown>;
        return details.trigger === trigger
          && Object.entries(marker).every(([key, value]) => details[key] === value);
      } catch {
        return false;
      }
    });
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
