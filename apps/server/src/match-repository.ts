import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ArenaMatch, CompletedArenaMatch, MatchEvent, MatchEventPage, MatchScore, ObservationMatch, RawMatchEventPage } from "@maze-arena/contracts";
import { GOAL, GRID_SIZE, MAX_SOLVER_STEPS, START, createInitialProjection, projectMatchEvents, validateMaze, type MatchResult } from "@maze-arena/engine";

interface MatchRow {
  id: string; experiment_id: string; seed: string; protocol_version: number; status: string;
  committed_event_count: number; total_event_count: number; score_json: string;
  observation_json: string | null;
}
interface EventRow { sequence: number; protocol_version: number; event_bytes: Uint8Array }

export class MatchDataCorruptError extends Error {
  constructor(message: string) { super(`比赛权威数据损坏：${message}`); this.name = "MatchDataCorruptError"; }
}

export class MatchRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 5) throw new Error(`数据库版本 ${version.user_version} 高于当前支持版本 5`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, seed TEXT NOT NULL, protocol_version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed', committed_event_count INTEGER NOT NULL DEFAULT 0,
        total_event_count INTEGER NOT NULL DEFAULT 0, score_json TEXT NOT NULL, observation_json TEXT
      );
      CREATE TABLE IF NOT EXISTS match_events (
        match_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_json TEXT NOT NULL,
        protocol_version INTEGER, event_bytes BLOB,
        PRIMARY KEY (match_id, sequence), FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS matches_by_experiment ON matches(experiment_id);`);
      const columns = new Set((this.database.prepare("PRAGMA table_info(matches)").all() as Array<{ name: string }>).map(({ name }) => name));
      for (const [name, definition] of [
        ["status", "TEXT NOT NULL DEFAULT 'completed'"],
        ["committed_event_count", "INTEGER NOT NULL DEFAULT 0"],
        ["total_event_count", "INTEGER NOT NULL DEFAULT 0"],
      ] as const) if (!columns.has(name)) this.database.exec(`ALTER TABLE matches ADD COLUMN ${name} ${definition}`);
      if (!columns.has("observation_json")) this.database.exec("ALTER TABLE matches ADD COLUMN observation_json TEXT");
      const eventColumns = new Set((this.database.prepare("PRAGMA table_info(match_events)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!eventColumns.has("protocol_version")) this.database.exec("ALTER TABLE match_events ADD COLUMN protocol_version INTEGER");
      if (!eventColumns.has("event_bytes")) this.database.exec("ALTER TABLE match_events ADD COLUMN event_bytes BLOB");
      this.database.exec(`UPDATE match_events SET
        protocol_version = COALESCE(protocol_version, 1),
        event_bytes = COALESCE(event_bytes, CAST(event_json AS BLOB))
        WHERE protocol_version IS NULL OR event_bytes IS NULL`);
      this.database.exec(`UPDATE matches SET
        committed_event_count = (SELECT COUNT(*) FROM match_events WHERE match_id = matches.id),
        total_event_count = (SELECT COUNT(*) FROM match_events WHERE match_id = matches.id)
        WHERE total_event_count = 0`);
      this.database.exec("PRAGMA user_version = 5");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  prepare(experimentId: string, seed: string, result: MatchResult): { match: ArenaMatch; events: MatchEvent[]; score: MatchScore } {
    const match = this.start(experimentId, seed, result.events.length);
    return { match, events: result.events, score: result.score };
  }

  start(
    experimentId: string,
    seed: string,
    totalEventCount = 0,
    observation?: Omit<ObservationMatch, "id">,
    id: string = randomUUID(),
  ): ArenaMatch {
    const existing = this.getMetadata(id);
    if (existing) {
      if (existing.experimentId !== experimentId || existing.seed !== seed) throw new Error("幂等比赛标识与既有比赛冲突");
      return existing;
    }
    const match: ArenaMatch = {
      id, experimentId, seed, protocolVersion: 1, status: "running",
      committedEventCount: 0, totalEventCount, score: null,
      ...(observation ? { observation: { id: "", ...observation } } : {}),
    };
    if (match.observation) match.observation.id = match.id;
    this.database.prepare(`INSERT INTO matches
      (id, experiment_id, seed, protocol_version, status, committed_event_count, total_event_count, score_json, observation_json)
      VALUES (?, ?, ?, ?, 'running', 0, ?, 'null', ?)`)
      .run(match.id, experimentId, seed, match.protocolVersion, totalEventCount,
        match.observation ? JSON.stringify(match.observation) : null);
    return match;
  }

  appendEvents(id: string, events: readonly MatchEvent[], score?: MatchScore): ArenaMatch {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getRow(id);
      if (!row) throw new Error(`未找到比赛 ${id}`);
      if (row.status !== "running") throw new Error(`比赛 ${id} 已完成`);
      const insert = this.database.prepare(`INSERT INTO match_events
        (match_id, sequence, event_json, protocol_version, event_bytes) VALUES (?, ?, ?, ?, ?)`);
      let expected = row.committed_event_count + 1;
      for (const event of events) {
        if (event.sequence !== expected) throw new MatchDataCorruptError("待提交事件序号不连续");
        const bytes = Buffer.from(JSON.stringify(event), "utf8");
        insert.run(id, event.sequence, bytes.toString("utf8"), event.protocolVersion, bytes);
        expected += 1;
      }
      const committed = expected - 1;
      const completed = score !== undefined;
      this.database.prepare("UPDATE matches SET committed_event_count = ?, total_event_count = ?, status = ?, score_json = ? WHERE id = ?")
        .run(committed, committed, completed ? "completed" : "running", completed ? JSON.stringify(score) : "null", id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return this.getMetadata(id) as ArenaMatch;
  }

  fail(id: string): ArenaMatch {
    this.database.prepare("UPDATE matches SET status = 'failed', total_event_count = committed_event_count, score_json = 'null' WHERE id = ? AND status = 'running'").run(id);
    return this.getMetadata(id) as ArenaMatch;
  }

  getMetadata(id: string): ArenaMatch | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    return toMetadata(row, this.readValidatedEvents(row));
  }

  readEvents(id: string, afterSequence = 0, limit = 256): MatchEventPage | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    const allEvents = this.readValidatedEvents(row);
    const events = allEvents.filter(({ sequence }) => sequence > afterSequence).slice(0, Math.max(1, Math.min(limit, 1_024)));
    return { match: toMetadata(row, allEvents), events, nextSequence: events.at(-1)?.sequence ?? afterSequence };
  }

  readRawEvents(id: string, afterSequence = 0, limit = 256): RawMatchEventPage | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    const events = this.readStoredEvents(row.id)
      .filter(({ sequence }) => sequence > afterSequence)
      .slice(0, Math.max(1, Math.min(limit, 1_024)))
      .map((stored) => ({
        sequence: stored.sequence,
        protocolVersion: stored.protocol_version,
        contentType: "application/json" as const,
        bytesBase64: Buffer.from(stored.event_bytes).toString("base64"),
      }));
    return { matchId: id, events, nextSequence: events.at(-1)?.sequence ?? afterSequence };
  }

  find(id: string): CompletedArenaMatch | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    const events = this.readValidatedEvents(row);
    if (row.status !== "completed") throw new MatchDataCorruptError("比赛尚未完成，不能读取完整回放");
    const metadata = toMetadata(row, events);
    return { ...metadata, status: "completed", score: metadata.score as MatchScore, events };
  }

  latestForExperiment(experimentId: string): ArenaMatch | undefined {
    const row = this.database.prepare("SELECT id FROM matches WHERE experiment_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(experimentId) as { id: string } | undefined;
    return row ? this.getMetadata(row.id) : undefined;
  }

  listForExperiment(experimentId: string): ArenaMatch[] {
    const rows = this.database.prepare("SELECT id FROM matches WHERE experiment_id = ? ORDER BY rowid DESC")
      .all(experimentId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.getMetadata(id)!).filter(Boolean);
  }

  private getRow(id: string): MatchRow | undefined {
    return this.database.prepare(`SELECT id, experiment_id, seed, protocol_version, status,
      committed_event_count, total_event_count, score_json, observation_json FROM matches WHERE id = ?`).get(id) as unknown as MatchRow | undefined;
  }

  private readValidatedEvents(row: MatchRow): MatchEvent[] {
    if (row.protocol_version !== 1 || !["running", "completed", "failed"].includes(row.status)) throw new MatchDataCorruptError("比赛元数据非法");
    const rows = this.readStoredEvents(row.id);
    if (rows.length !== row.committed_event_count || row.committed_event_count > row.total_event_count) {
      throw new MatchDataCorruptError("事件计数与元数据不一致");
    }
    const events = rows.map((stored, index) => parseEvent(stored, index + 1));
    validateEventStream(row, events);
    return events;
  }

  private readStoredEvents(id: string): EventRow[] {
    return this.database.prepare(`SELECT sequence, protocol_version, event_bytes
      FROM match_events WHERE match_id = ? ORDER BY sequence`).all(id) as unknown as EventRow[];
  }

  close(): void { this.database.close(); }
}

function toMetadata(row: MatchRow, events: MatchEvent[]): ArenaMatch {
  return {
    id: row.id, experimentId: row.experiment_id, seed: row.seed, protocolVersion: 1,
    status: row.status as ArenaMatch["status"], committedEventCount: events.length,
    totalEventCount: row.total_event_count, score: row.status === "completed" ? parseScore(row.score_json) : null,
    ...(row.observation_json ? { observation: JSON.parse(row.observation_json) as ObservationMatch } : {}),
  };
}

function parseEvent(stored: EventRow, expectedSequence: number): MatchEvent {
  let value: unknown;
  if (stored.protocol_version !== 1) throw new MatchDataCorruptError(`不支持比赛事件协议版本 ${stored.protocol_version}`);
  try { value = JSON.parse(Buffer.from(stored.event_bytes).toString("utf8")); } catch { throw new MatchDataCorruptError("事件 JSON 无法解析"); }
  if (!isRecord(value) || stored.sequence !== expectedSequence || value.sequence !== stored.sequence
    || value.protocolVersion !== stored.protocol_version) {
    throw new MatchDataCorruptError("事件序号或协议版本非法");
  }
  const event = value as unknown as MatchEvent;
  if (event.type === "match.started") {
    if (!onlyKeys(value, ["protocolVersion", "sequence", "type", "seed", "size", "start", "goal", "stepBudget"])
      || event.seed === "" || event.size !== GRID_SIZE || !coordinate(event.start) || !coordinate(event.goal)
      || !same(event.start, START) || !same(event.goal, GOAL) || event.stepBudget !== MAX_SOLVER_STEPS) corruptShape();
  } else if (event.type === "maze.carved") {
    if (!onlyKeys(value, ["protocolVersion", "sequence", "type", "from", "to"])
      || !coordinate(event.from) || !coordinate(event.to) || Math.abs(event.from.x - event.to.x) + Math.abs(event.from.y - event.to.y) !== 1) corruptShape();
  } else if (event.type === "maze.completed") {
    if (!onlyKeys(value, ["protocolVersion", "sequence", "type", "passageCount"])
      || !integer(event.passageCount) || event.passageCount < 1) corruptShape();
  } else if (event.type === "solver.action") {
    if (!onlyKeys(value, ["protocolVersion", "sequence", "type", "step", "action", "from", "to", "moved"])
      || !isRecord(event.action) || !onlyKeys(event.action, ["direction", "kind"])
      || !integer(event.step) || event.step < 1 || event.step > MAX_SOLVER_STEPS || !coordinate(event.from) || !coordinate(event.to)
      || typeof event.moved !== "boolean" || !["north", "east", "south", "west"].includes(event.action?.direction)
      || !["move", "backtrack"].includes(event.action?.kind)) corruptShape();
  } else if (event.type === "match.completed") {
    if (!onlyKeys(value, ["protocolVersion", "sequence", "type", "score"])) corruptShape();
    validateScore(event.score);
  }
  else throw new MatchDataCorruptError("事件类型非法");
  return event;
}

function validateEventStream(row: MatchRow, events: MatchEvent[]): void {
  if (events.length > 0 && events[0]?.type !== "match.started") throw new MatchDataCorruptError("首个事件不是比赛开始");
  let phase: "empty" | "generation" | "solving" | "completed" = "empty";
  const passages: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  const passageKeys = new Set<string>();
  let position: { x: number; y: number } = { ...START };
  let actions = 0;
  let illegalMoves = 0;
  let backtracks = 0;
  let completion: Extract<MatchEvent, { type: "match.completed" }> | undefined;

  for (const event of events) {
    if (event.type === "match.started") {
      if (phase !== "empty" || event.seed !== row.seed) throw new MatchDataCorruptError("比赛开始事件重复或种子冲突");
      phase = "generation";
    } else if (event.type === "maze.carved") {
      if (phase !== "generation") throw new MatchDataCorruptError("凿通事件阶段非法");
      const key = passageKey(event.from, event.to);
      if (passageKeys.has(key)) throw new MatchDataCorruptError("凿通事件重复");
      passageKeys.add(key);
      passages.push({ from: event.from, to: event.to });
    } else if (event.type === "maze.completed") {
      if (phase !== "generation" || event.passageCount !== passages.length) throw new MatchDataCorruptError("迷宫完成事件冲突");
      const validation = validateMaze({ size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, passages });
      if (!validation.valid) throw new MatchDataCorruptError(validation.reason ?? "迷宫非法");
      phase = "solving";
    } else if (event.type === "solver.action") {
      if (phase !== "solving" || event.step !== actions + 1 || !same(event.from, position) || same(position, GOAL)) {
        throw new MatchDataCorruptError("求解动作顺序或位置非法");
      }
      const candidate = movedCoordinate(position, event.action.direction);
      const open = passageKeys.has(passageKey(position, candidate));
      if (event.moved ? (!open || !same(event.to, candidate)) : (open || !same(event.to, position))) {
        throw new MatchDataCorruptError("求解动作结果与迷宫冲突");
      }
      actions += 1;
      if (event.moved) position = event.to;
      else illegalMoves += 1;
      if (event.action.kind === "backtrack") backtracks += 1;
    } else {
      if (phase !== "solving" || completion) throw new MatchDataCorruptError("完成事件阶段非法或重复");
      completion = event;
      phase = "completed";
    }
  }

  if (row.status === "running" || row.status === "failed") {
    if (phase === "completed" || row.score_json !== "null") throw new MatchDataCorruptError("运行中比赛包含完成事实");
    return;
  }
  if (events.length !== row.total_event_count || phase !== "completed" || !completion || events.at(-1) !== completion) {
    throw new MatchDataCorruptError("完成事件缺失、重复或不在末尾");
  }
  const computedScore: MatchScore = {
    solved: same(position, GOAL), actions, illegalMoves, backtracks, remainingSteps: MAX_SOLVER_STEPS - actions,
  };
  let projection;
  try { projection = projectMatchEvents(createInitialProjection(), events); } catch { throw new MatchDataCorruptError("事件无法完成投影"); }
  const storedScore = parseScore(row.score_json);
  if (![completion.score, projection.score, computedScore].every((score) => JSON.stringify(score) === JSON.stringify(storedScore))) {
    throw new MatchDataCorruptError("评分事实与权威动作不一致");
  }
}

function parseScore(json: string): MatchScore {
  let score: unknown;
  try { score = JSON.parse(json); } catch { throw new MatchDataCorruptError("评分 JSON 无法解析"); }
  validateScore(score);
  return score;
}
function validateScore(value: unknown): asserts value is MatchScore {
  if (!isRecord(value) || !onlyKeys(value, ["solved", "actions", "illegalMoves", "backtracks", "remainingSteps"])
    || typeof value.solved !== "boolean" || !integer(value.actions) || !integer(value.illegalMoves)
    || !integer(value.backtracks) || !integer(value.remainingSteps) || value.actions < 0 || value.actions > MAX_SOLVER_STEPS
    || value.remainingSteps !== MAX_SOLVER_STEPS - value.actions) corruptShape();
}
function coordinate(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && integer(value.x) && integer(value.y) && value.x >= 0 && value.x < GRID_SIZE && value.y >= 0 && value.y < GRID_SIZE;
}
function same(left: { x: number; y: number }, right: { x: number; y: number }): boolean { return left.x === right.x && left.y === right.y; }
function integer(value: unknown): value is number { return Number.isInteger(value); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function onlyKeys(value: Record<string, any>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function passageKey(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return [`${from.x},${from.y}`, `${to.x},${to.y}`].sort().join("|");
}
function movedCoordinate(position: { x: number; y: number }, direction: "north" | "east" | "south" | "west") {
  const deltas: Record<"north" | "east" | "south" | "west", readonly [number, number]> = {
    north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
  };
  const delta = deltas[direction];
  return { x: position.x + delta[0], y: position.y + delta[1] };
}
function corruptShape(): never { throw new MatchDataCorruptError("事件或评分字段非法"); }
