import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import {
  PluginLineageRepository,
  withLineageMutationLock,
  type LineageGitRunner,
  type PluginRole,
  type RegisteredLineage,
} from "@maze-arena/lineage";

export type BackupTrigger = "manual" | "experiment-start" | "experiment-terminal";

export interface BackupRuntimeIdentity {
  harnessPackage: string;
  harnessVersion: string;
  modelCatalogRelease: string;
  modelReleaseSha256: string;
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
export interface SensitiveEnvironmentValueSet {
  exactCredentialValues: string[];
  heuristicValues: string[];
}
export interface BackupManagerOptions {
  databasePath: string;
  lineageRoot: string;
  backupsRoot: string;
  runtimeIdentity: BackupRuntimeIdentity;
  sensitiveValues?: SensitiveEnvironmentValueSet;
  /** 仅允许收紧默认 Git 墙钟上限，便于在受控环境中更快关闭失败。 */
  gitCommandTimeoutMs?: number;
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

const MAX_GIT_OBJECTS = 100_000;
const MAX_TREE_ENTRIES = 500_000;
const MAX_EXPANDED_PATHS = 100_000;
const MAX_RAW_PATH_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_TREE_DEPTH = 4_096;
const MAX_GIT_SCAN_COMMANDS = 25_000;
const MAX_SECRET_PATTERNS = 1_024;
const MAX_SECRET_PATTERN_BYTES = 1024 * 1024;
const MAX_BUNDLE_ADVERTISED_REFS = 100_000;
const MAX_BUNDLE_ADVERTISED_OBJECTS = 100_000;
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 30_000;
const GIT_TERMINATION_GRACE_MS = 250;
const GIT_SUPERVISOR_FALLBACK_MS = 2_000;

const gitSupervisorControl = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 6));
const gitSupervisorOutput = new Uint8Array(new SharedArrayBuffer(MAX_SINGLE_GIT_OUTPUT_BYTES));
let gitSupervisor: Worker | undefined;

const gitSupervisorSource = String.raw`
const { spawn } = require("node:child_process");
const { parentPort } = require("node:worker_threads");

parentPort.on("message", (job) => {
  const control = new Int32Array(job.control);
  const output = new Uint8Array(job.output);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure = 0;
  let completed = false;
  let forceTimer;
  let deadline;
  let groupPoll;
  let child;

  const finish = (state, status = -1) => {
    if (completed) return;
    completed = true;
    clearTimeout(deadline);
    clearTimeout(forceTimer);
    clearTimeout(groupPoll);
    Atomics.store(control, 1, stdoutBytes);
    Atomics.store(control, 2, stderrBytes);
    Atomics.store(control, 3, status);
    Atomics.store(control, 0, state);
    Atomics.notify(control, 0);
  };
  const killGroup = (signal) => {
    const pid = child?.pid;
    if (!pid) return;
    try { process.kill(-pid, signal); } catch (error) {
      if (error?.code !== "ESRCH") failure = failure || 5;
    }
  };
  const groupExists = () => {
    const pid = child?.pid;
    if (!pid) return false;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return error?.code !== "ESRCH"; }
  };
  const terminate = (kind) => {
    if (failure === 0) failure = kind;
    killGroup("SIGTERM");
    forceTimer ??= setTimeout(() => killGroup("SIGKILL"), job.graceMs);
  };
  const collect = (chunk, isStderr) => {
    if (failure !== 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stdoutBytes + stderrBytes + bytes.byteLength > job.maxOutputBytes) {
      terminate(4);
      return;
    }
    if (isStderr) stderrBytes += bytes.byteLength;
    else {
      output.set(bytes, stdoutBytes);
      stdoutBytes += bytes.byteLength;
    }
  };

  try {
    child = spawn("git", ["-C", job.repository, ...job.args], {
      detached: true,
      env: job.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    Atomics.store(control, 4, child.pid ?? 0);
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = failure || 5;
      if (!child.pid) finish(failure);
      else terminate(failure);
    });
    child.on("close", (code, signal) => {
      if (signal !== null) failure = failure || 3;
      const finalState = () => failure !== 0 ? failure : code === 0 ? 1 : 2;
      const confirmGroupExit = () => {
        if (!groupExists()) { finish(finalState(), code ?? -1); return; }
        failure = failure || 3;
        killGroup("SIGKILL");
        groupPoll = setTimeout(confirmGroupExit, 10);
      };
      confirmGroupExit();
    });
    deadline = setTimeout(() => terminate(3), job.timeoutMs);
    child.stdin.end(job.input === undefined ? undefined : Buffer.from(job.input));
  } catch {
    finish(5);
  }
});
`;

interface SupervisedGitResult { output: Buffer; kind: "success" | "exit" | "timeout" | "output" | "spawn"; status: number }

class GitCommandError extends BackupError {
  constructor(readonly kind: SupervisedGitResult["kind"], message: string) { super(message); }
}

function supervisor(): Worker {
  if (!gitSupervisor) {
    gitSupervisor = new Worker(gitSupervisorSource, { eval: true });
    gitSupervisor.unref();
  }
  return gitSupervisor;
}

function runSupervisedGit(
  repository: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  input?: Buffer | string,
): SupervisedGitResult {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_SINGLE_GIT_OUTPUT_BYTES) {
    throw new BackupError("单个 Git 命令输出资源上限无效");
  }
  gitSupervisorControl.fill(0);
  supervisor().postMessage({
    repository,
    args,
    timeoutMs,
    maxOutputBytes,
    graceMs: GIT_TERMINATION_GRACE_MS,
    input,
    environment: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    control: gitSupervisorControl.buffer,
    output: gitSupervisorOutput.buffer,
  });
  const waited = Atomics.wait(
    gitSupervisorControl,
    0,
    0,
    timeoutMs + GIT_TERMINATION_GRACE_MS + GIT_SUPERVISOR_FALLBACK_MS,
  );
  if (waited === "timed-out") {
    const pid = Atomics.load(gitSupervisorControl, 4);
    if (pid > 0) try { process.kill(-pid, "SIGKILL"); } catch {}
    void gitSupervisor?.terminate();
    gitSupervisor = undefined;
    throw new BackupError("Git 备份操作超过墙钟资源上限");
  }
  const states = ["spawn", "success", "exit", "timeout", "output", "spawn"] as const;
  const state = Atomics.load(gitSupervisorControl, 0);
  const kind = states[state] ?? "spawn";
  const length = Atomics.load(gitSupervisorControl, 1);
  return {
    output: Buffer.from(gitSupervisorOutput.subarray(0, length)),
    kind,
    status: Atomics.load(gitSupervisorControl, 3),
  };
}

function validatedGitCommandTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_GIT_COMMAND_TIMEOUT_MS) {
    throw new BackupError("Git 命令墙钟资源上限无效");
  }
  return timeout;
}

function runGit(
  repository: string,
  args: string[],
  timeout: number,
  maxBuffer = MAX_SINGLE_GIT_OUTPUT_BYTES,
  input?: Buffer | string,
): string {
  const result = runSupervisedGit(repository, args, timeout, maxBuffer, input);
  if (result.kind === "output") throw new GitCommandError(result.kind, "单个 Git 命令输出超过安全处理上限");
  if (result.kind === "timeout") throw new GitCommandError(result.kind, "Git 备份操作超过墙钟资源上限");
  if (result.kind === "spawn") throw new GitCommandError(result.kind, "无法执行 Git 备份操作");
  if (result.kind === "exit") throw new GitCommandError(result.kind, `Git 备份操作失败（退出码 ${result.status}）`);
  return result.output.toString("utf8").trim();
}

function runGitBuffer(
  repository: string,
  args: string[],
  timeout: number,
  maxBuffer = MAX_SINGLE_GIT_OUTPUT_BYTES,
  input?: Buffer | string,
): Buffer {
  const result = runSupervisedGit(repository, args, timeout, maxBuffer, input);
  if (result.kind === "output") throw new GitCommandError(result.kind, "单个 Git 命令输出超过安全处理上限");
  if (result.kind === "timeout") throw new GitCommandError(result.kind, "Git 备份操作超过墙钟资源上限");
  if (result.kind === "spawn") throw new GitCommandError(result.kind, "无法执行 Git 备份操作");
  if (result.kind === "exit") throw new GitCommandError(result.kind, `Git 备份操作失败（退出码 ${result.status}）`);
  return result.output;
}

function supervisedLineageGitRunner(timeout: number): LineageGitRunner {
  return {
    run: (repository, args) => runGit(repository, args, timeout),
    optional(repository, args) {
      try { return runGit(repository, args, timeout); }
      catch (error) {
        if (error instanceof GitCommandError && error.kind === "exit") return undefined;
        throw error;
      }
    },
  };
}

interface GitObjectIdentity { objectId: string; type: "blob" | "commit" | "tag" | "tree" }

interface TreeEntry { objectId: string; type: "blob" | "commit" | "tree"; name: Buffer }
interface SecretMatcherNode { transitions: Map<number, number>; failure: number; terminal: boolean }

const TREE_ENTRY_MODES: ReadonlyArray<readonly [Buffer, TreeEntry["type"]]> = [
  [Buffer.from([0x31, 0x30, 0x30, 0x36, 0x34, 0x34]), "blob"],
  [Buffer.from([0x31, 0x30, 0x30, 0x37, 0x35, 0x35]), "blob"],
  [Buffer.from([0x31, 0x32, 0x30, 0x30, 0x30, 0x30]), "blob"],
  [Buffer.from([0x34, 0x30, 0x30, 0x30, 0x30]), "tree"],
  [Buffer.from([0x30, 0x34, 0x30, 0x30, 0x30, 0x30]), "tree"],
  [Buffer.from([0x31, 0x36, 0x30, 0x30, 0x30, 0x30]), "commit"],
];

function assertTreeEntryTarget(
  mode: Buffer,
  objectId: string,
  objectTypes: Map<string, GitObjectIdentity["type"]>,
): TreeEntry["type"] {
  const expectedType = TREE_ENTRY_MODES.find(([allowed]) => mode.equals(allowed))?.[1];
  if (!expectedType) throw new BackupError("谱系 Git tree 条目包含未知 mode 或非 ASCII mode");
  const actualType = objectTypes.get(objectId);
  // Gitlink 允许指向本仓库未保存的 submodule commit；一旦对象存在，仍必须确为 commit。
  if (expectedType === "commit" && actualType === undefined) return expectedType;
  if (actualType === undefined) throw new BackupError("谱系 Git tree 条目引用缺失对象");
  if (actualType !== expectedType) throw new BackupError("谱系 Git tree 条目目标对象类型不一致");
  return expectedType;
}

function assertAcyclicTreeGraph(trees: Map<string, TreeEntry[]>): void {
  const states = new Map<string, "visiting" | "visited">();
  for (const root of trees.keys()) {
    if (states.has(root)) continue;
    const stack: Array<{ treeId: string; childOffset: number }> = [{ treeId: root, childOffset: 0 }];
    states.set(root, "visiting");
    while (stack.length > 0) {
      const current = stack[stack.length - 1]!;
      const entries = trees.get(current.treeId)!;
      if (current.childOffset >= entries.length) {
        states.set(current.treeId, "visited");
        stack.pop();
        continue;
      }
      const child = entries[current.childOffset++]!;
      if (child.type !== "tree") continue;
      const state = states.get(child.objectId);
      if (state === "visiting") throw new BackupError("谱系 Git tree 图包含环");
      if (state === "visited") continue;
      if (!trees.has(child.objectId)) throw new BackupError("谱系 Git tree 图引用缺失对象");
      states.set(child.objectId, "visiting");
      stack.push({ treeId: child.objectId, childOffset: 0 });
    }
  }
}

function compareTreeEntries(left: TreeEntry, right: TreeEntry): number {
  const shared = Math.min(left.name.length, right.name.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left.name[index]! - right.name[index]!;
    if (difference !== 0) return difference;
  }
  const leftTerminator = left.name.length === shared ? (left.type === "tree" ? 0x2f : 0) : left.name[shared]!;
  const rightTerminator = right.name.length === shared ? (right.type === "tree" ? 0x2f : 0) : right.name[shared]!;
  return leftTerminator - rightTerminator;
}

function createSecretMatcher(secrets: Buffer[]): SecretMatcherNode[] {
  if (secrets.length > MAX_SECRET_PATTERNS
    || secrets.reduce((total, secret) => total + secret.byteLength, 0) > MAX_SECRET_PATTERN_BYTES) {
    throw new BackupError("凭据模式数量或累计字节超过安全处理上限");
  }
  const nodes: SecretMatcherNode[] = [{ transitions: new Map(), failure: 0, terminal: false }];
  for (const secret of secrets) {
    let state = 0;
    for (const byte of secret) {
      let next = nodes[state]!.transitions.get(byte);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.transitions.set(byte, next);
        nodes.push({ transitions: new Map(), failure: 0, terminal: false });
      }
      state = next;
    }
    nodes[state]!.terminal = true;
  }
  const queue: number[] = [];
  for (const child of nodes[0]!.transitions.values()) queue.push(child);
  for (let offset = 0; offset < queue.length; offset += 1) {
    const current = queue[offset]!;
    for (const [byte, child] of nodes[current]!.transitions) {
      queue.push(child);
      let failure = nodes[current]!.failure;
      while (failure !== 0 && !nodes[failure]!.transitions.has(byte)) failure = nodes[failure]!.failure;
      const fallback = nodes[failure]!.transitions.get(byte);
      nodes[child]!.failure = fallback === undefined || fallback === child ? 0 : fallback;
      nodes[child]!.terminal ||= nodes[nodes[child]!.failure]!.terminal;
    }
  }
  return nodes;
}

function advanceSecretMatcher(nodes: SecretMatcherNode[], initial: number, bytes: Buffer): number {
  let state = initial;
  for (const byte of bytes) {
    while (state !== 0 && !nodes[state]!.transitions.has(byte)) state = nodes[state]!.failure;
    state = nodes[state]!.transitions.get(byte) ?? 0;
    if (nodes[state]!.terminal) throw new BackupError("插件谱系路径包含 API Key，拒绝写入备份");
  }
  return state;
}

function allGitObjects(
  repository: string,
  read: (args: string[], maxBuffer: number) => Buffer,
): { objects: GitObjectIdentity[]; outputBytes: number } {
  const output = read([
    "cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objectname) %(objecttype)",
  ], MAX_SINGLE_GIT_OUTPUT_BYTES);
  const lines = output.toString("ascii").trim().split("\n").filter(Boolean);
  const objects = lines.map((line): GitObjectIdentity => {
    const [objectId, type, extra] = line.split(" ");
    if (!objectId || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId)
      || !(type === "blob" || type === "commit" || type === "tag" || type === "tree") || extra !== undefined) {
      throw new BackupError("谱系仓库对象清单格式无效");
    }
    return { objectId, type };
  });
  if (objects.length > MAX_GIT_OBJECTS) throw new BackupError("谱系 Git 对象数量超过安全处理上限");
  return { objects: objects.sort((left, right) => left.objectId.localeCompare(right.objectId)), outputBytes: output.byteLength };
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

function normalizedSecrets(values: SensitiveEnvironmentValueSet | undefined): Buffer[] {
  const exact = values?.exactCredentialValues.filter((value) => value.length > 0) ?? [];
  const heuristic = values?.heuristicValues.filter((value) => value.length >= 8) ?? [];
  return [...new Set([...exact, ...heuristic])].map((value) => Buffer.from(value));
}

function assertNoSensitiveBytes(path: string, secrets: Buffer[]): void {
  if (secrets.length === 0) return;
  const content = readFileSync(path);
  if (secrets.some((secret) => content.includes(secret))) throw new BackupError("运行数据包含 API Key，拒绝写入备份");
}

function assertRepositoryHasNoSecrets(repository: string, secrets: Buffer[], timeout: number): void {
  let scanCommands = 0;
  const scanGitBuffer = (args: string[], maxBuffer = MAX_SINGLE_GIT_OUTPUT_BYTES): Buffer => {
    scanCommands += 1;
    if (scanCommands > MAX_GIT_SCAN_COMMANDS) throw new BackupError("谱系 Git 扫描命令数量超过安全处理上限");
    return runGitBuffer(repository, args, timeout, maxBuffer);
  };
  const refNames = scanGitBuffer(["for-each-ref", "--format=%(refname)"]);
  if (secrets.some((secret) => refNames.includes(secret))) {
    throw new BackupError("插件谱系引用名称包含 API Key，拒绝写入备份");
  }
  const { objects, outputBytes: objectListBytes } = allGitObjects(repository, scanGitBuffer);
  const objectTypes = new Map(objects.map(({ objectId, type }) => [objectId, type]));
  const objectIdBytes = objects[0]?.objectId.length === 64 ? 32 : 20;
  const trees = new Map<string, TreeEntry[]>();
  const childTrees = new Set<string>();
  const referencedRootTrees = new Set<string>();
  let totalGitOutputBytes = refNames.byteLength + objectListBytes;
  if (totalGitOutputBytes > MAX_TOTAL_GIT_OUTPUT_BYTES) throw new BackupError("谱系 Git 累计处理字节超过安全上限");
  let totalTreeEntries = 0;
  const accountOutput = (content: Buffer): void => {
    if (content.byteLength > MAX_SINGLE_GIT_OUTPUT_BYTES) throw new BackupError("单个 Git 对象或 tree 输出超过安全处理上限");
    totalGitOutputBytes += content.byteLength;
    if (totalGitOutputBytes > MAX_TOTAL_GIT_OUTPUT_BYTES) throw new BackupError("谱系 Git 累计处理字节超过安全上限");
  };
  for (const { objectId, type } of objects) {
    if (type === "tree") {
      const entries = scanGitBuffer(["cat-file", "tree", objectId]);
      accountOutput(entries);
      const parsed: TreeEntry[] = [];
      const rawNames = new Set<string>();
      let offset = 0;
      while (offset < entries.length) {
        const modeEnd = entries.indexOf(0x20, offset);
        const nameEnd = modeEnd < 0 ? -1 : entries.indexOf(0, modeEnd + 1);
        const objectEnd = nameEnd < 0 ? -1 : nameEnd + 1 + objectIdBytes;
        if (modeEnd <= offset || nameEnd <= modeEnd + 1 || objectEnd > entries.length) {
          throw new BackupError("谱系 Git tree 对象格式无效");
        }
        const mode = entries.subarray(offset, modeEnd);
        const rawName = entries.subarray(modeEnd + 1, nameEnd);
        if (rawName.includes(0x2f)) throw new BackupError("谱系 Git tree 条目名称格式无效");
        const entryObjectId = entries.subarray(nameEnd + 1, objectEnd).toString("hex");
        const entryType = assertTreeEntryTarget(mode, entryObjectId, objectTypes);
        const entry = { objectId: entryObjectId, type: entryType, name: Buffer.from(rawName) };
        // 十六进制是原始名称字节的一一映射，避免非 UTF-8 名称发生字符串解码碰撞。
        const rawNameKey = entry.name.toString("hex");
        if (rawNames.has(rawNameKey)) {
          throw new BackupError("谱系 Git tree 条目包含跨类型或同类型的重复原始名称");
        }
        rawNames.add(rawNameKey);
        const previous = parsed.at(-1);
        if (previous && compareTreeEntries(previous, entry) >= 0) {
          throw new BackupError("谱系 Git tree 条目重复或未按 Git 规则排序");
        }
        parsed.push(entry);
        if (entryType === "tree") childTrees.add(entryObjectId);
        totalTreeEntries += 1;
        if (totalTreeEntries > MAX_TREE_ENTRIES) throw new BackupError("谱系 Git tree 条目数量超过安全处理上限");
        offset = objectEnd;
      }
      trees.set(objectId, parsed);
      continue;
    }
    if (type === "blob" && secrets.length === 0) continue;
    const content = scanGitBuffer(["cat-file", type, objectId]);
    accountOutput(content);
    if (secrets.some((secret) => content.includes(secret))) {
      throw new BackupError("插件谱系包含 API Key，拒绝写入备份");
    }
    if (type === "commit") {
      const end = content.indexOf(0x0a);
      const header = content.subarray(0, end < 0 ? content.length : end).toString("ascii");
      const match = /^tree ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(header);
      if (!match) throw new BackupError("谱系 Git commit 根 tree 格式无效");
      referencedRootTrees.add(match[1]!);
    } else if (type === "tag") {
      const headersEnd = content.indexOf(Buffer.from("\n\n"));
      const headers = content.subarray(0, headersEnd < 0 ? content.length : headersEnd).toString("ascii").split("\n");
      const object = /^object ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/.exec(headers[0] ?? "")?.[1];
      if (headers[1] === "type tree" && object) referencedRootTrees.add(object);
    }
  }
  for (const root of referencedRootTrees) {
    if (objectTypes.get(root) !== "tree") throw new BackupError("谱系 Git 提交或标签引用的根 tree 缺失");
  }
  assertAcyclicTreeGraph(trees);
  const roots = new Set(referencedRootTrees);
  for (const tree of trees.keys()) if (!childTrees.has(tree)) roots.add(tree);
  if (trees.size > 0 && roots.size === 0) throw new BackupError("谱系 Git tree 图缺少可验证根节点");

  const matcher = createSecretMatcher(secrets);
  const slash = Buffer.from("/");
  const stack = [...roots].map((treeId) => ({ treeId, matcherState: 0, depth: 0 }));
  let expandedPaths = 0;
  let rawPathBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = trees.get(current.treeId);
    if (!entries) throw new BackupError("谱系 Git tree 图引用缺失对象");
    for (const entry of entries) {
      expandedPaths += 1;
      if (expandedPaths > MAX_EXPANDED_PATHS) throw new BackupError("谱系 Git 展开路径数量超过安全处理上限");
      const separatorBytes = current.depth === 0 ? 0 : 1;
      rawPathBytes += separatorBytes + entry.name.byteLength;
      if (rawPathBytes > MAX_RAW_PATH_BYTES) throw new BackupError("谱系 Git 累计原始路径字节超过安全处理上限");
      let state = current.matcherState;
      if (separatorBytes !== 0) state = advanceSecretMatcher(matcher, state, slash);
      state = advanceSecretMatcher(matcher, state, entry.name);
      if (entry.type === "tree") {
        if (current.depth + 1 > MAX_TREE_DEPTH) throw new BackupError("谱系 Git tree 深度超过安全处理上限");
        if (!trees.has(entry.objectId)) throw new BackupError("谱系 Git tree 图引用缺失对象");
        stack.push({ treeId: entry.objectId, matcherState: state, depth: current.depth + 1 });
      }
    }
  }
}

function bundleHeads(
  bundle: string,
  repository: string,
  secrets: Buffer[],
  timeout: number,
): { hasHead: boolean; hasRefs: boolean; objectIds: string[] } {
  const output = runGitBuffer(repository, ["bundle", "list-heads", bundle], timeout, MAX_SINGLE_GIT_OUTPUT_BYTES);
  const objectIds: string[] = [];
  let advertisedRefs = 0;
  let hasHead = false;
  let hasRefs = false;
  const records = output.subarray(0, output.length > 0 && output.at(-1) === 0x0a ? output.length - 1 : output.length)
    .toString("binary").split("\n");
  if (records.length === 1 && records[0] === "") throw new BackupError("谱系 Bundle 缺少 advertised refs");
  for (const line of records) {
    if (line.length === 0) throw new BackupError("谱系 Bundle advertised refs 格式无效");
    const separator = line.indexOf(" ");
    const objectId = separator > 0 ? line.slice(0, separator) : "";
    const refName = separator > 0 ? Buffer.from(line.slice(separator + 1), "binary") : Buffer.alloc(0);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId) || refName.length === 0) {
      throw new BackupError("谱系 Bundle advertised refs 格式无效");
    }
    advertisedRefs += 1;
    if (advertisedRefs > MAX_BUNDLE_ADVERTISED_REFS) {
      throw new BackupError("谱系 Bundle advertised refs 数量超过安全处理上限");
    }
    if (secrets.some((secret) => refName.includes(secret))) {
      throw new BackupError("谱系 Bundle 引用名称包含 API Key，拒绝写入备份");
    }
    if (refName.equals(Buffer.from("HEAD"))) hasHead = true;
    else if (refName.subarray(0, 5).equals(Buffer.from("refs/"))) hasRefs = true;
    else throw new BackupError("谱系 Bundle advertised ref 名称无效");
    objectIds.push(objectId);
  }
  if (objectIds.length === 0) throw new BackupError("谱系 Bundle 缺少 advertised refs");
  const uniqueObjectIds = [...new Set(objectIds)];
  if (uniqueObjectIds.length > MAX_BUNDLE_ADVERTISED_OBJECTS) {
    throw new BackupError("谱系 Bundle advertised 对象数量超过安全处理上限");
  }
  return { hasHead, hasRefs, objectIds: uniqueObjectIds };
}

function assertObjectsExist(repository: string, objectIds: string[], timeout: number, label: string): void {
  const output = runGitBuffer(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    timeout,
    MAX_SINGLE_GIT_OUTPUT_BYTES,
    `${objectIds.join("\n")}\n`,
  );
  const lines = output.toString("ascii").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== objectIds.length) throw new BackupError(`${label}对象校验响应数量无效`);
  for (let index = 0; index < objectIds.length; index += 1) {
    const expected = objectIds[index]!;
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (blob|commit|tag|tree)$/.exec(lines[index] ?? "");
    if (!match || match[1] !== expected) throw new BackupError(`${label}对象缺失或校验响应无效`);
  }
}

function assertRegisteredObjectDatabasesReadable(registered: RegisteredLineage[], timeout: number): void {
  for (const lineage of registered) {
    assertPlainDirectory(lineage.repositoryPath, "谱系仓库");
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(lineage.baselineCommit)) {
      throw new BackupError("谱系仓库登记的基线对象格式无效");
    }
    assertObjectsExist(lineage.repositoryPath, [lineage.baselineCommit], timeout, "谱系仓库基线");
  }
}

function assertBundleHasNoSecrets(bundle: string, secrets: Buffer[], timeout: number): void {
  const auditRepository = mkdtempSync(join(tmpdir(), "maze-bundle-audit-"));
  try {
    try {
      runGit(auditRepository, ["init", "--quiet", "--bare"], timeout);
      runGit(auditRepository, ["bundle", "verify", bundle], timeout);
      const advertised = bundleHeads(bundle, auditRepository, secrets, timeout);
      const refspecs = [
        ...(advertised.hasRefs ? ["+refs/*:refs/maze-audit/advertised/*"] : []),
        ...(advertised.hasHead ? ["+HEAD:refs/maze-audit/pseudo/head"] : []),
      ];
      runGit(auditRepository, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundle, ...refspecs], timeout);
      assertObjectsExist(auditRepository, advertised.objectIds, timeout, "谱系 Bundle advertised ");
      assertRepositoryHasNoSecrets(auditRepository, secrets, timeout);
      assertNoSensitiveBytes(bundle, secrets);
    } catch (error) {
      if (error instanceof BackupError && error.message.includes("API Key")) throw error;
      assertNoSensitiveBytes(bundle, secrets);
      throw error;
    }
  } finally {
    rmSync(auditRepository, { recursive: true, force: true });
  }
}

function repositoryFingerprint(repository: string, timeout: number): { refsSha256: string; objectsSha256: string; refs: BackupRef[] } {
  const refs = runGit(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"], timeout)
    .split("\n").filter(Boolean).sort().map((line) => {
      const [name, objectId, extra] = line.split("\0");
      if (!name || !objectId || extra !== undefined) throw new BackupError("谱系仓库 refs 格式无效");
      return { name, objectId };
    });
  // schemaVersion 1 已发布清单使用这一序列化算法；秘密审计不得改变兼容性指纹。
  const objects = runGit(repository, ["rev-list", "--objects", "--all"], timeout)
    .split("\n").filter(Boolean).sort().join("\n");
  if (refs.length === 0 || !objects) throw new BackupError("谱系仓库缺少可恢复的 refs 或对象");
  return { refsSha256: sha256(`${refs.map(({ name, objectId }) => `${name}\0${objectId}`).join("\n")}\n`),
    objectsSha256: sha256(`${objects}\n`), refs };
}

function validateRuntimeIdentity(identity: BackupRuntimeIdentity): void {
  if (!identity || identity.harnessPackage !== "@deepseek-ai/dsh"
    || !/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,127}$/.test(identity.harnessVersion)
    || !/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/.test(identity.modelCatalogRelease)
    || !/^[0-9a-f]{64}$/.test(identity.modelReleaseSha256)
    || !/^sha256:[0-9a-f]{64}$/.test(identity.imageDigest)) {
    throw new BackupError("备份运行身份格式无效");
  }
}

function assertRuntimeIdentityMatches(actual: BackupRuntimeIdentity, expected: BackupRuntimeIdentity): void {
  validateRuntimeIdentity(actual);
  validateRuntimeIdentity(expected);
  for (const field of ["harnessPackage", "harnessVersion", "modelCatalogRelease", "modelReleaseSha256", "imageDigest"] as const) {
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
  candidateStatus?: "invalid" | "public-gate-failed" | "evaluated";
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
  const attemptId = checkpointAttemptId ?? result.attemptId;
  if (checkpointAttemptId !== undefined && result.attemptId !== undefined
    && result.attemptId !== checkpointAttemptId) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 检查点尝试身份冲突`);
  }
  // Harness 未提交候选时只会留下角色结果检查点，不会创建 candidate_results。
  // 该终态既可能出现在已提交的失败代次，也可能出现在下一代尚未提交的检查点；
  // 两种情况都必须保持冠军不变且没有候选或晋级授权，不能把合法失败误判为备份损坏。
  if (result.candidateStatus === "invalid") {
    if (!attemptId || result.candidateCommit !== championBefore
      || result.championAfter !== championBefore || result.outcome !== "failed"
      || result.promotionTag !== null) {
      throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 未提交候选结果非法`);
    }
    const matchingInvalid = candidates.filter((candidate) => candidate.attempt_id === attemptId);
    if (matchingInvalid.length !== 0) {
      throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 未提交候选却存在候选授权`);
    }
    if (promotions.has(authorityKey(experimentId, role, generation))) {
      throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 未提交候选却存在晋级授权`);
    }
    return championBefore;
  }
  if (!lineage.contains(experimentId, role, result.candidateCommit!)) {
    throw new BackupError(`实验 ${experimentId} 第 ${generation} 代 ${role} 候选不属于恢复谱系`);
  }
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
  const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const tableNames = new Set(tableRows.map(({ name }) => name));
  const factSources = [
    ["generation_records", "generation"], ["generation_role_checkpoints", "checkpoint"],
    ["generation_role_model_calls", "model-call-budget"],
    ["generation_role_provider_attempts", "provider-attempt-budget"],
    ["generation_role_provider_usage_items", "provider-usage-item"],
    ["generation_role_provider_model_call_receipts", "provider-model-call-receipt"],
    ["generation_role_tool_calls", "tool-call-budget"], ["candidate_results", "candidate"],
    ["promotion_tags", "promotion"],
  ].filter(([table]) => tableNames.has(table!));
  const dormantFactRows = database.prepare(factSources.map(([table, kind]) =>
    `SELECT experiment_id, '${kind}' AS kind FROM ${table}`).join(" UNION ALL ")).all() as Array<{
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

function assertNoUnpublishedProviderUsageSchema(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('generation_role_provider_attempt_receipts', 'generation_role_provider_usage_batches')
    ORDER BY name`).all() as Array<{ name: string }>;
  if (rows.length > 0) {
    throw new BackupError(`检测到未发布的 Repair66 Provider usage 中间表：${rows.map(({ name }) => name).join(", ")}`);
  }
}

function materializeForIntegrity(
  backupPath: string,
  manifest: BackupManifest,
  target: string,
  secrets: Buffer[],
  timeout: number,
): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const databaseTarget = join(target, databaseName);
  writeFileSync(databaseTarget, readFileSync(join(backupPath, databaseName)), { mode: 0o600, flag: "wx" });
  const database = new DatabaseSync(databaseTarget);
  try {
    assertNoUnpublishedProviderUsageSchema(database);
    database.exec("BEGIN IMMEDIATE");
    const update = database.prepare("UPDATE lineage_repositories SET repository_path = ? WHERE experiment_id = ? AND role = ?");
    for (const repository of manifest.repositories) {
      const destination = join(target, "lineages", safeSegment(repository.experimentId), repository.role);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const bundle = join(backupPath, repository.bundlePath);
      assertBundleHasNoSecrets(bundle, secrets, timeout);
      try {
        runGit(dirname(destination), ["clone", "--quiet", "--no-hardlinks", bundle, destination], timeout);
      } catch (error) {
        assertNoSensitiveBytes(bundle, secrets);
        if (error instanceof BackupError && error.message.includes("资源上限")) throw error;
        throw new BackupError("谱系 Bundle 无法恢复");
      }
      assertRepositoryHasNoSecrets(destination, secrets, timeout);
      runGit(destination, ["remote", "remove", "origin"], timeout);
      for (const ref of repository.refs) {
        try { runGit(destination, ["update-ref", ref.name, ref.objectId], timeout); }
        catch (error) {
          if (error instanceof BackupError && error.message.includes("资源上限")) throw error;
          throw new BackupError(`谱系 Bundle 标签或 refs 与备份清单冲突：${ref.name}`);
        }
      }
      assertRepositoryHasNoSecrets(destination, secrets, timeout);
      runGit(destination, ["config", "user.name", "Maze Arena Orchestrator"], timeout);
      runGit(destination, ["config", "user.email", "arena@localhost"], timeout);
      const fingerprint = repositoryFingerprint(destination, timeout);
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
  const lineage = new PluginLineageRepository(
    join(target, "lineages"),
    databaseTarget,
    supervisedLineageGitRunner(timeout),
  );
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
  private readonly gitCommandTimeoutMs: number;

  constructor(private readonly options: BackupManagerOptions) {
    this.gitCommandTimeoutMs = validatedGitCommandTimeout(options.gitCommandTimeoutMs);
  }

  assertSourceDatabaseSchemaSupported(): void {
    if (!existsSync(this.options.databasePath)) return;
    assertPlainFile(this.options.databasePath, "正式 SQLite");
    const database = new DatabaseSync(this.options.databasePath, { readOnly: true });
    try { assertNoUnpublishedProviderUsageSchema(database); }
    finally { database.close(); }
  }

  create(trigger: BackupTrigger): BackupResult {
    const { databasePath, lineageRoot, backupsRoot } = this.options;
    assertPlainFile(databasePath, "正式 SQLite");
    this.assertSourceDatabaseSchemaSupported();
    mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
    chmodSync(backupsRoot, 0o700);
    const staging = mkdtempSync(join(backupsRoot, ".creating-"));
    chmodSync(staging, 0o700);
    try {
      return withLineageMutationLock(lineageRoot, () => {
        validateRuntimeIdentity(this.options.runtimeIdentity);
        const lineage = new PluginLineageRepository(
          lineageRoot,
          databasePath,
          supervisedLineageGitRunner(this.gitCommandTimeoutMs),
        );
        let registered: RegisteredLineage[];
        try {
          registered = lineage.registeredLineages();
          assertRegisteredObjectDatabasesReadable(registered, this.gitCommandTimeoutMs);
          registered = lineage.verifyAllIntegrity();
        } finally { lineage.close(); }
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
          const before = repositoryFingerprint(source.repositoryPath, this.gitCommandTimeoutMs);
          assertRepositoryHasNoSecrets(source.repositoryPath, secrets, this.gitCommandTimeoutMs);
          runGit(source.repositoryPath, ["bundle", "create", destination, "--all"], this.gitCommandTimeoutMs);
          chmodSync(destination, 0o600);
          assertBundleHasNoSecrets(destination, secrets, this.gitCommandTimeoutMs);
          const after = repositoryFingerprint(source.repositoryPath, this.gitCommandTimeoutMs);
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
    const secrets = normalizedSecrets(this.options.sensitiveValues);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (secrets.some((secret) => manifestBytes.includes(secret))) {
      throw new BackupError("备份运行身份或路径包含 API Key，拒绝验证");
    }
    const verification = mkdtempSync(join(tmpdir(), "maze-backup-verify-"));
    try {
      materializeForIntegrity(path, manifest, verification, secrets, this.gitCommandTimeoutMs);
      for (const entry of manifest.artifacts) assertNoSensitiveBytes(join(path, entry.path), secrets);
      assertNoSensitiveBytes(join(verification, databaseName), secrets);
    }
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
      materializeForIntegrity(path, manifest, target, normalizedSecrets(this.options.sensitiveValues), this.gitCommandTimeoutMs);
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

export function sensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv,
  credentialNames: readonly string[] = [],
): SensitiveEnvironmentValueSet {
  const exactNames = new Set(credentialNames);
  const exactCredentialValues = [...new Set(Object.entries(environment)
    .filter(([name, value]) => value !== undefined && exactNames.has(name))
    .map(([, value]) => value!))];
  const heuristicValues = [...new Set(Object.entries(environment)
    .filter(([name, value]) => value !== undefined && /(api.?key|authorization|credential|password|secret|token)/i.test(name))
    .map(([, value]) => value!))];
  return { exactCredentialValues, heuristicValues };
}

export function redactionSensitiveValues(values: SensitiveEnvironmentValueSet): string[] {
  return [...new Set([
    ...values.exactCredentialValues.filter((value) => value.length > 0),
    ...values.heuristicValues.filter((value) => value.length >= 8),
  ])];
}
