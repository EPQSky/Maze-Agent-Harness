import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { PluginLineageRepository, withLineageMutationLock, type PluginRole, type RegisteredLineage } from "@maze-arena/lineage";

export type BackupTrigger = "manual" | "experiment-start" | "experiment-terminal";

export interface BackupRuntimeIdentity {
  harnessCommit: string;
  harnessVersion: string;
  modelCatalogRelease: string;
  imageDigest: string;
}

interface BackupArtifact { path: string; bytes: number; sha256: string }
interface BackupRef { name: string; objectId: string }
interface BackupRepository {
  experimentId: string;
  role: PluginRole;
  sourcePath: string;
  bundlePath: string;
  refsSha256: string;
  objectsSha256: string;
  refs: BackupRef[];
}

export interface BackupManifest {
  schemaVersion: 1;
  backupId: string;
  createdAt: string;
  trigger: BackupTrigger;
  database: { path: string; journalMode: "wal"; integrityCheck: "ok" };
  repositories: BackupRepository[];
  runtimeIdentity: BackupRuntimeIdentity;
  artifacts: BackupArtifact[];
  protection: "os-managed";
}

export interface BackupResult { path: string; manifest: BackupManifest; rotationWarnings: string[] }
export interface BackupManagerOptions {
  databasePath: string;
  lineageRoot: string;
  backupsRoot: string;
  runtimeIdentity: BackupRuntimeIdentity;
  sensitiveValues?: string[];
  now?: () => Date;
  removeBackup?: (path: string) => void;
}

export class BackupError extends Error {
  constructor(message: string) { super(message); this.name = "BackupError"; }
}

const manifestName = "manifest.json";
const manifestDigestName = "manifest.sha256";
const databaseName = "maze-arena.sqlite";

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new BackupError("谱系实验身份不能安全写入备份路径");
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(resolve(parent), resolve(child));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function runGit(repository: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8", maxBuffer, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error) throw new BackupError(`无法执行 Git 备份操作：${result.error.message}`);
  if (result.status !== 0) throw new BackupError(`Git 备份操作失败（退出码 ${result.status ?? "未知"}）`);
  return result.stdout.trim();
}

function assertPlainFile(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new BackupError(`${label}缺失`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BackupError(`${label}必须是普通文件`);
}

function assertPlainDirectory(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new BackupError(`${label}缺失`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackupError(`${label}必须是普通目录`);
}

function sqliteQuote(path: string): string { return `'${path.replaceAll("'", "''")}'`; }

function verifySqlite(path: string): void {
  assertPlainFile(path, "SQLite 备份");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new BackupError("SQLite 完整性校验失败");
  } finally { database.close(); }
}

function backupFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new BackupError("备份目录不得包含符号链接");
    if (stat.isDirectory()) files.push(...backupFiles(root, path));
    else if (stat.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new BackupError("备份目录包含不受支持的文件类型");
  }
  return files;
}

function artifact(root: string, path: string): BackupArtifact {
  const local = relative(root, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new BackupError("备份产物越出暂存目录");
  const content = readFileSync(path);
  return { path: local.split(sep).join("/"), bytes: content.byteLength, sha256: sha256(content) };
}

function normalizedSecrets(values: string[] | undefined): Buffer[] {
  return [...new Set((values ?? []).filter((value) => value.length >= 8))].map((value) => Buffer.from(value));
}

function assertNoSensitiveBytes(path: string, secrets: Buffer[]): void {
  if (secrets.length === 0) return;
  const content = readFileSync(path);
  if (secrets.some((secret) => content.includes(secret))) throw new BackupError("运行数据包含 API Key，拒绝写入备份");
}

function assertRepositoryHasNoSecrets(repository: string, secrets: Buffer[]): void {
  if (secrets.length === 0) return;
  const objects = runGit(repository, ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean)
    .map((line) => line.split(" ", 1)[0]!).filter(Boolean);
  for (const object of objects) {
    const type = runGit(repository, ["cat-file", "-t", object]);
    if (type === "tree") continue;
    const result = spawnSync("git", ["-C", repository, "cat-file", type, object], {
      encoding: null, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (result.error || result.status !== 0) throw new BackupError("无法检查谱系对象中的 API Key");
    const content = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    if (secrets.some((secret) => content.includes(secret))) throw new BackupError("插件谱系包含 API Key，拒绝写入备份");
  }
}

function repositoryFingerprint(repository: string): { refsSha256: string; objectsSha256: string; refs: BackupRef[] } {
  const refs = runGit(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"])
    .split("\n").filter(Boolean).sort().map((line) => {
      const [name, objectId, extra] = line.split("\0");
      if (!name || !objectId || extra !== undefined) throw new BackupError("谱系仓库 refs 格式无效");
      return { name, objectId };
    });
  const objects = runGit(repository, ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean).sort().join("\n");
  if (refs.length === 0 || !objects) throw new BackupError("谱系仓库缺少可恢复的 refs 或对象");
  return { refsSha256: sha256(`${refs.map(({ name, objectId }) => `${name}\0${objectId}`).join("\n")}\n`),
    objectsSha256: sha256(`${objects}\n`), refs };
}

function validateRuntimeIdentity(identity: BackupRuntimeIdentity): void {
  if (!identity || !/^[0-9a-f]{40}$/.test(identity.harnessCommit)
    || !/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,127}$/.test(identity.harnessVersion)
    || !/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/.test(identity.modelCatalogRelease)
    || !/^sha256:[0-9a-f]{64}$/.test(identity.imageDigest)) {
    throw new BackupError("备份运行身份格式无效");
  }
}

function assertRuntimeIdentityMatches(actual: BackupRuntimeIdentity, expected: BackupRuntimeIdentity): void {
  validateRuntimeIdentity(actual);
  validateRuntimeIdentity(expected);
  for (const field of ["harnessCommit", "harnessVersion", "modelCatalogRelease", "imageDigest"] as const) {
    if (actual[field] !== expected[field]) throw new BackupError(`备份运行身份与当前安装不一致：${field}`);
  }
}

function assertCompleteRolePairs(lineages: Array<Pick<RegisteredLineage, "experimentId" | "role">>): void {
  if (lineages.length === 0) throw new BackupError("没有可备份的插件谱系，拒绝发布空备份");
  const roles = new Map<string, Set<PluginRole>>();
  for (const lineage of lineages) {
    const found = roles.get(lineage.experimentId) ?? new Set<PluginRole>();
    found.add(lineage.role);
    roles.set(lineage.experimentId, found);
  }
  for (const [experimentId, found] of roles) {
    if (found.size !== 2 || !found.has("generator") || !found.has("solver")) {
      throw new BackupError(`实验 ${experimentId} 缺少 Generator 或 Solver 完整谱系`);
    }
  }
}

function copyDatabaseSnapshot(source: string, target: string): void {
  const database = new DatabaseSync(source);
  try {
    const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    if (journal.journal_mode.toLowerCase() !== "wal") throw new BackupError("正式 SQLite 必须处于 WAL 模式");
    const check = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") throw new BackupError("源 SQLite 完整性校验失败");
    // VACUUM INTO 在一致读事务中折叠主库与已提交 WAL，避免复制出撕裂状态。
    database.exec(`VACUUM INTO ${sqliteQuote(target)}`);
  } finally { database.close(); }
  chmodSync(target, 0o600);
}

function validateBackupDirectory(path: string): BackupManifest {
  assertPlainDirectory(path, "备份目录");
  const manifestPath = join(path, manifestName);
  const digestPath = join(path, manifestDigestName);
  assertPlainFile(manifestPath, "备份清单");
  assertPlainFile(digestPath, "备份清单摘要");
  const serialized = readFileSync(manifestPath, "utf8");
  if (readFileSync(digestPath, "utf8") !== `${sha256(serialized)}  ${manifestName}\n`) throw new BackupError("备份清单摘要损坏");
  let manifest: BackupManifest;
  try { manifest = JSON.parse(serialized) as BackupManifest; } catch { throw new BackupError("备份清单不是有效 JSON"); }
  const digestPattern = /^[0-9a-f]{64}$/;
  let validIdentity = true;
  try { validateRuntimeIdentity(manifest.runtimeIdentity); } catch { validIdentity = false; }
  if (manifest.schemaVersion !== 1 || manifest.database?.path !== databaseName || manifest.database.integrityCheck !== "ok"
    || manifest.database.journalMode !== "wal" || manifest.protection !== "os-managed"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(manifest.backupId) || !isCanonicalIsoDate(manifest.createdAt)
    || !(["manual", "experiment-start", "experiment-terminal"] as unknown[]).includes(manifest.trigger)
    || !validIdentity || !Array.isArray(manifest.repositories) || !Array.isArray(manifest.artifacts)
    || manifest.repositories.some((entry) => !entry || typeof entry !== "object"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.experimentId)
      || !(["generator", "solver"] as unknown[]).includes(entry.role) || !isAbsolute(entry.sourcePath)
      || typeof entry.bundlePath !== "string" || !digestPattern.test(entry.refsSha256) || !digestPattern.test(entry.objectsSha256)
      || !Array.isArray(entry.refs) || entry.refs.length === 0
      || entry.refs.some((ref) => !ref || typeof ref !== "object"
        || !/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref.name)
        || !/^[0-9a-f]{40}$/.test(ref.objectId)))
    || manifest.artifacts.some((entry) => !entry || typeof entry.path !== "string"
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !digestPattern.test(entry.sha256))) {
    throw new BackupError("备份清单结构无效");
  }
  const repositoryKeys = manifest.repositories.map((entry) => `${entry.experimentId}\0${entry.role}`);
  const bundlePaths = manifest.repositories.map((entry) => entry.bundlePath);
  if (new Set(repositoryKeys).size !== repositoryKeys.length || new Set(bundlePaths).size !== bundlePaths.length
    || manifest.repositories.some((entry) => new Set(entry.refs.map((ref) => ref.name)).size !== entry.refs.length)) {
    throw new BackupError("备份清单包含重复谱系身份");
  }
  const expected = new Set(manifest.artifacts.map((entry) => entry.path));
  const required = new Set([databaseName, ...manifest.repositories.map((entry) => entry.bundlePath)]);
  if (expected.size !== manifest.artifacts.length || [...required].some((entry) => !expected.has(entry))) {
    throw new BackupError("备份清单缺少数据库或谱系仓库");
  }
  const actualFiles = backupFiles(path).filter((entry) => entry !== manifestName && entry !== manifestDigestName).sort();
  if (actualFiles.length !== expected.size || actualFiles.some((entry) => !expected.has(entry))) {
    throw new BackupError("备份目录文件集合与完整性清单不一致");
  }
  for (const entry of manifest.artifacts) {
    const resolved = resolve(path, entry.path);
    if (resolved === resolve(path) || !resolved.startsWith(`${resolve(path)}${sep}`)) throw new BackupError("备份清单包含越界路径");
    assertPlainFile(resolved, `备份产物 ${entry.path}`);
    const content = readFileSync(resolved);
    if (content.byteLength !== entry.bytes || sha256(content) !== entry.sha256) throw new BackupError(`备份产物摘要损坏：${entry.path}`);
  }
  verifySqlite(join(path, databaseName));
  return manifest;
}

interface AuthorityCandidateRow {
  experiment_id: string;
  role: PluginRole;
  attempt_id: string;
  target_commit: string;
  outcome: "promoted" | "failed" | "tie" | "public-only";
  generation: number | null;
}

interface AuthorityPromotionRow {
  experiment_id: string;
  role: PluginRole;
  generation: number;
  tag_name: string;
  target_commit: string;
  state: "pending" | "complete";
}

interface AuthorityRoleResult {
  candidateCommit: string;
  championBefore: string;
  championAfter: string;
  outcome: "promoted" | "failed" | "tie";
  promotionTag: string | null;
  attemptId?: string;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new BackupError(`${label}不是有效 JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BackupError(`${label}结构无效`);
  return parsed as Record<string, unknown>;
}

function authorityKey(experimentId: string, role: PluginRole, generation: number): string {
  return `${experimentId}\0${role}\0${generation}`;
}

function candidateAuthorityKey(candidate: AuthorityCandidateRow): string {
  return `${candidate.experiment_id}\0${candidate.role}\0${candidate.attempt_id}`;
}

function validateAuthorityResult(
  lineage: PluginLineageRepository,
  experimentId: string,
  role: PluginRole,
  generation: number,
  raw: unknown,
  championBefore: string,
  candidates: AuthorityCandidateRow[],
  promotions: Map<string, AuthorityPromotionRow>,
  authorizedPromotions: Set<string>,
  authorizedCandidates: Set<string>,
  checkpointAttemptId?: string,
): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BackupError("代次角色结果结构无效");
  const result = raw as Partial<AuthorityRoleResult>;
  if (!/^[0-9a-f]{40}$/.test(result.candidateCommit ?? "")
    || !/^[0-9a-f]{40}$/.test(result.championBefore ?? "")
    || !/^[0-9a-f]{40}$/.test(result.championAfter ?? "")
    || !(["promoted", "failed", "tie"] as unknown[]).includes(result.outcome)) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 冠军链字段无效`);
  }
  if (result.championBefore !== championBefore) throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 冠军链断裂`);
  if (!lineage.contains(experimentId, role, result.candidateCommit!)) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 候选不属于恢复谱系`);
  }
  const attemptId = checkpointAttemptId ?? result.attemptId;
  const matching = candidates.filter((candidate) => candidate.target_commit === result.candidateCommit
    && (attemptId === undefined || candidate.attempt_id === attemptId));
  if (matching.length !== 1) throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 候选授权不唯一`);
  const candidate = matching[0]!;
  authorizedCandidates.add(candidateAuthorityKey(candidate));
  if (candidate.outcome !== result.outcome
    || (result.outcome === "promoted" ? candidate.generation !== generation : candidate.generation !== null)) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 候选结果与权威记录不一致`);
  }
  const promotionKey = authorityKey(experimentId, role, generation);
  const promotion = promotions.get(promotionKey);
  const expectedTag = `promotion/${experimentId}/${role}/g${String(generation).padStart(4, "0")}`;
  if (result.outcome === "promoted") {
    if (result.championAfter !== result.candidateCommit || result.promotionTag !== expectedTag
      || !promotion || promotion.state !== "complete" || promotion.tag_name !== expectedTag
      || promotion.target_commit !== result.candidateCommit) {
      throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 缺少精确晋级授权`);
    }
    authorizedPromotions.add(promotionKey);
  } else if (result.championAfter !== championBefore || result.promotionTag !== null || promotion) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 非晋级结果非法改变冠军或携带晋级标签`);
  }
  return result.championAfter!;
}

function validateChampionAuthority(database: DatabaseSync, lineage: PluginLineageRepository): void {
  const runtimeRows = database.prepare("SELECT experiment_id, generation, champions_json FROM experiment_runtime ORDER BY experiment_id").all() as
    Array<{ experiment_id: string; generation: number; champions_json: string }>;
  const repositories = database.prepare(`SELECT experiment_id, role, baseline_commit FROM lineage_repositories
    ORDER BY experiment_id, role`).all() as Array<{ experiment_id: string; role: PluginRole; baseline_commit: string }>;
  const candidates = database.prepare(`SELECT experiment_id, role, attempt_id, target_commit, outcome, generation
    FROM candidate_results ORDER BY experiment_id, role, attempt_id`).all() as unknown as AuthorityCandidateRow[];
  const promotionRows = database.prepare(`SELECT experiment_id, role, generation, tag_name, target_commit, state
    FROM promotion_tags ORDER BY experiment_id, role, generation`).all() as unknown as AuthorityPromotionRow[];
  const promotions = new Map<string, AuthorityPromotionRow>();
  for (const promotion of promotionRows) {
    const key = authorityKey(promotion.experiment_id, promotion.role, promotion.generation);
    if (promotions.has(key)) throw new BackupError("晋级授权记录重复");
    promotions.set(key, promotion);
  }
  const authorizedPromotions = new Set<string>();
  const authorizedCandidates = new Set<string>();
  const runtimeIds = new Set(runtimeRows.map((row) => row.experiment_id));
  const lineageIds = new Set(repositories.map((repository) => repository.experiment_id));
  const dormantFactRows = database.prepare(`SELECT experiment_id, 'generation' AS kind FROM generation_records
    UNION ALL SELECT experiment_id, 'checkpoint' AS kind FROM generation_role_checkpoints
    UNION ALL SELECT experiment_id, 'candidate' AS kind FROM candidate_results
    UNION ALL SELECT experiment_id, 'promotion' AS kind FROM promotion_tags`).all() as Array<{
      experiment_id: string; kind: string;
    }>;
  for (const fact of dormantFactRows) {
    if (!runtimeIds.has(fact.experiment_id) && !lineageIds.has(fact.experiment_id)) {
      throw new BackupError(`游离 ${fact.kind} 事实不属于正式运行时或基线谱系`);
    }
  }
  for (const experimentId of lineageIds) {
    if (!runtimeIds.has(experimentId) && dormantFactRows.some((fact) => fact.experiment_id === experimentId)) {
      throw new BackupError(`未确认基线谱系 ${experimentId} 包含游离候选、晋级或代次事实`);
    }
    if (!runtimeIds.has(experimentId)) {
      for (const role of ["generator", "solver"] as const) {
        if (lineage.listHistory(experimentId, role).length !== 1) {
          throw new BackupError(`未确认基线谱系 ${experimentId} 的 ${role} 包含未登记候选提交`);
        }
      }
    }
  }
  for (const runtime of runtimeRows) {
    if (!Number.isSafeInteger(runtime.generation) || runtime.generation < 0) throw new BackupError("运行时代次字段无效");
    const champions = parseJsonObject(runtime.champions_json, `实验 ${runtime.experiment_id} 运行时冠军清单`);
    const current = {} as Record<PluginRole, string>;
    for (const role of ["generator", "solver"] as const) {
      const matching = repositories.filter((entry) => entry.experiment_id === runtime.experiment_id && entry.role === role);
      if (matching.length !== 1) throw new BackupError(`实验 ${runtime.experiment_id} 缺少唯一 ${role} 基线`);
      current[role] = matching[0]!.baseline_commit;
    }
    const generationRows = database.prepare(`SELECT generation, record_json FROM generation_records
      WHERE experiment_id = ? ORDER BY generation`).all(runtime.experiment_id) as Array<{ generation: number; record_json: string }>;
    if (generationRows.length !== runtime.generation) throw new BackupError(`实验 ${runtime.experiment_id} 代次记录数量与运行时不一致`);
    for (let index = 0; index < generationRows.length; index += 1) {
      const expectedGeneration = index + 1;
      const row = generationRows[index]!;
      const record = parseJsonObject(row.record_json, `实验 ${runtime.experiment_id} 第 ${expectedGeneration} 代记录`);
      if (row.generation !== expectedGeneration || record.generation !== expectedGeneration || record.status !== "completed") {
        throw new BackupError(`实验 ${runtime.experiment_id} 代次记录断链或跳代`);
      }
      for (const role of ["generator", "solver"] as const) {
        current[role] = validateAuthorityResult(lineage, runtime.experiment_id, role, expectedGeneration,
          record[role], current[role], candidates.filter((candidate) => candidate.experiment_id === runtime.experiment_id
            && candidate.role === role), promotions, authorizedPromotions, authorizedCandidates);
      }
    }
    for (const role of ["generator", "solver"] as const) {
      if (champions[role] !== current[role]) throw new BackupError(`实验 ${runtime.experiment_id} 的 ${role} 最终冠军未获代次链授权`);
    }
    const checkpoints = database.prepare(`SELECT generation, role, attempt_id, result_json FROM generation_role_checkpoints
      WHERE experiment_id = ? ORDER BY generation, role`).all(runtime.experiment_id) as Array<{
        generation: number; role: PluginRole; attempt_id: string; result_json: string;
      }>;
    for (const checkpoint of checkpoints) {
      if (!(checkpoint.role === "generator" || checkpoint.role === "solver")
        || checkpoint.generation < 1 || checkpoint.generation > runtime.generation + 1) {
        throw new BackupError(`实验 ${runtime.experiment_id} 角色检查点代次无效`);
      }
      const result = parseJsonObject(checkpoint.result_json, `实验 ${runtime.experiment_id} 角色检查点`);
      if (checkpoint.generation <= runtime.generation) {
        const committed = parseJsonObject(generationRows[checkpoint.generation - 1]!.record_json, "已提交代次记录");
        if (canonicalJson(committed[checkpoint.role]) !== canonicalJson(result)) {
          throw new BackupError(`实验 ${runtime.experiment_id} 已提交角色检查点与代次记录冲突`);
        }
      } else {
        validateAuthorityResult(lineage, runtime.experiment_id, checkpoint.role, checkpoint.generation,
          result, current[checkpoint.role], candidates.filter((candidate) => candidate.experiment_id === runtime.experiment_id
            && candidate.role === checkpoint.role), promotions, authorizedPromotions, authorizedCandidates, checkpoint.attempt_id);
      }
    }
  }
  for (const promotion of promotionRows) {
    if (!authorizedPromotions.has(authorityKey(promotion.experiment_id, promotion.role, promotion.generation))) {
      throw new BackupError(`晋级标签 ${promotion.tag_name} 不属于已提交代次或合法恢复检查点`);
    }
  }
  for (const candidate of candidates) {
    if (!authorizedCandidates.has(candidateAuthorityKey(candidate))) {
      throw new BackupError(`候选结果 ${candidate.attempt_id} 不属于已提交代次或合法恢复检查点`);
    }
  }
}

function materializeForIntegrity(backupPath: string, manifest: BackupManifest, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const databaseTarget = join(target, databaseName);
  writeFileSync(databaseTarget, readFileSync(join(backupPath, databaseName)), { mode: 0o600, flag: "wx" });
  const database = new DatabaseSync(databaseTarget);
  try {
    database.exec("BEGIN IMMEDIATE");
    const update = database.prepare("UPDATE lineage_repositories SET repository_path = ? WHERE experiment_id = ? AND role = ?");
    for (const repository of manifest.repositories) {
      const destination = join(target, "lineages", safeSegment(repository.experimentId), repository.role);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const bundle = join(backupPath, repository.bundlePath);
      const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", bundle, destination], {
        encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      if (clone.error || clone.status !== 0) throw new BackupError("谱系 Bundle 无法恢复");
      runGit(destination, ["remote", "remove", "origin"]);
      for (const ref of repository.refs) {
        try { runGit(destination, ["update-ref", ref.name, ref.objectId]); }
        catch { throw new BackupError(`谱系 Bundle 标签或 refs 与备份清单冲突：${ref.name}`); }
      }
      runGit(destination, ["config", "user.name", "Maze Arena Orchestrator"]);
      runGit(destination, ["config", "user.email", "arena@localhost"]);
      const fingerprint = repositoryFingerprint(destination);
      if (canonicalJson(fingerprint.refs) !== canonicalJson(repository.refs)
        || fingerprint.refsSha256 !== repository.refsSha256 || fingerprint.objectsSha256 !== repository.objectsSha256) {
        throw new BackupError("谱系 Bundle 的 refs 或对象集合发生漂移");
      }
      const changed = update.run(destination, repository.experimentId, repository.role);
      if (changed.changes !== 1) throw new BackupError("备份清单与 SQLite 谱系身份冲突");
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
  verifySqlite(databaseTarget);
  const lineage = new PluginLineageRepository(join(target, "lineages"), databaseTarget);
  try {
    const restored = lineage.verifyAllIntegrity();
    if (restored.length !== manifest.repositories.length) throw new BackupError("恢复谱系数量与备份清单冲突");
    const database = new DatabaseSync(databaseTarget, { readOnly: true });
    try {
      validateChampionAuthority(database, lineage);
    } finally { database.close(); }
  } finally { lineage.close(); }
}

export class RuntimeBackupManager {
  constructor(private readonly options: BackupManagerOptions) {}

  create(trigger: BackupTrigger): BackupResult {
    const { databasePath, lineageRoot, backupsRoot } = this.options;
    assertPlainFile(databasePath, "正式 SQLite");
    mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
    chmodSync(backupsRoot, 0o700);
    const staging = mkdtempSync(join(backupsRoot, ".creating-"));
    chmodSync(staging, 0o700);
    try {
      return withLineageMutationLock(lineageRoot, () => {
        validateRuntimeIdentity(this.options.runtimeIdentity);
        const lineage = new PluginLineageRepository(lineageRoot, databasePath);
        let registered: RegisteredLineage[];
        try { registered = lineage.verifyAllIntegrity(); } finally { lineage.close(); }
        assertCompleteRolePairs(registered);
        const databaseTarget = join(staging, databaseName);
        copyDatabaseSnapshot(databasePath, databaseTarget);
        const secrets = normalizedSecrets(this.options.sensitiveValues);
        assertNoSensitiveBytes(databaseTarget, secrets);
        const repositories: BackupRepository[] = [];
        const files = [databaseTarget];
        for (const source of registered) {
          assertPlainDirectory(source.repositoryPath, "谱系仓库");
          const local = join("repositories", safeSegment(source.experimentId), `${source.role}.bundle`);
          const destination = join(staging, local);
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          const before = repositoryFingerprint(source.repositoryPath);
          assertRepositoryHasNoSecrets(source.repositoryPath, secrets);
          runGit(source.repositoryPath, ["bundle", "create", destination, "--all"]);
          chmodSync(destination, 0o600);
          const after = repositoryFingerprint(source.repositoryPath);
          if (canonicalJson(before) !== canonicalJson(after)) throw new BackupError("谱系仓库在一致性备份期间发生变化");
          assertNoSensitiveBytes(destination, secrets);
          repositories.push({ experimentId: source.experimentId, role: source.role, sourcePath: source.repositoryPath,
            bundlePath: local.split(sep).join("/"), refsSha256: before.refsSha256,
            objectsSha256: before.objectsSha256, refs: before.refs });
          files.push(destination);
        }
        const now = (this.options.now ?? (() => new Date()))();
        const backupId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
        const manifest: BackupManifest = {
          schemaVersion: 1, backupId, createdAt: now.toISOString(), trigger,
          database: { path: databaseName, journalMode: "wal", integrityCheck: "ok" },
          repositories, runtimeIdentity: this.options.runtimeIdentity,
          artifacts: files.map((path) => artifact(staging, path)).sort((left, right) => left.path.localeCompare(right.path)),
          protection: "os-managed",
        };
        const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
        if (secrets.some((secret) => Buffer.from(serialized).includes(secret))) {
          throw new BackupError("备份运行身份或路径包含 API Key，拒绝发布");
        }
        writeFileSync(join(staging, manifestName), serialized, { mode: 0o600, flag: "wx" });
        writeFileSync(join(staging, manifestDigestName), `${sha256(serialized)}  ${manifestName}\n`, { mode: 0o600, flag: "wx" });
        // 发布前必须从备份自身完成一次 SQLite/Git 双权威恢复校验，不能只相信源目录刚才看起来一致。
        this.verify(staging);
        const published = join(backupsRoot, backupId);
        renameSync(staging, published);
        return { path: published, manifest, rotationWarnings: this.rotate(published) };
      });
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
  }

  verify(path: string): BackupManifest {
    const manifest = validateBackupDirectory(path);
    assertRuntimeIdentityMatches(manifest.runtimeIdentity, this.options.runtimeIdentity);
    assertCompleteRolePairs(manifest.repositories);
    const verification = mkdtempSync(join(tmpdir(), "maze-backup-verify-"));
    try { materializeForIntegrity(path, manifest, verification); }
    finally { rmSync(verification, { recursive: true, force: true }); }
    return manifest;
  }

  restore(path: string, target: string): BackupManifest {
    if (!isAbsolute(target)) throw new BackupError("恢复目标必须是绝对路径");
    if (existsSync(target)) throw new BackupError("恢复目标必须是尚不存在的隔离目录");
    if ([dirname(this.options.databasePath), this.options.lineageRoot, this.options.backupsRoot]
      .some((formalRoot) => isWithin(formalRoot, target) || isWithin(target, formalRoot))) {
      throw new BackupError("恢复目标必须与正式数据、谱系和备份目录完全隔离");
    }
    const manifest = this.verify(path);
    mkdirSync(dirname(resolve(target)), { recursive: true, mode: 0o700 });
    try {
      materializeForIntegrity(path, manifest, target);
      return manifest;
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }

  latestComplete(): { path: string; manifest: BackupManifest } | undefined {
    return this.completeBackups()[0];
  }

  private rotate(protectedPath: string): string[] {
    const complete = this.completeBackups();
    const warnings: string[] = [];
    const remove = this.options.removeBackup ?? ((path: string) => rmSync(path, { recursive: true }));
    for (const { path } of complete.slice(10)) {
      if (resolve(path) === resolve(protectedPath) || complete.length <= 1) continue;
      try { remove(path); } catch { warnings.push(`无法清理旧备份：${basename(path)}`); }
    }
    return warnings;
  }

  private completeBackups(): Array<{ path: string; manifest: BackupManifest }> {
    if (!existsSync(this.options.backupsRoot)) return [];
    const complete: Array<{ path: string; manifest: BackupManifest }> = [];
    for (const name of readdirSync(this.options.backupsRoot).filter((entry) => !entry.startsWith("."))) {
      const path = join(this.options.backupsRoot, name);
      try { complete.push({ path, manifest: this.verify(path) }); } catch {}
    }
    return complete.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt)
      || right.manifest.backupId.localeCompare(left.manifest.backupId));
  }
}

export function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment).filter(([name, value]) => value && /(api.?key|authorization|credential|password|secret|token)/i.test(name))
    .map(([, value]) => value!);
}
