import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MatchDataCorruptError, MatchRepository } from "./match-repository.js";

const repositories: MatchRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

function complete(repository: MatchRepository, seed = "persisted-seed") {
  const prepared = repository.prepareBaseline("experiment-1", seed);
  repository.appendEvents(prepared.match.id, prepared.events, prepared.score);
  return repository.find(prepared.match.id)!;
}

describe("比赛事件持久化", () => {
  it("分批提交期间只读取已提交的连续事件，完成后可重启回放", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-match-")), "arena.sqlite");
    const first = new MatchRepository(databasePath);
    repositories.push(first);
    const prepared = first.prepareBaseline("experiment-1", "persisted-seed");
    first.appendEvents(prepared.match.id, prepared.events.slice(0, 40));

    expect(first.readEvents(prepared.match.id, 20, 10)).toMatchObject({
      match: { status: "running", committedEventCount: 40, score: null },
      nextSequence: 30,
    });
    expect(first.readEvents(prepared.match.id, 20, 10)?.events.map(({ sequence }) => sequence)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    first.appendEvents(prepared.match.id, prepared.events.slice(40), prepared.score);
    const completed = first.find(prepared.match.id)!;
    first.close();
    repositories.splice(repositories.indexOf(first), 1);

    const restarted = new MatchRepository(databasePath);
    repositories.push(restarted);
    expect(restarted.find(completed.id)).toEqual(completed);
  });

  it("冻结输入重复执行的事件和评分字节一致", () => {
    const repository = new MatchRepository(":memory:");
    repositories.push(repository);
    const first = complete(repository, "repeatable-seed");
    const second = complete(repository, "repeatable-seed");
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(JSON.stringify(first.score)).toBe(JSON.stringify(second.score));
  });

  it.each([
    ["序号缺口", (db: DatabaseSync, id: string) => db.prepare("DELETE FROM match_events WHERE match_id = ? AND sequence = 2").run(id)],
    ["评分冲突", (db: DatabaseSync, id: string) => db.prepare("UPDATE matches SET score_json = ? WHERE id = ?").run(JSON.stringify({ solved: false, actions: 62, illegalMoves: 0, backtracks: 1, remainingSteps: 1379 }), id)],
    ["完成事件缺失", (db: DatabaseSync, id: string) => db.prepare("DELETE FROM match_events WHERE match_id = ? AND sequence = (SELECT MAX(sequence) FROM match_events WHERE match_id = ?)").run(id, id)],
  ])("权威读取遇到%s时关闭失败", (_label, tamper) => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "maze-corrupt-")), "arena.sqlite");
    const repository = new MatchRepository(databasePath);
    repositories.push(repository);
    const match = complete(repository);
    const attacker = new DatabaseSync(databasePath);
    tamper(attacker, match.id);
    attacker.close();

    expect(() => repository.getMetadata(match.id)).toThrow(MatchDataCorruptError);
    expect(() => repository.getMetadata(match.id)).toThrow(/比赛权威数据损坏/);
  });
});
