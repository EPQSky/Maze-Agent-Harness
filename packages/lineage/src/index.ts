import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { validatePluginPackage, type LineageBaseline } from "@maze-arena/match-profile";

export type PluginRole = "generator" | "solver";

export interface CandidateCommitInput {
  experimentId: string;
  role: PluginRole;
  sourceRoot: string;
  attemptId: string;
  hypothesis: string;
  resultSummary: string;
  outcome: "failed" | "tie" | "public-only" | "promoted";
  generation?: number;
  lineageBaseline?: LineageBaseline;
}

export interface CandidateCommit {
  commit: string;
  role: PluginRole;
  outcome: CandidateCommitInput["outcome"];
  promotionTag?: string;
}

export interface PreparedCandidateCommitInput {
  experimentId: string;
  role: PluginRole;
  sourceRoot: string;
  attemptId: string;
  hypothesis: string;
  lineageBaseline?: LineageBaseline;
}

export interface CandidateResultInput {
  experimentId: string;
  role: PluginRole;
  attemptId: string;
  commit: string;
  hypothesis: string;
  resultSummary: string;
  outcome: CandidateCommitInput["outcome"];
  generation?: number;
}

export interface LineageEntry {
  commit: string;
  subject: string;
  tags: string[];
  kind: "baseline" | "candidate";
  attemptId: string | null;
  candidateStage: "intermediate" | "final" | null;
  outcome: CandidateCommitInput["outcome"] | null;
  generation: number | null;
}

export interface StrategyRecord {
  attemptId: string;
  strategyPlan: string;
}

export interface RegisteredLineage {
  experimentId: string;
  role: PluginRole;
  repositoryPath: string;
  baselineCommit: string;
  baselineTagObject: string;
}

interface PromotionRow {
  experiment_id: string;
  role: PluginRole;
  generation: number;
  tag_name: string;
  target_commit: string;
  metadata_json: string;
  metadata_digest: string;
  tag_object: string | null;
  state: "pending" | "complete";
}

interface CandidateResultRow {
  experiment_id: string;
  role: PluginRole;
  attempt_id: string;
  target_commit: string;
  hypothesis: string;
  result_summary: string;
  outcome: CandidateCommitInput["outcome"];
  generation: number | null;
  metadata_digest: string;
}

export class LineageTamperError extends Error {
  constructor(message: string) { super(`插件谱系完整性失败：${message}`); this.name = "LineageTamperError"; }
}

const heldMutationLocks = new Map<string, { depth: number; descriptor: number }>();

/** 在所有进程之间串行化 SQLite 与 Git 谱系写入，形成可供备份复用的一致性边界。 */
export function withLineageMutationLock<T>(root: string, callback: () => T): T {
  mkdirSync(root, { recursive: true });
  const key = resolve(root);
  const held = heldMutationLocks.get(key);
  if (held) {
    held.depth += 1;
    try { return callback(); } finally { held.depth -= 1; }
  }
  const descriptor = openSync(join(key, ".mutation.lock"), "a", 0o600);
  const executable = ["/usr/bin/flock", "/bin/flock"].find(existsSync);
  if (!executable) {
    closeSync(descriptor);
    throw new Error("插件谱系一致性边界需要 util-linux flock");
  }
  const result = spawnSync(executable, ["-x", "3"], { stdio: ["ignore", "pipe", "pipe", descriptor] });
  if (result.error || result.status !== 0) {
    closeSync(descriptor);
    throw new Error("无法取得插件谱系跨进程写锁");
  }
  heldMutationLocks.set(key, { depth: 1, descriptor });
  try { return callback(); }
  finally {
    heldMutationLocks.delete(key);
    closeSync(descriptor);
  }
}

export class PluginLineageRepository {
  private readonly database: DatabaseSync;

  constructor(private readonly root: string, databasePath: string) {
    mkdirSync(root, { recursive: true });
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    withLineageMutationLock(root, () => this.database.exec(`CREATE TABLE IF NOT EXISTS lineage_repositories (
      experiment_id TEXT NOT NULL, role TEXT NOT NULL, repository_path TEXT NOT NULL,
      baseline_commit TEXT NOT NULL, baseline_tag_object TEXT NOT NULL,
      PRIMARY KEY (experiment_id, role)
    );
    CREATE TABLE IF NOT EXISTS promotion_tags (
      experiment_id TEXT NOT NULL, role TEXT NOT NULL, generation INTEGER NOT NULL,
      tag_name TEXT NOT NULL UNIQUE, target_commit TEXT NOT NULL, metadata_json TEXT NOT NULL,
      metadata_digest TEXT NOT NULL, tag_object TEXT, state TEXT NOT NULL,
      PRIMARY KEY (experiment_id, role, generation)
    );
    CREATE TABLE IF NOT EXISTS candidate_results (
      experiment_id TEXT NOT NULL, role TEXT NOT NULL, attempt_id TEXT NOT NULL,
      target_commit TEXT NOT NULL, hypothesis TEXT NOT NULL, result_summary TEXT NOT NULL,
      outcome TEXT NOT NULL, generation INTEGER, metadata_digest TEXT NOT NULL,
      PRIMARY KEY (experiment_id, role, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS lineage_integrity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL, role TEXT NOT NULL,
      reason TEXT NOT NULL, occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocked_lineages (
      experiment_id TEXT PRIMARY KEY, reason TEXT NOT NULL
    );`));
  }

  async initialize(experimentId: string, role: PluginRole, baselineSource: string): Promise<string> {
    validateIdentity(experimentId);
    assertSafeSourceTree(baselineSource);
    await validatePluginPackage(baselineSource);
    return withLineageMutationLock(this.root, () => {
      this.ensureNotBlocked(experimentId);
      const existing = this.repositoryRow(experimentId, role);
      if (existing) { this.verifyIntegrityUnlocked(experimentId, role); return existing.baseline_commit; }
      const repository = this.repositoryPath(experimentId, role);
      if (existsSync(repository)) throw new Error(`谱系目录已存在但未登记：${repository}`);
      mkdirSync(repository, { recursive: true });
      git(repository, ["init", "--initial-branch=main"]);
      git(repository, ["config", "user.name", "Maze Arena Orchestrator"]);
      git(repository, ["config", "user.email", "arena@localhost"]);
      replaceWorktree(repository, baselineSource);
      git(repository, ["add", "-A"]);
      git(repository, ["commit", "-m", `baseline: ${role}`]);
      const baselineCommit = git(repository, ["rev-parse", "HEAD"]);
      const tagName = `baseline/${experimentId}/${role}`;
      const metadata = canonicalJson({ experimentId, role, kind: "baseline", targetCommit: baselineCommit });
      git(repository, ["tag", "-a", tagName, baselineCommit, "-m", metadata]);
      const baselineTagObject = git(repository, ["rev-parse", `${tagName}^{tag}`]);
      this.database.prepare(`INSERT INTO lineage_repositories
        (experiment_id, role, repository_path, baseline_commit, baseline_tag_object) VALUES (?, ?, ?, ?, ?)`)
        .run(experimentId, role, repository, baselineCommit, baselineTagObject);
      return baselineCommit;
    });
  }

  async commitCandidate(input: CandidateCommitInput): Promise<CandidateCommit> {
    const prepared = await this.createCandidate(input);
    return this.recordCandidateResult({ ...input, commit: prepared.commit });
  }

  async createCandidate(input: PreparedCandidateCommitInput): Promise<Pick<CandidateCommit, "commit" | "role">> {
    validateIdentity(input.experimentId);
    assertSafeSourceTree(input.sourceRoot);
    await validatePluginPackage(input.sourceRoot, input.lineageBaseline);
    return withLineageMutationLock(this.root, () => {
      this.ensureNotBlocked(input.experimentId);
      this.verifyIntegrityUnlocked(input.experimentId, input.role);
      const repository = this.repositoryPath(input.experimentId, input.role);
      const metadata = canonicalJson({ attemptId: input.attemptId, hypothesis: input.hypothesis });
      const sourceTree = sourceTreeObject(input.sourceRoot);
      const existing = findCandidateCommits(repository, input.attemptId).find((commit) =>
        git(repository, ["rev-parse", `${commit}^{tree}`]) === sourceTree
        && git(repository, ["show", "-s", "--format=%B", commit]).trim() === `candidate: ${input.attemptId}\n\n${metadata}`);
      if (existing) return { commit: existing, role: input.role };
      replaceWorktree(repository, input.sourceRoot);
      git(repository, ["add", "-A"]);
      git(repository, ["commit", "--allow-empty", "-m", `candidate: ${input.attemptId}`, "-m", metadata]);
      return { commit: git(repository, ["rev-parse", "HEAD"]), role: input.role };
    });
  }

  recordCandidateResult(input: CandidateResultInput): CandidateCommit {
    return withLineageMutationLock(this.root, () => this.recordCandidateResultUnlocked(input));
  }

  private recordCandidateResultUnlocked(input: CandidateResultInput): CandidateCommit {
    validateIdentity(input.experimentId);
    this.ensureNotBlocked(input.experimentId);
    this.verifyIntegrityUnlocked(input.experimentId, input.role);
    if (input.outcome === "promoted" && (!Number.isSafeInteger(input.generation) || (input.generation ?? 0) < 1)) {
      throw new Error("晋级候选必须提供正整数代次");
    }
    const repository = this.repositoryPath(input.experimentId, input.role);
    const resolved = optionalGit(repository, ["rev-parse", `${input.commit}^{commit}`]);
    if (resolved !== input.commit || !findCandidateCommits(repository, input.attemptId).includes(input.commit)) {
      throw new Error("候选结果目标与正式谱系提交不一致");
    }
    const metadata = canonicalJson({
      attemptId: input.attemptId, commit: input.commit, hypothesis: input.hypothesis,
      resultSummary: input.resultSummary, outcome: input.outcome,
      generation: input.generation ?? null,
    });
    const digest = sha256(metadata);
    const existing = this.database.prepare(`SELECT target_commit, metadata_digest FROM candidate_results
      WHERE experiment_id = ? AND role = ? AND attempt_id = ?`).get(input.experimentId, input.role, input.attemptId) as
      { target_commit: string; metadata_digest: string } | undefined;
    if (existing && (existing.target_commit !== input.commit || existing.metadata_digest !== digest)) {
      throw new Error("候选结果与既有可信记录冲突");
    }
    if (!existing) {
      this.database.prepare(`INSERT INTO candidate_results
        (experiment_id, role, attempt_id, target_commit, hypothesis, result_summary, outcome, generation, metadata_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.experimentId, input.role, input.attemptId, input.commit, input.hypothesis,
          input.resultSummary, input.outcome, input.generation ?? null, digest);
    }
    const promotionTag = input.outcome === "promoted"
      ? this.ensurePromotion(input.experimentId, input.role, input.generation!, input.commit, {
        attemptId: input.attemptId, hypothesis: input.hypothesis, resultSummary: input.resultSummary,
      })
      : undefined;
    return { commit: input.commit, role: input.role, outcome: input.outcome, promotionTag };
  }

  ensurePromotion(
    experimentId: string,
    role: PluginRole,
    generation: number,
    targetCommit: string,
    metadata: Record<string, string>,
  ): string {
    return withLineageMutationLock(this.root, () => this.ensurePromotionUnlocked(experimentId, role, generation, targetCommit, metadata));
  }

  private ensurePromotionUnlocked(
    experimentId: string, role: PluginRole, generation: number, targetCommit: string, metadata: Record<string, string>,
  ): string {
    this.ensureNotBlocked(experimentId);
    const repository = this.repositoryPath(experimentId, role);
    const tagName = `promotion/${experimentId}/${role}/g${String(generation).padStart(4, "0")}`;
    const metadataJson = canonicalJson({ experimentId, role, generation, targetCommit, ...metadata });
    const digest = sha256(metadataJson);
    let row = this.promotionRow(experimentId, role, generation);
    if (!row) {
      this.database.prepare(`INSERT INTO promotion_tags
        (experiment_id, role, generation, tag_name, target_commit, metadata_json, metadata_digest, tag_object, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`)
        .run(experimentId, role, generation, tagName, targetCommit, metadataJson, digest);
      row = this.promotionRow(experimentId, role, generation)!;
    }
    if (row.tag_name !== tagName || row.target_commit !== targetCommit || row.metadata_digest !== digest) {
      return this.tampered(experimentId, role, "晋级标签预期元数据冲突");
    }
    const existing = optionalGit(repository, ["rev-parse", `${tagName}^{tag}`]);
    if (row.state === "complete") {
      if (!existing || existing !== row.tag_object) return this.tampered(experimentId, role, "已完成晋级标签被删除、移动或替换");
      this.verifyTag(repository, row);
      return tagName;
    }
    if (!existing) git(repository, ["tag", "-a", tagName, targetCommit, "-m", metadataJson]);
    const tagObject = git(repository, ["rev-parse", `${tagName}^{tag}`]);
    const pending = { ...row, tag_object: tagObject };
    this.verifyTag(repository, pending);
    this.database.prepare(`UPDATE promotion_tags SET tag_object = ?, state = 'complete'
      WHERE experiment_id = ? AND role = ? AND generation = ? AND state = 'pending'`)
      .run(tagObject, experimentId, role, generation);
    return tagName;
  }

  verifyIntegrity(experimentId: string, role: PluginRole): void {
    withLineageMutationLock(this.root, () => this.verifyIntegrityUnlocked(experimentId, role));
  }

  private verifyIntegrityUnlocked(experimentId: string, role: PluginRole): void {
    this.ensureNotBlocked(experimentId);
    const repositoryRow = this.repositoryRow(experimentId, role);
    if (!repositoryRow) throw new Error(`尚未初始化 ${role} 谱系`);
    const repository = repositoryRow.repository_path;
    if (optionalGit(repository, ["remote"]) !== "") this.tampered(experimentId, role, "谱系仓库出现远程地址");
    const baselineTag = `baseline/${experimentId}/${role}`;
    const baselineObject = optionalGit(repository, ["rev-parse", `${baselineTag}^{tag}`]);
    const baselineTarget = optionalGit(repository, ["rev-parse", `${baselineTag}^{commit}`]);
    if (baselineObject !== repositoryRow.baseline_tag_object || baselineTarget !== repositoryRow.baseline_commit) {
      this.tampered(experimentId, role, "基线标签被删除、移动或替换");
    }
    const rows = this.database.prepare(`SELECT experiment_id, role, generation, tag_name, target_commit,
      metadata_json, metadata_digest, tag_object, state FROM promotion_tags WHERE experiment_id = ? AND role = ?`)
      .all(experimentId, role) as unknown as PromotionRow[];
    for (const row of rows) {
      if (row.state === "pending") this.ensurePromotionUnlocked(experimentId, role, row.generation, row.target_commit, parsePromotionMetadata(row.metadata_json));
      else {
        const actual = optionalGit(repository, ["rev-parse", `${row.tag_name}^{tag}`]);
        if (!actual || actual !== row.tag_object) this.tampered(experimentId, role, "晋级标签完整性不一致");
        this.verifyTag(repository, row);
      }
    }
    const expectedAuthorityTags = new Set([baselineTag, ...rows.map((row) => row.tag_name)]);
    const actualAuthorityTags = git(repository, ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags/baseline", "refs/tags/promotion"])
      .split("\n").filter(Boolean);
    if (actualAuthorityTags.length !== expectedAuthorityTags.size
      || actualAuthorityTags.some((tag) => !expectedAuthorityTags.has(tag))) {
      this.tampered(experimentId, role, "谱系存在数据库未声明或缺失的基线/晋级标签");
    }
    const results = this.database.prepare(`SELECT experiment_id, role, attempt_id, target_commit, hypothesis,
      result_summary, outcome, generation, metadata_digest FROM candidate_results
      WHERE experiment_id = ? AND role = ?`).all(experimentId, role) as unknown as CandidateResultRow[];
    for (const result of results) {
      const metadata = canonicalJson({
        attemptId: result.attempt_id, commit: result.target_commit, hypothesis: result.hypothesis,
        resultSummary: result.result_summary, outcome: result.outcome, generation: result.generation,
      });
      if (sha256(metadata) !== result.metadata_digest
        || !findCandidateCommits(repository, result.attempt_id).includes(result.target_commit)) {
        this.tampered(experimentId, role, "候选结果记录与 Git 提交身份不一致");
      }
    }
  }

  listHistory(experimentId: string, role: PluginRole): LineageEntry[] {
    this.verifyIntegrity(experimentId, role);
    const repository = this.repositoryPath(experimentId, role);
    const baselineCommit = this.repositoryRow(experimentId, role)!.baseline_commit;
    const results = this.database.prepare(`SELECT attempt_id, target_commit, outcome, generation FROM candidate_results
      WHERE experiment_id = ? AND role = ?`).all(experimentId, role) as unknown as Array<{
        attempt_id: string; target_commit: string; outcome: CandidateCommitInput["outcome"]; generation: number | null;
      }>;
    const resultByCommit = new Map(results.map((result) => [result.target_commit, result]));
    const lines = git(repository, ["log", "--format=%H%x09%s%x09%D", "--reverse"]).split("\n").filter(Boolean);
    return lines.map((line) => {
      const [commit = "", subject = "", decorations = ""] = line.split("\t");
      const tags = [...decorations.matchAll(/tag: ([^,)]+)/g)].map((match) => match[1]!);
      if (commit === baselineCommit) {
        return { commit, subject, tags, kind: "baseline", attemptId: null,
          candidateStage: null, outcome: null, generation: null };
      }
      const attemptId = subject.startsWith("candidate: ") ? subject.slice("candidate: ".length) : null;
      if (!attemptId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(attemptId)) {
        return this.tampered(experimentId, role, "候选提交主题缺少可信尝试标识");
      }
      const result = resultByCommit.get(commit);
      return { commit, subject, tags, kind: "candidate", attemptId,
        candidateStage: result ? "final" : "intermediate",
        outcome: result?.outcome ?? null, generation: result?.generation ?? null };
    });
  }

  listStrategyRecords(experimentId: string, role: PluginRole): StrategyRecord[] {
    this.verifyIntegrity(experimentId, role);
    const repository = this.repositoryPath(experimentId, role);
    const completed = this.database.prepare(`SELECT attempt_id, target_commit FROM candidate_results
      WHERE experiment_id = ? AND role = ? ORDER BY rowid`).all(experimentId, role) as
      Array<{ attempt_id: string; target_commit: string }>;
    const records: StrategyRecord[] = [];
    for (const { attempt_id: attemptId, target_commit: commit } of completed) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(attemptId)) {
        return this.tampered(experimentId, role, "候选提交包含非法尝试标识");
      }
      const strategyPlan = optionalGit(repository, ["show", `${commit}:lineage/${attemptId}.md`]);
      if (strategyPlan !== undefined) records.push({ attemptId, strategyPlan });
    }
    return records;
  }

  diff(experimentId: string, role: PluginRole, from: string, to: string): string {
    this.verifyIntegrity(experimentId, role);
    return git(this.repositoryPath(experimentId, role), ["diff", "--no-ext-diff", from, to, "--"]);
  }

  baselineCommit(experimentId: string, role: PluginRole): string {
    this.verifyIntegrity(experimentId, role);
    return this.repositoryRow(experimentId, role)!.baseline_commit;
  }

  materialize(experimentId: string, role: PluginRole, commit: string, destination: string): void {
    this.verifyIntegrity(experimentId, role);
    const repository = this.repositoryPath(experimentId, role);
    const resolved = optionalGit(repository, ["rev-parse", `${commit}^{commit}`]);
    if (!resolved) throw new Error(`插件提交不存在：${commit}`);
    rmSync(destination, { recursive: true, force: true });
    const clone = spawnSync("git", ["clone", "--no-hardlinks", "--no-checkout", repository, destination], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (clone.status !== 0) throw new Error(`无法克隆插件谱系提交 ${commit}`);
    git(destination, ["checkout", "--detach", resolved]);
    if (git(destination, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
      throw new Error(`插件提交 ${commit} 物化后不是干净工作树`);
    }
  }

  contains(experimentId: string, role: PluginRole, commit: string): boolean {
    this.verifyIntegrity(experimentId, role);
    return optionalGit(this.repositoryPath(experimentId, role), ["cat-file", "-e", `${commit}^{commit}`]) !== undefined;
  }

  branchFrom(sourceId: string, childId: string, role: PluginRole, selectedCommit: string): string {
    return withLineageMutationLock(this.root, () => {
      validateIdentity(childId);
      this.verifyIntegrityUnlocked(sourceId, role);
      const source = this.repositoryPath(sourceId, role);
      const resolved = optionalGit(source, ["rev-parse", `${selectedCommit}^{commit}`]);
      if (!resolved) throw new Error(`选定的 ${role} 提交不属于源实验谱系`);
      const destination = this.repositoryPath(childId, role);
      if (existsSync(destination) || this.repositoryRow(childId, role)) throw new Error(`派生 ${role} 谱系已经存在`);
      mkdirSync(dirname(destination), { recursive: true });
      assertSafeSourceTree(source);
      cpSync(source, destination, { recursive: true, dereference: false });
      const inheritedTags = git(destination, ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"])
        .split("\n").filter(Boolean);
      for (const inheritedTag of inheritedTags) git(destination, ["tag", "-d", inheritedTag]);
      const tagName = `baseline/${childId}/${role}`;
      const metadata = canonicalJson({ experimentId: childId, role, kind: "baseline", targetCommit: resolved });
      git(destination, ["tag", "-a", tagName, resolved, "-m", metadata]);
      const tagObject = git(destination, ["rev-parse", `${tagName}^{tag}`]);
      this.database.prepare(`INSERT INTO lineage_repositories
        (experiment_id, role, repository_path, baseline_commit, baseline_tag_object) VALUES (?, ?, ?, ?, ?)`)
        .run(childId, role, destination, resolved, tagObject);
      return resolved;
    });
  }

  discardDerived(experimentId: string): void {
    withLineageMutationLock(this.root, () => {
      validateIdentity(experimentId);
      const promotionCount = this.database.prepare("SELECT COUNT(*) AS count FROM promotion_tags WHERE experiment_id = ?")
        .get(experimentId) as { count: number };
      if (promotionCount.count > 0) throw new Error("不能清理已经产生候选或晋级标签的派生谱系");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM lineage_repositories WHERE experiment_id = ?").run(experimentId);
        this.database.prepare("DELETE FROM lineage_integrity_events WHERE experiment_id = ?").run(experimentId);
        this.database.prepare("DELETE FROM blocked_lineages WHERE experiment_id = ?").run(experimentId);
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
      rmSync(join(this.root, experimentId), { recursive: true, force: true });
    });
  }

  isBlocked(experimentId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM blocked_lineages WHERE experiment_id = ?").get(experimentId));
  }

  registeredLineages(): RegisteredLineage[] {
    const rows = this.database.prepare(`SELECT experiment_id, role, repository_path, baseline_commit, baseline_tag_object
      FROM lineage_repositories ORDER BY experiment_id, role`).all() as Array<{
        experiment_id: string; role: PluginRole; repository_path: string;
        baseline_commit: string; baseline_tag_object: string;
      }>;
    return rows.map((row) => ({
      experimentId: row.experiment_id,
      role: row.role,
      repositoryPath: row.repository_path,
      baselineCommit: row.baseline_commit,
      baselineTagObject: row.baseline_tag_object,
    }));
  }

  verifyAllIntegrity(): RegisteredLineage[] {
    return withLineageMutationLock(this.root, () => {
      const lineages = this.registeredLineages();
      for (const lineage of lineages) this.verifyIntegrityUnlocked(lineage.experimentId, lineage.role);
      return lineages;
    });
  }

  close(): void { this.database.close(); }

  private verifyTag(repository: string, row: PromotionRow): void {
    const target = optionalGit(repository, ["rev-parse", `${row.tag_name}^{commit}`]);
    const message = optionalGit(repository, ["for-each-ref", `refs/tags/${row.tag_name}`, "--format=%(contents)"]);
    if (target !== row.target_commit || message === undefined
      || sha256(message.trim()) !== row.metadata_digest || message.trim() !== row.metadata_json) {
      this.tampered(row.experiment_id, row.role, "晋级标签目标或元数据不一致");
    }
  }

  private tampered(experimentId: string, role: PluginRole, reason: string): never {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO lineage_integrity_events
        (experiment_id, role, reason, occurred_at) VALUES (?, ?, ?, ?)`)
        .run(experimentId, role, reason, new Date().toISOString());
      this.database.prepare("INSERT OR REPLACE INTO blocked_lineages (experiment_id, reason) VALUES (?, ?)").run(experimentId, reason);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    throw new LineageTamperError(reason);
  }

  private ensureNotBlocked(experimentId: string): void {
    const row = this.database.prepare("SELECT reason FROM blocked_lineages WHERE experiment_id = ?").get(experimentId) as { reason: string } | undefined;
    if (row) throw new LineageTamperError(`实验已因既有篡改停止：${row.reason}`);
  }

  private repositoryPath(experimentId: string, role: PluginRole): string { return join(this.root, experimentId, role); }
  private repositoryRow(experimentId: string, role: PluginRole) {
    return this.database.prepare(`SELECT experiment_id, role, repository_path, baseline_commit, baseline_tag_object
      FROM lineage_repositories WHERE experiment_id = ? AND role = ?`).get(experimentId, role) as {
        experiment_id: string; role: PluginRole; repository_path: string; baseline_commit: string; baseline_tag_object: string;
      } | undefined;
  }
  private promotionRow(experimentId: string, role: PluginRole, generation: number): PromotionRow | undefined {
    return this.database.prepare(`SELECT experiment_id, role, generation, tag_name, target_commit,
      metadata_json, metadata_digest, tag_object, state FROM promotion_tags
      WHERE experiment_id = ? AND role = ? AND generation = ?`).get(experimentId, role, generation) as unknown as PromotionRow | undefined;
  }
}

function replaceWorktree(repository: string, sourceRoot: string): void {
  assertSafeSourceTree(sourceRoot);
  for (const entry of readdirSync(repository)) if (entry !== ".git") rmSync(join(repository, entry), { recursive: true, force: true });
  copyTree(sourceRoot, repository, sourceRoot);
}

function copyTree(source: string, destination: string, root: string): void {
  for (const entry of readdirSync(source)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const from = join(source, entry);
    const local = relative(root, from);
    if (local.split(sep).includes(".git")) continue;
    const to = join(destination, entry);
    if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); copyTree(from, to, root); }
    else cpSync(from, to, { dereference: false });
  }
}

export function assertSafeSourceTree(root: string): void {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("插件源树根目录必须为真实目录");
  const canonicalRoot = realpathSync(absoluteRoot);
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === ".git" || name === "node_modules") continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`插件源树不得包含符号链接：${relative(absoluteRoot, path)}`);
      const canonical = realpathSync(path);
      const relation = relative(canonicalRoot, canonical);
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new Error(`插件源树路径越出工作区：${relative(absoluteRoot, path)}`);
      }
      if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) throw new Error(`插件源树包含不支持的文件类型：${relative(absoluteRoot, path)}`);
    }
  };
  visit(absoluteRoot);
}

function git(repository: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.status !== 0) throw new Error(`Git 操作失败：git ${args.join(" ")}\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

function optionalGit(repository: string, args: string[]): string | undefined {
  try { return git(repository, args); } catch { return undefined; }
}

function findCandidateCommits(repository: string, attemptId: string): string[] {
  const subject = `candidate: ${attemptId}`;
  return git(repository, ["log", "--all", "--format=%H%x09%s"]).split("\n")
    .filter((entry) => entry.slice(41) === subject).map((entry) => entry.slice(0, 40));
}

function sourceTreeObject(sourceRoot: string): string {
  const temporary = mkdtempSync(join(dirname(sourceRoot), ".maze-tree-"));
  try {
    git(temporary, ["init"]);
    replaceWorktree(temporary, sourceRoot);
    git(temporary, ["add", "-A"]);
    return git(temporary, ["write-tree"]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function parsePromotionMetadata(json: string): Record<string, string> {
  const value = JSON.parse(json) as Record<string, unknown>;
  const { experimentId: _experimentId, role: _role, generation: _generation, targetCommit: _targetCommit, ...metadata } = value;
  return Object.fromEntries(Object.entries(metadata).map(([key, entry]) => [key, String(entry)]));
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validateIdentity(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw new Error("实验标识不适合用作谱系命名空间");
}
