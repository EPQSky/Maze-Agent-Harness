import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LineageTamperError, PluginLineageRepository } from "./index.js";

const open: PluginLineageRepository[] = [];
afterEach(() => open.splice(0).forEach((repository) => repository.close()));
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../generator-plugin");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "maze-lineage-"));
  const databasePath = join(root, "arena.sqlite");
  const repository = new PluginLineageRepository(join(root, "repos"), databasePath);
  open.push(repository);
  return { root, databasePath, repository };
}

function candidate(root: string, suffix: string) {
  const destination = join(root, `candidate-${suffix}`);
  cpSync(fixture, destination, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
  const source = join(destination, "src/index.ts");
  writeFileSync(source, `${readFileSync(source, "utf8")}\n// 候选 ${suffix}\n`);
  return destination;
}

describe("插件 Git 谱系与晋级标签", () => {
  it("每个角色创建无远程独立仓库并以基线提交开始", async () => {
    const { root, repository } = setup();
    const generator = await repository.initialize("exp-1", "generator", fixture);
    const solver = await repository.initialize("exp-1", "solver", fixture);
    expect(generator).toMatch(/^[0-9a-f]{40}$/);
    expect(solver).toMatch(/^[0-9a-f]{40}$/);
    for (const role of ["generator", "solver"] as const) {
      const repo = join(root, "repos", "exp-1", role);
      expect(spawnSync("git", ["-C", repo, "remote"], { encoding: "utf8" }).stdout).toBe("");
      expect(spawnSync("git", ["-C", repo, "tag", "--list"], { encoding: "utf8" }).stdout)
        .toContain(`baseline/exp-1/${role}`);
    }
  });

  it("保存所有候选，只有明确晋级创建命名空间附注标签", async () => {
    const { root, repository } = setup();
    await repository.initialize("exp-2", "generator", fixture);
    const failed = await repository.commitCandidate({
      experimentId: "exp-2", role: "generator", sourceRoot: candidate(root, "failed"), attemptId: "a1",
      hypothesis: "失败假设", resultSummary: "未通过", outcome: "failed",
    });
    const promoted = await repository.commitCandidate({
      experimentId: "exp-2", role: "generator", sourceRoot: candidate(root, "promoted"), attemptId: "a2",
      hypothesis: "成功假设", resultSummary: "通过", outcome: "promoted", generation: 3,
    });
    expect(failed.promotionTag).toBeUndefined();
    expect(promoted.promotionTag).toBe("promotion/exp-2/generator/g0003");
    expect(repository.listHistory("exp-2", "generator")).toHaveLength(3);
    expect(repository.diff("exp-2", "generator", failed.commit, promoted.commit)).toContain("候选 promoted");
  });

  it("晋级标签重复恢复幂等且 SQLite 保存对象身份", async () => {
    const { root, databasePath, repository } = setup();
    await repository.initialize("exp-3", "generator", fixture);
    const promoted = await repository.commitCandidate({
      experimentId: "exp-3", role: "generator", sourceRoot: candidate(root, "idempotent"), attemptId: "a1",
      hypothesis: "幂等", resultSummary: "通过", outcome: "promoted", generation: 1,
    });
    expect(repository.ensurePromotion("exp-3", "generator", 1, promoted.commit, {
      attemptId: "a1", hypothesis: "幂等", resultSummary: "通过",
    })).toBe(promoted.promotionTag);
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT state, tag_object, target_commit FROM promotion_tags").get() as Record<string, unknown>;
    database.close();
    expect(row).toMatchObject({ state: "complete", target_commit: promoted.commit });
    expect(row.tag_object).toMatch(/^[0-9a-f]{40}$/);
  });

  it("相同 attemptId 的候选提交在检查点崩溃恢复时不重复写入 Git", async () => {
    const { root, repository } = setup();
    await repository.initialize("exp-retry", "generator", fixture);
    const input = {
      experimentId: "exp-retry", role: "generator" as const, sourceRoot: candidate(root, "retry"), attemptId: "g0001-generator",
      hypothesis: "恢复候选", resultSummary: "平局", outcome: "failed" as const,
    };
    const first = await repository.commitCandidate(input);
    const repeated = await repository.commitCandidate(input);

    expect(repeated).toEqual(first);
    expect(repository.listHistory("exp-retry", "generator")).toHaveLength(2);
  });

  it("幂等恢复晋级候选时仍要求有效代次", async () => {
    const { root, repository } = setup();
    await repository.initialize("exp-promoted-retry", "generator", fixture);
    const input = {
      experimentId: "exp-promoted-retry", role: "generator" as const, sourceRoot: candidate(root, "promoted-retry"),
      attemptId: "g0001-generator", hypothesis: "恢复晋级", resultSummary: "通过", outcome: "promoted" as const, generation: 1,
    };
    await repository.commitCandidate(input);

    await expect(repository.commitCandidate({ ...input, generation: undefined })).rejects.toThrow(/正整数代次/);
    expect(repository.listHistory("exp-promoted-retry", "generator")).toHaveLength(2);
  });

  it("标签删除后记录篡改并永久阻止实验继续", async () => {
    const { root, repository } = setup();
    await repository.initialize("exp-4", "generator", fixture);
    await repository.commitCandidate({
      experimentId: "exp-4", role: "generator", sourceRoot: candidate(root, "tamper"), attemptId: "a1",
      hypothesis: "篡改测试", resultSummary: "通过", outcome: "promoted", generation: 1,
    });
    spawnSync("git", ["-C", join(root, "repos", "exp-4", "generator"), "tag", "-d", "promotion/exp-4/generator/g0001"]);
    expect(() => repository.verifyIntegrity("exp-4", "generator")).toThrow(LineageTamperError);
    expect(repository.isBlocked("exp-4")).toBe(true);
    await expect(repository.commitCandidate({
      experimentId: "exp-4", role: "generator", sourceRoot: candidate(root, "blocked"), attemptId: "a2",
      hypothesis: "不应继续", resultSummary: "无", outcome: "failed",
    })).rejects.toThrow(/实验已因既有篡改停止/);
  });

  it("生成器与求解器同代晋级标签相互独立", async () => {
    const { root, repository } = setup();
    await repository.initialize("exp-5", "generator", fixture);
    await repository.initialize("exp-5", "solver", fixture);
    const generator = await repository.commitCandidate({ experimentId: "exp-5", role: "generator", sourceRoot: candidate(root, "g"), attemptId: "g1", hypothesis: "g", resultSummary: "ok", outcome: "promoted", generation: 2 });
    const solver = await repository.commitCandidate({ experimentId: "exp-5", role: "solver", sourceRoot: candidate(root, "s"), attemptId: "s1", hypothesis: "s", resultSummary: "ok", outcome: "promoted", generation: 2 });
    expect(generator.promotionTag).toBe("promotion/exp-5/generator/g0002");
    expect(solver.promotionTag).toBe("promotion/exp-5/solver/g0002");
  });
});
