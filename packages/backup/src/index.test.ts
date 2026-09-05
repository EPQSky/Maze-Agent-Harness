import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { BackupError, RuntimeBackupManager } from "./index.js";

const roots: string[] = [];
const pluginFixture = resolve(dirname(fileURLToPath(import.meta.url)), "../../generator-plugin");

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "maze-backup-"));
  roots.push(root);
  const databasePath = join(root, "maze-arena.sqlite");
  const lineageRoot = join(root, "lineages");
  const lineage = new PluginLineageRepository(lineageRoot, databasePath);
  const baseline: Record<"generator" | "solver", string> = { generator: "", solver: "" };
  for (const role of ["generator", "solver"] as const) baseline[role] = await lineage.initialize("exp-backup", role, pluginFixture);
  const candidateRoot = join(root, "candidate");
  cpSync(pluginFixture, candidateRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
  writeFileSync(join(candidateRoot, "src/index.ts"), `${readFileSync(join(candidateRoot, "src/index.ts"), "utf8")}\n// 备份候选\n`);
  const promoted = await lineage.commitCandidate({ experimentId: "exp-backup", role: "generator", sourceRoot: candidateRoot,
    attemptId: "g0001-generator", hypothesis: "真实晋级", resultSummary: "通过", outcome: "promoted", generation: 1 });
  const solverCandidateRoot = join(root, "solver-candidate");
  cpSync(pluginFixture, solverCandidateRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
  writeFileSync(join(solverCandidateRoot, "src/index.ts"), `${readFileSync(join(solverCandidateRoot, "src/index.ts"), "utf8")}\n// 求解器平局候选\n`);
  const solverTie = await lineage.commitCandidate({ experimentId: "exp-backup", role: "solver", sourceRoot: solverCandidateRoot,
    attemptId: "g0001-solver", hypothesis: "保持冠军", resultSummary: "平局", outcome: "tie" });
  const failedRoot = join(root, "failed-candidate");
  cpSync(pluginFixture, failedRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
  writeFileSync(join(failedRoot, "src/index.ts"), `${readFileSync(join(failedRoot, "src/index.ts"), "utf8")}\n// 失败候选\n`);
  const failed = await lineage.commitCandidate({ experimentId: "exp-backup", role: "generator", sourceRoot: failedRoot,
    attemptId: "g0002-generator-failed", hypothesis: "失败候选", resultSummary: "失败", outcome: "failed" });
  lineage.close();
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE experiment_runtime (experiment_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, champions_json TEXT NOT NULL);
    CREATE TABLE generation_records (experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY (experiment_id, generation));
    CREATE TABLE generation_role_checkpoints (experiment_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL,
      attempt_id TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY (experiment_id, generation, role));`);
  const generatorResult = { candidateCommit: promoted.commit, championBefore: baseline.generator,
    championAfter: promoted.commit, outcome: "promoted", promotionTag: "promotion/exp-backup/generator/g0001",
    publicProgress: 1, hiddenProgress: 1, aggregate: {}, attemptId: "g0001-generator" };
  const solverResult = { candidateCommit: solverTie.commit, championBefore: baseline.solver,
    championAfter: baseline.solver, outcome: "tie", promotionTag: null,
    publicProgress: 1, hiddenProgress: 1, aggregate: {}, attemptId: "g0001-solver" };
  database.prepare("INSERT INTO experiment_runtime VALUES (?, 1, ?)")
    .run("exp-backup", JSON.stringify({ generator: promoted.commit, solver: baseline.solver }));
  database.prepare("INSERT INTO generation_records VALUES (?, 1, ?)")
    .run("exp-backup", JSON.stringify({ generation: 1, status: "completed", generator: generatorResult,
      solver: solverResult, exhibitionMatchId: null, stagnationCount: 0 }));
  database.prepare("INSERT INTO generation_role_checkpoints VALUES (?, 1, 'generator', ?, ?)")
    .run("exp-backup", "g0001-generator", JSON.stringify(generatorResult));
  database.prepare("INSERT INTO generation_role_checkpoints VALUES (?, 1, 'solver', ?, ?)")
    .run("exp-backup", "g0001-solver", JSON.stringify(solverResult));
  database.prepare("INSERT INTO generation_role_checkpoints VALUES (?, 2, 'generator', ?, ?)")
    .run("exp-backup", "g0002-generator-failed", JSON.stringify({ candidateCommit: failed.commit,
      championBefore: promoted.commit, championAfter: promoted.commit, outcome: "failed", promotionTag: null,
      publicProgress: 1, hiddenProgress: 0, aggregate: {}, attemptId: "g0002-generator-failed" }));
  database.close();
  const manager = new RuntimeBackupManager({
    databasePath, lineageRoot, backupsRoot: join(root, "backups"),
    runtimeIdentity: { harnessCommit: "a".repeat(40), harnessVersion: "dsh 1", modelCatalogRelease: "catalog-1", imageDigest: `sha256:${"b".repeat(64)}` },
  });
  return { root, databasePath, lineageRoot, manager, baseline, promoted, solverTie, failed };
}

function rewriteManifest(path: string, mutate: (manifest: any) => void): void {
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, serialized);
  writeFileSync(join(path, "manifest.sha256"), `${createHash("sha256").update(serialized).digest("hex")}  manifest.json\n`);
}

function rewriteBackupDatabase(path: string, mutate: (database: DatabaseSync) => void): void {
  const databasePath = join(path, "maze-arena.sqlite");
  const database = new DatabaseSync(databasePath);
  try { mutate(database); } finally { database.close(); }
  rewriteManifest(path, (manifest) => {
    const artifact = manifest.artifacts.find((entry: { path: string }) => entry.path === "maze-arena.sqlite");
    const bytes = readFileSync(databasePath);
    artifact.bytes = bytes.byteLength;
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

function expectBackupRejected(fixture: Awaited<ReturnType<typeof setup>>, path: string, pattern: RegExp): void {
  expect(() => fixture.manager.verify(path)).toThrow(pattern);
  const target = `${fixture.root}-rejected-${createHash("sha256").update(path + pattern.source).digest("hex").slice(0, 8)}`;
  roots.push(target);
  expect(() => fixture.manager.restore(path, target)).toThrow(pattern);
  expect(existsSync(target)).toBe(false);
}

function waitForLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) resolvePromise();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes(expected)) reject(new Error(`并发子进程提前退出：${code ?? "unknown"}`));
    });
  });
}

describe("SQLite 与 Git 双权威一致性备份", () => {
  it("捕获 WAL 一致快照、候选对象和附注晋级标签，并在隔离目标恢复后复验", async () => {
    const { root, manager, promoted } = await setup();
    const created = manager.create("manual");
    expect(created.manifest.repositories).toHaveLength(2);
    expect(created.manifest.artifacts.map(({ path }) => path)).toEqual([
      "maze-arena.sqlite", "repositories/exp-backup/generator.bundle", "repositories/exp-backup/solver.bundle",
    ]);
    expect(created.manifest.protection).toBe("os-managed");
    expect(manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${root}-isolated-restore`;
    roots.push(target);
    manager.restore(created.path, target);
    expect(existsSync(join(target, "maze-arena.sqlite"))).toBe(true);
    const restored = new PluginLineageRepository(join(target, "lineages"), join(target, "maze-arena.sqlite"));
    expect(restored.contains("exp-backup", "generator", promoted.commit)).toBe(true);
    expect(restored.listHistory("exp-backup", "generator").some(({ tags }) =>
      tags.includes("promotion/exp-backup/generator/g0001"))).toBe(true);
    const continuedRoot = join(root, "continued-candidate");
    cpSync(pluginFixture, continuedRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
    const continuedSource = join(continuedRoot, "src/index.ts");
    writeFileSync(continuedSource, `${readFileSync(continuedSource, "utf8")}\n// 恢复后继续候选\n`);
    const continued = await restored.commitCandidate({ experimentId: "exp-backup", role: "generator", sourceRoot: continuedRoot,
      attemptId: "g0002-generator", hypothesis: "恢复后继续", resultSummary: "平局", outcome: "tie" });
    expect(continued.commit).toMatch(/^[0-9a-f]{40}$/);
    restored.close();
  });

  it("检测缺失数据库、摘要损坏、标签漂移、清单冲突和单 SQLite 副本", async () => {
    const { root, manager } = await setup();
    const created = manager.create("manual");
    const database = join(created.path, "maze-arena.sqlite");
    const bytes = readFileSync(database);
    rmSync(database);
    expect(() => manager.verify(created.path)).toThrow(/SQLite|产物|文件集合/);
    writeFileSync(database, bytes);
    const missingRepository = join(created.path, "repositories/exp-backup/generator.bundle");
    const repositoryBytes = readFileSync(missingRepository);
    rmSync(missingRepository);
    expect(() => manager.verify(created.path)).toThrow(/谱系|产物|文件集合/);
    writeFileSync(missingRepository, repositoryBytes);
    writeFileSync(join(created.path, "manifest.sha256"), "0".repeat(64) + "  manifest.json\n");
    expect(() => manager.verify(created.path)).toThrow(/清单摘要损坏/);

    const fresh = manager.create("manual");
    const restore = join(root, "single-sqlite");
    writeFileSync(restore, readFileSync(join(fresh.path, "maze-arena.sqlite")));
    expect(() => manager.restore(restore, `${root}-refused`)).toThrow(/备份目录/);

    const manifestPath = join(fresh.path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.repositories[0].experimentId = "conflict";
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, serialized);
    const digest = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(fresh.path, "manifest.sha256"), `${digest}  manifest.json\n`);
    expect(() => manager.verify(fresh.path)).toThrow(/冲突|缺少/);

    const drifted = manager.create("manual");
    const bundlePath = join(drifted.path, "repositories/exp-backup/generator.bundle");
    const repository = join(root, "drifted-repository");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, repository]).status).toBe(0);
    const baseline = spawnSync("git", ["-C", repository, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(spawnSync("git", ["-C", repository, "tag", "-f", "promotion/exp-backup/generator/g0001", baseline]).status).toBe(0);
    rmSync(bundlePath);
    expect(spawnSync("git", ["-C", repository, "bundle", "create", bundlePath, "--all"]).status).toBe(0);
    const driftManifestPath = join(drifted.path, "manifest.json");
    const driftManifest = JSON.parse(readFileSync(driftManifestPath, "utf8"));
    const driftArtifact = driftManifest.artifacts.find((entry: { path: string }) => entry.path.endsWith("generator.bundle"));
    const driftBytes = readFileSync(bundlePath);
    driftArtifact.bytes = driftBytes.byteLength;
    driftArtifact.sha256 = createHash("sha256").update(driftBytes).digest("hex");
    const driftRepository = driftManifest.repositories.find((entry: { role: string }) => entry.role === "generator");
    driftRepository.refsSha256 = createHash("sha256")
      .update(spawnSync("git", ["-C", repository, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort().join("\n") + "\n").digest("hex");
    driftRepository.objectsSha256 = createHash("sha256")
      .update(spawnSync("git", ["-C", repository, "rev-list", "--objects", "--all"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort().join("\n") + "\n").digest("hex");
    const driftSerialized = `${JSON.stringify(driftManifest, null, 2)}\n`;
    writeFileSync(driftManifestPath, driftSerialized);
    writeFileSync(join(drifted.path, "manifest.sha256"), `${createHash("sha256").update(driftSerialized).digest("hex")}  manifest.json\n`);
    expect(() => manager.verify(drifted.path)).toThrow(/标签|谱系完整性/);
  });

  it("保留最近十份完整备份，清理失败时保留可恢复点并报告警告", async () => {
    const fixture = await setup();
    let sequence = 0;
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath, lineageRoot: fixture.lineageRoot, backupsRoot: join(fixture.root, "backups"),
      runtimeIdentity: { harnessCommit: "a".repeat(40), harnessVersion: "dsh 1", modelCatalogRelease: "catalog", imageDigest: `sha256:${"b".repeat(64)}` },
      now: () => new Date(Date.UTC(2026, 8, 5, 0, 0, sequence++)),
      removeBackup: (path) => { if (path.includes("00-00-00")) throw new Error("disk busy"); rmSync(path, { recursive: true }); },
    });
    let latest = manager.create("manual");
    for (let index = 0; index < 10; index += 1) latest = manager.create("manual");
    expect(latest.rotationWarnings).toHaveLength(1);
    expect(readdirSync(join(fixture.root, "backups")).filter((name) => !name.startsWith("."))).toHaveLength(11);
    expect(manager.latestComplete()?.manifest.backupId).toBe(latest.manifest.backupId);
  }, 15_000);

  it("运行数据包含 API Key 时不发布不完整备份", async () => {
    const fixture = await setup();
    const secret = "sk-ticket11-secret-value";
    const database = new DatabaseSync(fixture.databasePath);
    database.exec("CREATE TABLE secret_probe (value TEXT)");
    database.prepare("INSERT INTO secret_probe VALUES (?)").run(secret);
    database.close();
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath, lineageRoot: fixture.lineageRoot, backupsRoot: join(fixture.root, "secret-backups"),
      runtimeIdentity: { harnessCommit: "a".repeat(40), harnessVersion: "dsh 1", modelCatalogRelease: "catalog", imageDigest: `sha256:${"b".repeat(64)}` },
      sensitiveValues: [secret],
    });
    expect(() => manager.create("manual")).toThrow(BackupError);
    expect(readdirSync(join(fixture.root, "secret-backups"))).toEqual([]);
  });

  it("拒绝把恢复目标放入正式数据树或覆盖其父目录", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    expect(() => fixture.manager.restore(created.path, join(fixture.root, "lineages/restored"))).toThrow(/隔离/);
    expect(() => fixture.manager.restore(created.path, dirname(fixture.root))).toThrow(/隔离/);
  });

  it("拒绝数据库未声明的额外晋级标签", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    expect(spawnSync("git", ["-C", repository, "tag", "-a", "promotion/exp-backup/generator/g9999",
      fixture.promoted.commit, "-m", "forged"]).status).toBe(0);
    expect(() => fixture.manager.create("manual")).toThrow(/未声明|基线\/晋级标签/);
    expect(readdirSync(join(fixture.root, "backups"))).toEqual([]);
  });

  it("正式校验逐项绑定当前运行身份，即使重算清单摘要也拒绝替换", async () => {
    const fixture = await setup();
    const replacements = {
      harnessCommit: "c".repeat(40),
      harnessVersion: "dsh 2",
      modelCatalogRelease: "catalog-2",
      imageDigest: `sha256:${"d".repeat(64)}`,
    };
    for (const field of Object.keys(replacements) as Array<keyof typeof replacements>) {
      const created = fixture.manager.create("manual");
      rewriteManifest(created.path, (manifest) => { manifest.runtimeIdentity[field] = replacements[field]; });
      expect(() => fixture.manager.verify(created.path)).toThrow(new RegExp(`运行身份.*${field}`));
    }
  });

  it("备份等待跨进程晋级完成后再捕获同一代 SQLite 与 Git 标签", async () => {
    const fixture = await setup();
    const cleanup = new DatabaseSync(fixture.databasePath);
    cleanup.prepare("DELETE FROM generation_role_checkpoints WHERE experiment_id = 'exp-backup' AND generation = 2 AND role = 'generator'").run();
    cleanup.prepare("DELETE FROM candidate_results WHERE experiment_id = 'exp-backup' AND role = 'generator' AND attempt_id = 'g0002-generator-failed'").run();
    cleanup.close();
    const nextRoot = join(fixture.root, "concurrent-candidate");
    cpSync(pluginFixture, nextRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
    writeFileSync(join(nextRoot, "src/index.ts"), `${readFileSync(join(nextRoot, "src/index.ts"), "utf8")}\n// 并发晋级候选\n`);
    const preparing = new PluginLineageRepository(fixture.lineageRoot, fixture.databasePath);
    const next = await preparing.createCandidate({ experimentId: "exp-backup", role: "generator", sourceRoot: nextRoot,
      attemptId: "g0002-generator", hypothesis: "并发晋级" });
    preparing.close();
    const script = `
      import { PluginLineageRepository, withLineageMutationLock } from "@maze-arena/lineage";
      import { DatabaseSync } from "node:sqlite";
      const [root, databasePath, commit, championBefore] = process.argv.slice(1);
      withLineageMutationLock(root, () => {
        process.stdout.write("locked\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        const lineage = new PluginLineageRepository(root, databasePath);
        const candidate = lineage.recordCandidateResult({
          experimentId: "exp-backup", role: "generator", commit, attemptId: "g0002-generator",
          hypothesis: "并发晋级", resultSummary: "通过", outcome: "promoted", generation: 2,
        });
        lineage.close();
        const result = { candidateCommit: commit, championBefore, championAfter: commit, outcome: "promoted",
          promotionTag: candidate.promotionTag, publicProgress: 1, hiddenProgress: 1, aggregate: {},
          attemptId: "g0002-generator" };
        const database = new DatabaseSync(databasePath);
        database.prepare("INSERT INTO generation_role_checkpoints (experiment_id, generation, role, attempt_id, result_json) VALUES (?, 2, 'generator', ?, ?)")
          .run("exp-backup", "g0002-generator", JSON.stringify(result));
        database.close();
      });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script,
      fixture.lineageRoot, fixture.databasePath, next.commit, fixture.promoted.commit], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForLine(child, "locked\n");
    const started = Date.now();
    const created = fixture.manager.create("manual");
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(created.manifest.repositories.find((entry) => entry.role === "generator")?.refs
      .map((ref) => ref.name)).toContain("refs/tags/promotion/exp-backup/generator/g0002");
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
  });

  it.each([
    ["tie", "solver", (fixture: Awaited<ReturnType<typeof setup>>) => fixture.solverTie.commit],
    ["failed", "generator", (fixture: Awaited<ReturnType<typeof setup>>) => fixture.failed.commit],
  ] as const)("重算摘要后仍拒绝 %s 候选冒充正式冠军", async (_outcome, role, candidate) => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    rewriteBackupDatabase(created.path, (database) => {
      const row = database.prepare("SELECT champions_json FROM experiment_runtime WHERE experiment_id = 'exp-backup'")
        .get() as { champions_json: string };
      const champions = JSON.parse(row.champions_json);
      champions[role] = candidate(fixture);
      database.prepare("UPDATE experiment_runtime SET champions_json = ? WHERE experiment_id = 'exp-backup'")
        .run(JSON.stringify(champions));
    });
    expectBackupRejected(fixture, created.path, /最终冠军未获代次链授权/);
  });

  it("重算摘要后仍拒绝缺失、错代和游离的晋级授权", async () => {
    const missing = await setup();
    const missingBackup = missing.manager.create("manual");
    rewriteBackupDatabase(missingBackup.path, (database) => {
      database.prepare("DELETE FROM promotion_tags WHERE experiment_id = 'exp-backup' AND role = 'generator' AND generation = 1").run();
    });
    expectBackupRejected(missing, missingBackup.path, /标签|晋级|谱系完整性/);

    const wrongGeneration = await setup();
    const wrongBackup = wrongGeneration.manager.create("manual");
    rewriteBackupDatabase(wrongBackup.path, (database) => {
      database.prepare("UPDATE promotion_tags SET generation = 2 WHERE experiment_id = 'exp-backup' AND role = 'generator'").run();
    });
    expectBackupRejected(wrongGeneration, wrongBackup.path, /标签|晋级|谱系完整性/);

    const orphan = await setup();
    const lineage = new PluginLineageRepository(orphan.lineageRoot, orphan.databasePath);
    lineage.ensurePromotion("exp-backup", "generator", 2, orphan.failed.commit, {
      attemptId: "orphan-failed", hypothesis: "伪造游离晋级", resultSummary: "不应授权",
    });
    lineage.close();
    expect(() => orphan.manager.create("manual")).toThrow(/候选结果|晋级标签|恢复检查点/);
  });

  it("重算摘要后仍拒绝代次断链、跳代和候选 outcome 不一致", async () => {
    const disconnected = await setup();
    const disconnectedBackup = disconnected.manager.create("manual");
    rewriteBackupDatabase(disconnectedBackup.path, (database) => {
      const row = database.prepare("SELECT record_json FROM generation_records WHERE experiment_id = 'exp-backup' AND generation = 1")
        .get() as { record_json: string };
      const record = JSON.parse(row.record_json);
      record.generator.championBefore = "e".repeat(40);
      database.prepare("UPDATE generation_records SET record_json = ? WHERE experiment_id = 'exp-backup' AND generation = 1")
        .run(JSON.stringify(record));
    });
    expectBackupRejected(disconnected, disconnectedBackup.path, /冠军链断裂|检查点.*冲突/);

    const skipped = await setup();
    const skippedBackup = skipped.manager.create("manual");
    rewriteBackupDatabase(skippedBackup.path, (database) => {
      database.prepare("UPDATE generation_records SET generation = 2 WHERE experiment_id = 'exp-backup' AND generation = 1").run();
    });
    expectBackupRejected(skipped, skippedBackup.path, /断链|跳代|数量/);

    const outcome = await setup();
    const outcomeBackup = outcome.manager.create("manual");
    rewriteBackupDatabase(outcomeBackup.path, (database) => {
      const row = database.prepare(`SELECT attempt_id, target_commit, hypothesis, result_summary FROM candidate_results
        WHERE experiment_id = 'exp-backup' AND role = 'generator' AND attempt_id = 'g0001-generator'`).get() as {
          attempt_id: string; target_commit: string; hypothesis: string; result_summary: string;
        };
      const metadata = canonicalJson({ attemptId: row.attempt_id, commit: row.target_commit, hypothesis: row.hypothesis,
        resultSummary: row.result_summary, outcome: "tie", generation: null });
      database.prepare(`UPDATE candidate_results SET outcome = 'tie', generation = NULL, metadata_digest = ?
        WHERE experiment_id = 'exp-backup' AND role = 'generator' AND attempt_id = 'g0001-generator'`)
        .run(createHash("sha256").update(metadata).digest("hex"));
    });
    expectBackupRejected(outcome, outcomeBackup.path, /候选结果与权威记录不一致/);
  });

  it("正常两代链与派生实验第零代冠军均可备份并隔离恢复", async () => {
    const fixture = await setup();
    const solverRoot = join(fixture.root, "generation-2-solver");
    cpSync(pluginFixture, solverRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
    writeFileSync(join(solverRoot, "src/index.ts"), `${readFileSync(join(solverRoot, "src/index.ts"), "utf8")}\n// 第二代求解器平局\n`);
    const lineage = new PluginLineageRepository(fixture.lineageRoot, fixture.databasePath);
    const solver = await lineage.commitCandidate({ experimentId: "exp-backup", role: "solver", sourceRoot: solverRoot,
      attemptId: "g0002-solver", hypothesis: "第二代保持", resultSummary: "平局", outcome: "tie" });
    const childGenerator = lineage.branchFrom("exp-backup", "exp-derived", "generator", fixture.promoted.commit);
    const childSolver = lineage.branchFrom("exp-backup", "exp-derived", "solver", fixture.baseline.solver);
    lineage.close();

    const generatorResult = { candidateCommit: fixture.failed.commit, championBefore: fixture.promoted.commit,
      championAfter: fixture.promoted.commit, outcome: "failed", promotionTag: null,
      publicProgress: 1, hiddenProgress: 0, aggregate: {}, attemptId: "g0002-generator-failed" };
    const solverResult = { candidateCommit: solver.commit, championBefore: fixture.baseline.solver,
      championAfter: fixture.baseline.solver, outcome: "tie", promotionTag: null,
      publicProgress: 1, hiddenProgress: 1, aggregate: {}, attemptId: "g0002-solver" };
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("INSERT INTO generation_role_checkpoints VALUES (?, 2, 'solver', ?, ?)")
      .run("exp-backup", "g0002-solver", JSON.stringify(solverResult));
    database.prepare("INSERT INTO generation_records VALUES (?, 2, ?)").run("exp-backup", JSON.stringify({
      generation: 2, status: "completed", generator: generatorResult, solver: solverResult,
      exhibitionMatchId: null, stagnationCount: 1,
    }));
    database.prepare("UPDATE experiment_runtime SET generation = 2 WHERE experiment_id = 'exp-backup'").run();
    database.prepare("INSERT INTO experiment_runtime VALUES (?, 0, ?)")
      .run("exp-derived", JSON.stringify({ generator: childGenerator, solver: childSolver }));
    database.close();

    const created = fixture.manager.create("manual");
    const target = `${fixture.root}-two-generation-restore`;
    roots.push(target);
    fixture.manager.restore(created.path, target);
    const restored = new DatabaseSync(join(target, "maze-arena.sqlite"), { readOnly: true });
    try {
      expect(restored.prepare("SELECT generation, champions_json FROM experiment_runtime WHERE experiment_id = 'exp-backup'").get())
        .toEqual({ generation: 2, champions_json: JSON.stringify({ generator: fixture.promoted.commit, solver: fixture.baseline.solver }) });
      expect(restored.prepare("SELECT generation, champions_json FROM experiment_runtime WHERE experiment_id = 'exp-derived'").get())
        .toEqual({ generation: 0, champions_json: JSON.stringify({ generator: childGenerator, solver: childSolver }) });
    } finally { restored.close(); }
  });

  it("同库正式运行时与未确认纯基线谱系可共同创建、校验和恢复", async () => {
    const fixture = await setup();
    const lineage = new PluginLineageRepository(fixture.lineageRoot, fixture.databasePath);
    await lineage.initialize("validated-draft", "generator", pluginFixture);
    await lineage.initialize("validated-draft", "solver", pluginFixture);
    lineage.close();

    const created = fixture.manager.create("experiment-start");
    expect(fixture.manager.verify(created.path).repositories).toHaveLength(4);
    const target = `${fixture.root}-mixed-restore`;
    roots.push(target);
    fixture.manager.restore(created.path, target);
    const restored = new PluginLineageRepository(join(target, "lineages"), join(target, "maze-arena.sqlite"));
    try {
      expect(restored.verifyAllIntegrity().filter(({ experimentId }) => experimentId === "validated-draft"))
        .toHaveLength(2);
    } finally { restored.close(); }
  });

  it.each(["tie", "promoted"] as const)("无运行时谱系包含游离 %s 候选事实时拒绝备份", async (outcome) => {
    const fixture = await setup();
    const lineage = new PluginLineageRepository(fixture.lineageRoot, fixture.databasePath);
    await lineage.initialize("validated-draft", "generator", pluginFixture);
    await lineage.initialize("validated-draft", "solver", pluginFixture);
    const candidateRoot = join(fixture.root, `draft-${outcome}`);
    cpSync(pluginFixture, candidateRoot, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.includes("/dist") });
    writeFileSync(join(candidateRoot, "src/index.ts"), `${readFileSync(join(candidateRoot, "src/index.ts"), "utf8")}\n// 未确认游离候选\n`);
    await lineage.commitCandidate({ experimentId: "validated-draft", role: "generator", sourceRoot: candidateRoot,
      attemptId: `draft-${outcome}`, hypothesis: "未确认候选", resultSummary: "不得进入备份",
      outcome, generation: outcome === "promoted" ? 1 : undefined });
    lineage.close();
    expect(() => fixture.manager.create("manual")).toThrow(/未确认基线谱系.*游离候选、晋级或代次事实/);
  });
});
