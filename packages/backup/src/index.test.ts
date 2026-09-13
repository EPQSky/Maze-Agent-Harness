import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { BackupError, RuntimeBackupManager, sensitiveEnvironmentValues } from "./index.js";

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
    runtimeIdentity: { harnessPackage: "@deepseek-ai/dsh", harnessVersion: "0.1.2-rc.1", modelCatalogRelease: "catalog-1", modelReleaseSha256: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}` },
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

function commitSecretPath(repository: string, secret: string, location: "文件名" | "目录名"): void {
  const specialName = `--probe-${secret}\n\t边界`;
  const path = location === "文件名" ? join(repository, specialName) : join(repository, specialName, "clean.txt");
  if (location === "目录名") mkdirSync(dirname(path));
  writeFileSync(path, "clean path payload\n");
  for (const args of [
    ["config", "user.name", "Maze Backup Test"],
    ["config", "user.email", "backup@example.invalid"],
    ["add", "--all"],
    ["commit", "--quiet", "-m", "path probe"],
  ]) {
    const result = spawnSync("git", ["-C", repository, ...args]);
    expect(result.status).toBe(0);
  }
}

function commitSplitSecretPath(repository: string, secret: string): void {
  const segments = secret.split("/");
  expect(segments.length).toBeGreaterThan(1);
  const path = join(repository, ...segments);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "clean split path payload\n");
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "--quiet", "-m", "split path probe"]);
}

type SecretGitLocation = "notes" | "replace" | "自定义 ref" | "annotated tag" | "dangling object";

function git(repository: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", input });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function addSecretGitObject(repository: string, secret: string, location: SecretGitLocation): string | undefined {
  const head = git(repository, ["rev-parse", "HEAD"]);
  if (location === "notes") {
    git(repository, ["notes", "--ref=maze-audit", "add", "-m", secret, head]);
    return undefined;
  }
  if (location === "replace") {
    const original = git(repository, ["rev-parse", "HEAD:package.json"]);
    const replacement = git(repository, ["hash-object", "-w", "--stdin"], `${secret}\n`);
    git(repository, ["replace", original, replacement]);
    return undefined;
  }
  if (location === "自定义 ref") {
    git(repository, ["update-ref", `refs/maze-audit/${secret}`, head]);
    return undefined;
  }
  if (location === "annotated tag") {
    git(repository, ["tag", "-a", "maze-audit-secret", head, "-m", secret]);
    return undefined;
  }
  return git(repository, ["hash-object", "-w", "--stdin"], `${secret}\n`);
}

function replaceBundleArtifact(backupPath: string, repository: string, danglingObject?: string): void {
  const bundlePath = join(backupPath, "repositories/exp-backup/generator.bundle");
  rmSync(bundlePath);
  if (danglingObject === undefined) {
    git(repository, ["bundle", "create", bundlePath, "--all"]);
  } else {
    const advertised = git(repository, ["for-each-ref", "--format=%(objectname) %(refname)"])
      .split("\n").filter(Boolean);
    const revisions = `${advertised.map((line) => line.slice(0, line.indexOf(" "))).join("\n")}\n${danglingObject}\n`;
    const packed = spawnSync("git", ["-C", repository, "pack-objects", "--stdout", "--revs"], {
      encoding: null, input: revisions,
    });
    expect(packed.status, Buffer.from(packed.stderr ?? "").toString()).toBe(0);
    writeFileSync(bundlePath, Buffer.concat([
      Buffer.from(`# v2 git bundle\n${advertised.join("\n")}\n\n`),
      Buffer.isBuffer(packed.stdout) ? packed.stdout : Buffer.from(packed.stdout ?? ""),
    ]));
    expect(spawnSync("git", ["bundle", "verify", bundlePath], { cwd: repository }).status).toBe(0);
  }
  rewriteManifest(backupPath, (manifest) => {
    const entry = manifest.artifacts.find((artifact: { path: string }) => artifact.path.endsWith("generator.bundle"));
    const bytes = readFileSync(bundlePath);
    entry.bytes = bytes.byteLength;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
}

function addDanglingBlobs(repository: string, count: number, offset = 0): void {
  const records: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const payload = `maze-object-boundary-${offset + index}`;
    records.push(`blob\ndata ${Buffer.byteLength(payload)}\n${payload}\n`);
  }
  const imported = spawnSync("git", ["-C", repository, "fast-import", "--quiet"], {
    encoding: "utf8",
    input: records.join(""),
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(imported.status, imported.stderr).toBe(0);
}

function allObjectIds(repository: string): string[] {
  const listed = spawnSync("git", [
    "-C", repository, "cat-file", "--batch-all-objects", "--unordered", "--batch-check=%(objectname)",
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.trim().split("\n").filter(Boolean);
}

function replaceBundleWithAllObjects(backupPath: string, repository: string): number {
  const bundlePath = join(backupPath, "repositories/exp-backup/generator.bundle");
  const advertised = git(repository, ["for-each-ref", "--format=%(objectname) %(refname)"])
    .split("\n").filter(Boolean);
  const objectIds = allObjectIds(repository);
  const packed = spawnSync("git", ["-C", repository, "pack-objects", "--stdout"], {
    encoding: null,
    input: `${objectIds.join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(packed.status, Buffer.from(packed.stderr ?? "").toString()).toBe(0);
  writeFileSync(bundlePath, Buffer.concat([
    Buffer.from(`# v2 git bundle\n${advertised.join("\n")}\n\n`),
    Buffer.isBuffer(packed.stdout) ? packed.stdout : Buffer.from(packed.stdout ?? ""),
  ]));
  expect(spawnSync("git", ["bundle", "verify", bundlePath], { cwd: repository }).status).toBe(0);
  rewriteManifest(backupPath, (manifest) => {
    const entry = manifest.artifacts.find((artifact: { path: string }) => artifact.path.endsWith("generator.bundle"));
    const bytes = readFileSync(bundlePath);
    entry.bytes = bytes.byteLength;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
  return objectIds.length;
}

function appendBundleAdvertisedRefs(backupPath: string, count: number): void {
  const bundlePath = join(backupPath, "repositories/exp-backup/generator.bundle");
  const bundle = readFileSync(bundlePath);
  const boundary = bundle.indexOf(Buffer.from("\n\n"));
  expect(boundary).toBeGreaterThan(0);
  const header = bundle.subarray(0, boundary).toString("ascii");
  const objectId = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) /m.exec(header)?.[1];
  expect(objectId).toBeDefined();
  const extra = Array.from({ length: count }, (_, index) => `${objectId} refs/maze-volume/${index}`).join("\n");
  writeFileSync(bundlePath, Buffer.concat([
    Buffer.from(`${header}\n${extra}\n\n`),
    bundle.subarray(boundary + 2),
  ]));
  rewriteManifest(backupPath, (manifest) => {
    const entry = manifest.artifacts.find((artifact: { path: string }) => artifact.path.endsWith("generator.bundle"));
    const bytes = readFileSync(bundlePath);
    entry.bytes = bytes.byteLength;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
}

function expectControlledGitTimeout(
  root: string,
  match: string,
  operation: () => void,
  hangInShim = true,
  captureAllPids = false,
): void {
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  expect(realGit).toMatch(/^\//);
  const bin = join(root, `git-shim-${createHash("sha256").update(match).digest("hex").slice(0, 8)}`);
  const executable = join(bin, "git");
  const pidFile = join(bin, "pid");
  mkdirSync(bin);
  writeFileSync(executable, `#!/bin/sh\nif [ "$MAZE_BACKUP_TEST_CAPTURE_ALL_PIDS" = 1 ]; then\n  printf '%s\\n' "$$" >> "$MAZE_BACKUP_TEST_PID_FILE"\n  exec "$MAZE_BACKUP_TEST_REAL_GIT" "$@"\nfi\ncase "$*" in\n  *"$MAZE_BACKUP_TEST_HANG_MATCH"*)\n    printf '%s\\n' "$$" >> "$MAZE_BACKUP_TEST_PID_FILE"\n    if [ "$MAZE_BACKUP_TEST_HANG_IN_SHIM" = 1 ]; then\n      exec "$MAZE_BACKUP_TEST_NODE" -e 'setInterval(() => {}, 1000)'\n    fi\n    exec "$MAZE_BACKUP_TEST_REAL_GIT" "$@"\n    ;;\nesac\nexec "$MAZE_BACKUP_TEST_REAL_GIT" "$@"\n`);
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousMatch = process.env.MAZE_BACKUP_TEST_HANG_MATCH;
  const previousPidFile = process.env.MAZE_BACKUP_TEST_PID_FILE;
  const previousNode = process.env.MAZE_BACKUP_TEST_NODE;
  const previousRealGit = process.env.MAZE_BACKUP_TEST_REAL_GIT;
  const previousHangInShim = process.env.MAZE_BACKUP_TEST_HANG_IN_SHIM;
  const previousCaptureAllPids = process.env.MAZE_BACKUP_TEST_CAPTURE_ALL_PIDS;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.MAZE_BACKUP_TEST_HANG_MATCH = match;
  process.env.MAZE_BACKUP_TEST_PID_FILE = pidFile;
  process.env.MAZE_BACKUP_TEST_NODE = process.execPath;
  process.env.MAZE_BACKUP_TEST_REAL_GIT = realGit;
  process.env.MAZE_BACKUP_TEST_HANG_IN_SHIM = hangInShim ? "1" : "0";
  process.env.MAZE_BACKUP_TEST_CAPTURE_ALL_PIDS = captureAllPids ? "1" : "0";
  try {
    const started = Date.now();
    expect(operation).toThrow(/Git 备份操作超过墙钟资源上限/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number);
    if (captureAllPids) expect(pids.length).toBeGreaterThan(0);
    else expect(pids).toHaveLength(1);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousMatch === undefined) delete process.env.MAZE_BACKUP_TEST_HANG_MATCH;
    else process.env.MAZE_BACKUP_TEST_HANG_MATCH = previousMatch;
    if (previousPidFile === undefined) delete process.env.MAZE_BACKUP_TEST_PID_FILE;
    else process.env.MAZE_BACKUP_TEST_PID_FILE = previousPidFile;
    if (previousNode === undefined) delete process.env.MAZE_BACKUP_TEST_NODE;
    else process.env.MAZE_BACKUP_TEST_NODE = previousNode;
    if (previousRealGit === undefined) delete process.env.MAZE_BACKUP_TEST_REAL_GIT;
    else process.env.MAZE_BACKUP_TEST_REAL_GIT = previousRealGit;
    if (previousHangInShim === undefined) delete process.env.MAZE_BACKUP_TEST_HANG_IN_SHIM;
    else process.env.MAZE_BACKUP_TEST_HANG_IN_SHIM = previousHangInShim;
    if (previousCaptureAllPids === undefined) delete process.env.MAZE_BACKUP_TEST_CAPTURE_ALL_PIDS;
    else process.env.MAZE_BACKUP_TEST_CAPTURE_ALL_PIDS = previousCaptureAllPids;
  }
}

function captureGitCommands(root: string, operation: () => void): string[] {
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(root, "git-capture-shim");
  const executable = join(bin, "git");
  const log = join(bin, "commands.log");
  mkdirSync(bin);
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$MAZE_BACKUP_TEST_GIT_LOG"\nexec "$MAZE_BACKUP_TEST_REAL_GIT" "$@"\n`);
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousLog = process.env.MAZE_BACKUP_TEST_GIT_LOG;
  const previousRealGit = process.env.MAZE_BACKUP_TEST_REAL_GIT;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.MAZE_BACKUP_TEST_GIT_LOG = log;
  process.env.MAZE_BACKUP_TEST_REAL_GIT = realGit;
  try { operation(); }
  finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.MAZE_BACKUP_TEST_GIT_LOG;
    else process.env.MAZE_BACKUP_TEST_GIT_LOG = previousLog;
    if (previousRealGit === undefined) delete process.env.MAZE_BACKUP_TEST_REAL_GIT;
    else process.env.MAZE_BACKUP_TEST_REAL_GIT = previousRealGit;
  }
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function expectGitProcessTreeTimeout(root: string, operation: () => void): void {
  const bin = join(root, "git-process-tree-shim");
  const executable = join(bin, "git");
  const pidFile = join(bin, "pids");
  mkdirSync(bin);
  writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nimport { spawn } from "node:child_process";\nappendFileSync(process.env.MAZE_BACKUP_TEST_PID_FILE,String(process.pid)+"\\n");\nprocess.on("SIGTERM",()=>{});\nconst level=process.env.MAZE_BACKUP_TEST_TREE_LEVEL??"parent";\nif(level!=="grandchild")spawn(process.execPath,[process.argv[1]],{env:{...process.env,MAZE_BACKUP_TEST_TREE_LEVEL:level==="parent"?"child":"grandchild"},stdio:"ignore"});\nsetInterval(()=>{},1000);\n`);
  chmodSync(executable, 0o700);
  const previousPath = process.env.PATH;
  const previousPidFile = process.env.MAZE_BACKUP_TEST_PID_FILE;
  const previousLevel = process.env.MAZE_BACKUP_TEST_TREE_LEVEL;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.MAZE_BACKUP_TEST_PID_FILE = pidFile;
  delete process.env.MAZE_BACKUP_TEST_TREE_LEVEL;
  try {
    expect(operation).toThrow(/Git 备份操作超过墙钟资源上限/);
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).map(Number);
    expect(pids).toHaveLength(3);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPidFile === undefined) delete process.env.MAZE_BACKUP_TEST_PID_FILE;
    else process.env.MAZE_BACKUP_TEST_PID_FILE = previousPidFile;
    if (previousLevel === undefined) delete process.env.MAZE_BACKUP_TEST_TREE_LEVEL;
    else process.env.MAZE_BACKUP_TEST_TREE_LEVEL = previousLevel;
  }
}

function managerWithSecret(
  fixture: Awaited<ReturnType<typeof setup>>,
  secret: string,
  suffix: string,
  gitCommandTimeoutMs?: number,
): RuntimeBackupManager {
  return new RuntimeBackupManager({
    databasePath: fixture.databasePath,
    lineageRoot: fixture.lineageRoot,
    backupsRoot: join(fixture.root, suffix),
    runtimeIdentity: {
      harnessPackage: "@deepseek-ai/dsh",
      harnessVersion: "0.1.2-rc.1",
      modelCatalogRelease: "catalog-1",
      modelReleaseSha256: "a".repeat(64),
      imageDigest: `sha256:${"b".repeat(64)}`,
    },
    sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    gitCommandTimeoutMs,
  });
}

function gitTree(repository: string, entries: string[]): string {
  return git(repository, ["mktree"], `${entries.join("\n")}\n`);
}

function literalGitTree(
  repository: string,
  entries: Array<{ mode: string; objectId: string; name: string | Buffer }>,
): string {
  const content = Buffer.concat(entries.flatMap(({ mode, objectId, name }) => [
    Buffer.from(`${mode} `),
    typeof name === "string" ? Buffer.from(name) : name,
    Buffer.from([0]),
    Buffer.from(objectId, "hex"),
  ]));
  return literalGitTreeBytes(repository, content);
}

function literalGitTreeBytes(repository: string, content: Buffer): string {
  const result = spawnSync("git", ["-C", repository, "hash-object", "--literally", "-t", "tree", "-w", "--stdin"], {
    encoding: null,
    input: content,
  });
  expect(result.status, Buffer.from(result.stderr ?? "").toString()).toBe(0);
  return Buffer.from(result.stdout ?? "").toString("ascii").trim();
}

function nonAsciiModeTree(repository: string, objectId: string): string {
  return literalGitTreeBytes(repository, Buffer.concat([
    Buffer.from([0xb1, 0x30, 0x30, 0x36, 0x34, 0x34, 0x20]),
    Buffer.from("spoofed-mode\0"),
    Buffer.from(objectId, "hex"),
  ]));
}

function addSharedTreeRoots(repository: string): void {
  const blob = git(repository, ["hash-object", "-w", "--stdin"], "clean shared payload\n");
  const shared = gitTree(repository, [`100644 blob ${blob}\tcr3t`]);
  const safeRoot = gitTree(repository, [`040000 tree ${shared}\tsafe`]);
  const secretRoot = gitTree(repository, [`040000 tree ${shared}\ts3`]);
  const safeCommit = git(repository, ["commit-tree", safeRoot, "-m", "shared safe root"]);
  const secretCommit = git(repository, ["commit-tree", secretRoot, "-m", "shared alternate root"]);
  git(repository, ["update-ref", "refs/maze-audit/shared-safe", safeCommit]);
  git(repository, ["update-ref", "refs/maze-audit/shared-alternate", secretCommit]);
}

function addDeepTreeCommit(repository: string, depth: number): string {
  const blob = git(repository, ["hash-object", "-w", "--stdin"], "clean deep path payload\n");
  let tree = gitTree(repository, [`100644 blob ${blob}\tcr3t`]);
  tree = gitTree(repository, [`040000 tree ${tree}\ts3`]);
  for (let level = 0; level < depth; level += 1) tree = gitTree(repository, [`040000 tree ${tree}\td`]);
  return git(repository, ["commit-tree", tree, "-m", "deep tree root"]);
}

function addExpandedPathLimitGraph(repository: string): void {
  const blob = git(repository, ["hash-object", "-w", "--stdin"], "clean bounded payload\n");
  let tree = gitTree(repository, [`100644 blob ${blob}\tleaf`]);
  for (let depth = 0; depth < 16; depth += 1) {
    tree = gitTree(repository, [`040000 tree ${tree}\tleft`, `040000 tree ${tree}\tright`]);
  }
  const commit = git(repository, ["commit-tree", tree, "-m", "bounded expansion probe"]);
  git(repository, ["update-ref", "refs/maze-audit/path-expansion", commit]);
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
      runtimeIdentity: { harnessPackage: "@deepseek-ai/dsh", harnessVersion: "0.1.2-rc.1", modelCatalogRelease: "catalog", modelReleaseSha256: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}` },
      now: () => new Date(Date.UTC(2026, 8, 5, 0, 0, sequence++)),
      removeBackup: (path) => { if (path.includes("00-00-00")) throw new Error("disk busy"); rmSync(path, { recursive: true }); },
    });
    let latest = manager.create("manual");
    for (let index = 0; index < 10; index += 1) latest = manager.create("manual");
    expect(latest.rotationWarnings).toHaveLength(1);
    expect(readdirSync(join(fixture.root, "backups")).filter((name) => !name.startsWith("."))).toHaveLength(11);
    expect(manager.latestComplete()?.manifest.backupId).toBe(latest.manifest.backupId);
  }, 60_000);

  it("冻结目录登记的自定义凭据进入运行数据时不发布不完整备份", async () => {
    const fixture = await setup();
    const secret = "s3cr3t";
    const database = new DatabaseSync(fixture.databasePath);
    database.exec("CREATE TABLE secret_probe (value TEXT)");
    database.prepare("INSERT INTO secret_probe VALUES (?)").run(secret);
    database.close();
    expect(sensitiveEnvironmentValues({ CUSTOM_CRED: secret })).toEqual({
      exactCredentialValues: [],
      heuristicValues: [],
    });
    const sensitiveValues = sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]);
    expect(sensitiveValues).toEqual({ exactCredentialValues: [secret], heuristicValues: [] });
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath, lineageRoot: fixture.lineageRoot, backupsRoot: join(fixture.root, "secret-backups"),
      runtimeIdentity: { harnessPackage: "@deepseek-ai/dsh", harnessVersion: "0.1.2-rc.1", modelCatalogRelease: "catalog", modelReleaseSha256: "a".repeat(64), imageDigest: `sha256:${"b".repeat(64)}` },
      sensitiveValues,
    });
    expect(() => manager.create("manual")).toThrow(BackupError);
    expect(readdirSync(join(fixture.root, "secret-backups"))).toEqual([]);
  });

  it("重算备份摘要后仍拒绝包含自定义凭据的 SQLite，并且不恢复污染数据", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const secret = "s3cr3t";
    rewriteBackupDatabase(created.path, (database) => {
      database.exec("CREATE TABLE secret_probe (value TEXT)");
      database.prepare("INSERT INTO secret_probe VALUES (?)").run(secret);
    });
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath,
      lineageRoot: fixture.lineageRoot,
      backupsRoot: join(fixture.root, "verified-secret-backups"),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease: "catalog-1",
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => manager.verify(created.path)).toThrow(/API Key/);
    const target = `${fixture.root}-custom-secret-restore`;
    roots.push(target);
    expect(() => manager.restore(created.path, target)).toThrow(/API Key/);
    expect(existsSync(target)).toBe(false);
  });

  it("短自定义凭据进入 Git 对象时拒绝创建备份", async () => {
    const fixture = await setup();
    const secret = "s3cr3t";
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    writeFileSync(join(repository, "short-credential.txt"), `${secret}\n`);
    expect(spawnSync("git", ["-C", repository, "add", "short-credential.txt"]).status).toBe(0);
    expect(spawnSync("git", ["-C", repository, "commit", "--quiet", "-m", "credential probe"]).status).toBe(0);
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath,
      lineageRoot: fixture.lineageRoot,
      backupsRoot: join(fixture.root, "git-secret-backups"),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease: "catalog-1",
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => manager.create("manual")).toThrow(/谱系包含 API Key/);
    expect(readdirSync(join(fixture.root, "git-secret-backups"))).toEqual([]);
  });

  it.each(["文件名", "目录名"] as const)("短自定义凭据进入 Git %s 时 create/verify/restore 均拒绝", async (location) => {
    const secret = "s3cr3t";
    const sourceFixture = await setup();
    const sourceRepository = join(sourceFixture.lineageRoot, "exp-backup", "generator");
    commitSecretPath(sourceRepository, secret, location);
    const sourceManager = new RuntimeBackupManager({
      databasePath: sourceFixture.databasePath,
      lineageRoot: sourceFixture.lineageRoot,
      backupsRoot: join(sourceFixture.root, `git-${location}-secret-backups`),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease: "catalog-1",
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => sourceManager.create("manual")).toThrow(/路径包含 API Key/);
    expect(readdirSync(join(sourceFixture.root, `git-${location}-secret-backups`))).toEqual([]);

    const backupFixture = await setup();
    const created = backupFixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(backupFixture.root, `tampered-${location}`);
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    commitSecretPath(tamperedRepository, secret, location);
    rmSync(bundlePath);
    expect(spawnSync("git", ["-C", tamperedRepository, "bundle", "create", bundlePath, "--all"]).status).toBe(0);
    rewriteManifest(created.path, (manifest) => {
      const entry = manifest.artifacts.find((artifact: { path: string }) => artifact.path.endsWith("generator.bundle"));
      const bytes = readFileSync(bundlePath);
      entry.bytes = bytes.byteLength;
      entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    });
    const verificationManager = new RuntimeBackupManager({
      databasePath: backupFixture.databasePath,
      lineageRoot: backupFixture.lineageRoot,
      backupsRoot: join(backupFixture.root, `verify-${location}-secret-backups`),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease: "catalog-1",
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => verificationManager.verify(created.path)).toThrow(/路径包含 API Key/);
    const target = `${backupFixture.root}-${location}-secret-restore`;
    roots.push(target);
    expect(() => verificationManager.restore(created.path, target)).toThrow(/路径包含 API Key/);
    expect(existsSync(target)).toBe(false);
  }, 15_000);

  it("精确凭据跨 Git 目录边界时 create、verify 和 restore 均按完整原始路径拒绝", async () => {
    const secret = "s3/cr3t";
    const sourceFixture = await setup();
    const sourceRepository = join(sourceFixture.lineageRoot, "exp-backup", "generator");
    commitSplitSecretPath(sourceRepository, secret);
    const sourceManager = managerWithSecret(sourceFixture, secret, "split-path-create-backups");
    expect(() => sourceManager.create("manual")).toThrow(/路径包含 API Key/);
    expect(readdirSync(join(sourceFixture.root, "split-path-create-backups"))).toEqual([]);

    const backupFixture = await setup();
    const created = backupFixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(backupFixture.root, "tampered-split-path");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    commitSplitSecretPath(tamperedRepository, secret);
    replaceBundleArtifact(created.path, tamperedRepository);
    const verificationManager = managerWithSecret(backupFixture, secret, "split-path-verify-backups");
    expect(() => verificationManager.verify(created.path)).toThrow(/路径包含 API Key/);
    const target = `${backupFixture.root}-split-path-secret-restore`;
    roots.push(target);
    expect(() => verificationManager.restore(created.path, target)).toThrow(/路径包含 API Key/);
    expect(existsSync(target)).toBe(false);
  }, 15_000);

  it("1200 层以上 tree 链以迭代线性扫描识别深层跨目录秘密", async () => {
    const secret = "s3/cr3t";
    const sourceFixture = await setup();
    const sourceRepository = join(sourceFixture.lineageRoot, "exp-backup", "generator");
    const deepCommit = addDeepTreeCommit(sourceRepository, 1_200);
    git(sourceRepository, ["update-ref", "refs/maze-audit/deep-tree", deepCommit]);
    const sourceManager = managerWithSecret(sourceFixture, secret, "deep-path-create-backups");
    expect(() => sourceManager.create("manual")).toThrow(/路径包含 API Key/);
    expect(readdirSync(join(sourceFixture.root, "deep-path-create-backups"))).toEqual([]);

    const backupFixture = await setup();
    const created = backupFixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(backupFixture.root, "tampered-deep-tree");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    git(tamperedRepository, ["fetch", "--quiet", sourceRepository, deepCommit]);
    replaceBundleArtifact(created.path, tamperedRepository, deepCommit);
    const verificationManager = managerWithSecret(backupFixture, secret, "deep-path-verify-backups");
    expect(() => verificationManager.verify(created.path)).toThrow(/路径包含 API Key/);
    const target = `${backupFixture.root}-deep-path-secret-restore`;
    roots.push(target);
    expect(() => verificationManager.restore(created.path, target)).toThrow(/路径包含 API Key/);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("多根共享子树按各自完整父路径状态扫描而不错误缓存", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    addSharedTreeRoots(repository);
    const manager = managerWithSecret(fixture, "s3/cr3t", "shared-tree-create-backups");
    expect(() => manager.create("manual")).toThrow(/路径包含 API Key/);
    expect(readdirSync(join(fixture.root, "shared-tree-create-backups"))).toEqual([]);
  });

  it("共享子树组合导致展开路径超过硬上限时关闭失败", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    addExpandedPathLimitGraph(repository);
    const manager = managerWithSecret(fixture, "not-present", "path-limit-create-backups");
    expect(() => manager.create("manual")).toThrow(/展开路径数量超过安全处理上限/);
    expect(readdirSync(join(fixture.root, "path-limit-create-backups"))).toEqual([]);
  });

  it("Bundle advertised refs 超过记录硬上限时在 fetch 和对象扫描前关闭失败", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    appendBundleAdvertisedRefs(created.path, 100_001);
    const manager = managerWithSecret(fixture, "not-present", "advertised-limit-backups");
    expect(() => manager.verify(created.path)).toThrow(/advertised refs 数量超过安全处理上限/);
    const target = `${fixture.root}-advertised-limit-restore`;
    roots.push(target);
    expect(() => manager.restore(created.path, target)).toThrow(/advertised refs 数量超过安全处理上限/);
    expect(existsSync(target)).toBe(false);
  }, 30_000);

  it("Bundle advertised OID 以每个审计仓库一次有界 batch-check 校验而不逐 OID 启动进程", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const manager = managerWithSecret(fixture, "not-present", "batch-check-backups");
    const commands = captureGitCommands(fixture.root, () => {
      expect(manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    });
    const auditCatFileCommands = commands.filter((command) => command.includes("maze-bundle-audit-") && command.includes(" cat-file "));
    expect(auditCatFileCommands.filter((command) => / cat-file --batch-check=/.test(command))).toHaveLength(2);
    expect(auditCatFileCommands.some((command) => / cat-file -e /.test(command))).toBe(false);
  });

  it("create 的 Lineage 完整性校验遇到 packed-refs FIFO 时共享墙钟上限并清理 Git 进程", async () => {
    const fixture = await setup();
    const manager = managerWithSecret(fixture, "not-present", "create-timeout-backups", 100);
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    git(repository, ["pack-refs", "--all"]);
    const packedRefs = join(repository, ".git", "packed-refs");
    rmSync(packedRefs);
    expect(spawnSync("mkfifo", [packedRefs]).status).toBe(0);
    expectControlledGitTimeout(fixture.root, "rev-parse", () => manager.create("manual"), false, true);
    expect(readdirSync(join(fixture.root, "create-timeout-backups"))).toEqual([]);
  });

  it("verify 的 Bundle Git 命令受统一墙钟上限约束并清理挂起进程", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const manager = managerWithSecret(fixture, "not-present", "verify-timeout-backups", 100);
    expectControlledGitTimeout(fixture.root, "bundle list-heads", () => manager.verify(created.path));
  });

  it("restore 的对象库 Git 命令受统一墙钟上限约束且不留下恢复目录或挂起进程", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const manager = managerWithSecret(fixture, "not-present", "restore-timeout-backups", 100);
    const target = `${fixture.root}-timeout-restore`;
    roots.push(target);
    expectControlledGitTimeout(fixture.root, "cat-file --batch-all-objects", () => manager.restore(created.path, target));
    expect(existsSync(target)).toBe(false);
  });

  it("Git 超时时按独立进程组清理忽略 TERM 的父、子、孙完整派生树", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const manager = managerWithSecret(fixture, "not-present", "process-tree-timeout-backups", 300);
    expectGitProcessTreeTimeout(fixture.root, () => manager.verify(created.path));
  });

  it("合法普通文件、可执行文件、符号链接、目录及存在或缺失的 gitlink 均可备份恢复", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    const blob = git(repository, ["hash-object", "-w", "--stdin"], "regular payload\n");
    const symlink = git(repository, ["hash-object", "-w", "--stdin"], "relative-target");
    const subtree = gitTree(repository, [`100644 blob ${blob}\tchild.txt`]);
    const commit = git(repository, ["rev-parse", "HEAD"]);
    const missingGitlink = "f".repeat(40);
    const root = literalGitTree(repository, [
      { mode: "100644", objectId: blob, name: "a-regular" },
      { mode: "100755", objectId: blob, name: "b-executable" },
      { mode: "120000", objectId: symlink, name: "c-symlink" },
      { mode: "40000", objectId: subtree, name: "d-directory" },
      { mode: "040000", objectId: subtree, name: "e-zero-padded-directory" },
      { mode: "160000", objectId: commit, name: "f-existing-gitlink" },
      { mode: "160000", objectId: missingGitlink, name: "g-missing-gitlink" },
    ]);
    const treeCommit = git(repository, ["commit-tree", root, "-m", "valid tree entry modes"]);
    git(repository, ["update-ref", "refs/heads/valid-tree-modes", treeCommit]);
    const fsck = spawnSync("git", ["-C", repository, "fsck", "--full"], { encoding: "utf8" });
    expect(fsck.status, fsck.stderr).toBe(0);

    const created = fixture.manager.create("manual");
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${fixture.root}-valid-tree-modes-restore`;
    roots.push(target);
    expect(fixture.manager.restore(created.path, target).backupId).toBe(created.manifest.backupId);
  }, 15_000);

  it.each([
    ["未知 mode", "100664", "blob", /未知 mode/],
    ["普通文件指向 tree", "100644", "tree", /目标对象类型不一致/],
    ["符号链接指向 tree", "120000", "tree", /目标对象类型不一致/],
    ["目录指向 blob", "40000", "blob", /目标对象类型不一致/],
    ["gitlink 指向 blob", "160000", "blob", /目标对象类型不一致/],
    ["普通文件目标缺失", "100644", "missing", /引用缺失对象/],
    ["目录目标缺失", "40000", "missing", /引用缺失对象/],
  ] as const)("create 拒绝源仓 dangling tree 的%s", async (_label, mode, targetKind, expected) => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    const blob = git(repository, ["hash-object", "-w", "--stdin"], "tree target payload\n");
    const tree = gitTree(repository, [`100644 blob ${blob}\tchild.txt`]);
    const objectId = targetKind === "blob" ? blob : targetKind === "tree" ? tree : "e".repeat(40);
    literalGitTree(repository, [{ mode, objectId, name: "malformed-entry" }]);
    expect(() => fixture.manager.create("manual")).toThrow(expected);
    expect(readdirSync(join(fixture.root, "backups"))).toEqual([]);
  });

  it.each([
    ["路径分隔符", (repository: string, blob: string) => literalGitTree(repository, [
      { mode: "100644", objectId: blob, name: "nested/file" },
    ]), /条目名称格式无效/],
    ["截断目标 OID", (repository: string, blob: string) => literalGitTreeBytes(repository, Buffer.concat([
      Buffer.from("100644 truncated\0"), Buffer.from(blob, "hex").subarray(0, 8),
    ])), /tree 对象格式无效/],
    ["重复条目", (repository: string, blob: string) => literalGitTree(repository, [
      { mode: "100644", objectId: blob, name: "duplicate" },
      { mode: "100644", objectId: blob, name: "duplicate" },
    ]), /重复原始名称/],
  ] as const)("create 拒绝源仓 dangling tree 的%s畸形结构", async (_label, createTree, expected) => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    const blob = git(repository, ["hash-object", "-w", "--stdin"], "malformed tree payload\n");
    createTree(repository, blob);
    expect(() => fixture.manager.create("manual")).toThrow(expected);
    expect(readdirSync(join(fixture.root, "backups"))).toEqual([]);
  });

  it.each([
    ["blob/tree", "100644", "blob"],
    ["gitlink/tree", "160000", "commit"],
  ] as const)("非相邻跨类型同名 %s 在 create、verify 和 restore 均拒绝且无恢复残留", async (_label, firstMode, firstType) => {
    const addDuplicateTree = (repository: string): void => {
      const blob = git(repository, ["hash-object", "-w", "--stdin"], "duplicate target payload\n");
      const subtree = gitTree(repository, [`100644 blob ${blob}\tchild.txt`]);
      const firstObject = firstType === "commit" ? git(repository, ["rev-parse", "HEAD"]) : blob;
      literalGitTree(repository, [
        { mode: firstMode, objectId: firstObject, name: "same-name" },
        { mode: "100644", objectId: blob, name: "same-name." },
        { mode: "40000", objectId: subtree, name: "same-name" },
      ]);
    };

    const sourceFixture = await setup();
    addDuplicateTree(join(sourceFixture.lineageRoot, "exp-backup", "generator"));
    expect(() => sourceFixture.manager.create("manual")).toThrow(/重复原始名称/);
    expect(readdirSync(join(sourceFixture.root, "backups"))).toEqual([]);

    const backupFixture = await setup();
    const created = backupFixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(backupFixture.root, `tampered-duplicate-${firstType}`);
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    addDuplicateTree(tamperedRepository);
    replaceBundleWithAllObjects(created.path, tamperedRepository);

    expect(() => backupFixture.manager.verify(created.path)).toThrow(/重复原始名称/);
    const target = `${backupFixture.root}-duplicate-${firstType}-restore`;
    roots.push(target);
    expect(() => backupFixture.manager.restore(created.path, target)).toThrow(/重复原始名称/);
    expect(existsSync(target)).toBe(false);
  }, 15_000);

  it("不同的非 UTF-8 原始名称不会被全集判重误报", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    const blob = git(repository, ["hash-object", "-w", "--stdin"], "binary name payload\n");
    const root = literalGitTree(repository, [
      { mode: "100644", objectId: blob, name: Buffer.from([0x80]) },
      { mode: "100644", objectId: blob, name: Buffer.from([0x81]) },
    ]);
    const commit = git(repository, ["commit-tree", root, "-m", "binary tree names"]);
    git(repository, ["update-ref", "refs/heads/binary-tree-names", commit]);

    const created = fixture.manager.create("manual");
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${fixture.root}-binary-tree-names-restore`;
    roots.push(target);
    expect(fixture.manager.restore(created.path, target).backupId).toBe(created.manifest.backupId);
  }, 15_000);

  it("原始 0xB1 mode 无法伪装 ASCII 1，create、verify 和 restore 均拒绝且无恢复残留", async () => {
    const sourceFixture = await setup();
    const sourceRepository = join(sourceFixture.lineageRoot, "exp-backup", "generator");
    const sourceBlob = git(sourceRepository, ["hash-object", "-w", "--stdin"], "source spoof payload\n");
    nonAsciiModeTree(sourceRepository, sourceBlob);
    expect(() => sourceFixture.manager.create("manual")).toThrow(/非 ASCII mode/);
    expect(readdirSync(join(sourceFixture.root, "backups"))).toEqual([]);

    const backupFixture = await setup();
    const created = backupFixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(backupFixture.root, "tampered-non-ascii-mode");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    const blob = git(tamperedRepository, ["hash-object", "-w", "--stdin"], "bundle spoof payload\n");
    nonAsciiModeTree(tamperedRepository, blob);
    replaceBundleWithAllObjects(created.path, tamperedRepository);

    expect(() => backupFixture.manager.verify(created.path)).toThrow(/非 ASCII mode/);
    const target = `${backupFixture.root}-non-ascii-mode-restore`;
    roots.push(target);
    expect(() => backupFixture.manager.restore(created.path, target)).toThrow(/非 ASCII mode/);
    expect(existsSync(target)).toBe(false);
  }, 15_000);

  it("verify 与 restore 拒绝正式 Bundle 中 dangling 类型错配 tree 且不留下隔离恢复目录", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(fixture.root, "tampered-dangling-tree");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
    const blob = git(tamperedRepository, ["hash-object", "-w", "--stdin"], "not a directory\n");
    literalGitTree(tamperedRepository, [{ mode: "40000", objectId: blob, name: "wrong-type" }]);
    replaceBundleWithAllObjects(created.path, tamperedRepository);

    expect(() => fixture.manager.verify(created.path)).toThrow(/目标对象类型不一致/);
    const target = `${fixture.root}-dangling-tree-restore`;
    roots.push(target);
    expect(() => fixture.manager.restore(created.path, target)).toThrow(/目标对象类型不一致/);
    expect(existsSync(target)).toBe(false);
  }, 15_000);

  it("无敏感凭据时仍审计真实篡改 Bundle 的 100,000/100,001 Git 对象边界", async () => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
    const tamperedRepository = join(fixture.root, "tampered-object-boundary");
    expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);

    const initialCount = allObjectIds(tamperedRepository).length;
    expect(initialCount).toBeLessThan(100_000);
    addDanglingBlobs(tamperedRepository, 100_000 - initialCount);
    expect(replaceBundleWithAllObjects(created.path, tamperedRepository)).toBe(100_000);
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);

    addDanglingBlobs(tamperedRepository, 1, 100_000 - initialCount);
    expect(replaceBundleWithAllObjects(created.path, tamperedRepository)).toBe(100_001);
    expect(() => fixture.manager.verify(created.path)).toThrow(/Git 对象数量超过安全处理上限/);
    const target = `${fixture.root}-object-limit-restore`;
    roots.push(target);
    expect(() => fixture.manager.restore(created.path, target)).toThrow(/Git 对象数量超过安全处理上限/);
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("合法 refs/bundle-head 与 pseudo HEAD 使用不相交审计空间并可完整备份恢复", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    git(repository, ["update-ref", "refs/bundle-head", git(repository, ["rev-parse", "HEAD"])]);
    const manager = managerWithSecret(fixture, "not-present", "custom-ref-positive-backups");
    const created = manager.create("manual");
    expect(manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${fixture.root}-custom-ref-positive-restore`;
    roots.push(target);
    expect(manager.restore(created.path, target).backupId).toBe(created.manifest.backupId);
  });

  it.each(["notes", "replace", "自定义 ref", "annotated tag", "dangling object"] as const)(
    "短精确凭据只存在于 Git %s 时 create、verify 和 restore 均拒绝",
    async (location) => {
      const secret = "s3cr3t";
      const sourceFixture = await setup();
      const sourceRepository = join(sourceFixture.lineageRoot, "exp-backup", "generator");
      addSecretGitObject(sourceRepository, secret, location);
      const sourceManager = managerWithSecret(sourceFixture, secret, `create-${location}-secret-backups`);
      expect(() => sourceManager.create("manual")).toThrow(/API Key/);
      expect(readdirSync(join(sourceFixture.root, `create-${location}-secret-backups`))).toEqual([]);

      const backupFixture = await setup();
      const created = backupFixture.manager.create("manual");
      const bundlePath = join(created.path, "repositories/exp-backup/generator.bundle");
      const tamperedRepository = join(backupFixture.root, `tampered-${location}`);
      expect(spawnSync("git", ["clone", "--quiet", bundlePath, tamperedRepository]).status).toBe(0);
      const danglingObject = addSecretGitObject(tamperedRepository, secret, location);
      replaceBundleArtifact(created.path, tamperedRepository, danglingObject);
      const verificationManager = managerWithSecret(backupFixture, secret, `verify-${location}-secret-backups`);
      expect(() => verificationManager.verify(created.path)).toThrow(/API Key/);
      const target = `${backupFixture.root}-${location}-secret-restore`;
      roots.push(target);
      expect(() => verificationManager.restore(created.path, target)).toThrow(/API Key/);
      expect(existsSync(target)).toBe(false);
    },
    20_000,
  );

  it("schemaVersion 1 对象摘要保持旧 rev-list 序列化，且与全对象秘密审计分离", async () => {
    const fixture = await setup();
    const repository = join(fixture.lineageRoot, "exp-backup", "generator");
    git(repository, ["hash-object", "-w", "--stdin"], "clean dangling object\n");
    const legacyObjects = git(repository, ["rev-list", "--objects", "--all"])
      .split("\n").filter(Boolean).sort().join("\n");
    const legacyDigest = createHash("sha256").update(`${legacyObjects}\n`).digest("hex");

    const created = fixture.manager.create("manual");
    const generator = created.manifest.repositories.find((entry) => entry.role === "generator");
    expect(generator?.objectsSha256).toBe(legacyDigest);
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
  });

  it("短自定义凭据进入待发布 manifest 时拒绝创建备份", async () => {
    const fixture = await setup();
    const secret = "s3cr3t";
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath,
      lineageRoot: fixture.lineageRoot,
      backupsRoot: join(fixture.root, "manifest-create-secret-backups"),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease: `catalog-${secret}`,
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => manager.create("manual")).toThrow(/API Key/);
    expect(readdirSync(join(fixture.root, "manifest-create-secret-backups"))).toEqual([]);
  });

  it.each(["manifest", "artifact"] as const)("短自定义凭据进入 %s 时验证和恢复均关闭失败", async (location) => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const secret = "s3cr3t";
    let modelCatalogRelease = "catalog-1";
    if (location === "manifest") {
      modelCatalogRelease = `catalog-${secret}`;
      rewriteManifest(created.path, (manifest) => { manifest.runtimeIdentity.modelCatalogRelease = modelCatalogRelease; });
    } else {
      const artifactPath = join(created.path, "repositories/exp-backup/generator.bundle");
      writeFileSync(artifactPath, Buffer.concat([readFileSync(artifactPath), Buffer.from(secret)]));
      rewriteManifest(created.path, (manifest) => {
        const entry = manifest.artifacts.find((artifact: { path: string }) => artifact.path.endsWith("generator.bundle"));
        const bytes = readFileSync(artifactPath);
        entry.bytes = bytes.byteLength;
        entry.sha256 = createHash("sha256").update(bytes).digest("hex");
      });
    }
    const manager = new RuntimeBackupManager({
      databasePath: fixture.databasePath,
      lineageRoot: fixture.lineageRoot,
      backupsRoot: join(fixture.root, `${location}-secret-backups`),
      runtimeIdentity: {
        harnessPackage: "@deepseek-ai/dsh",
        harnessVersion: "0.1.2-rc.1",
        modelCatalogRelease,
        modelReleaseSha256: "a".repeat(64),
        imageDigest: `sha256:${"b".repeat(64)}`,
      },
      sensitiveValues: sensitiveEnvironmentValues({ CUSTOM_CRED: secret }, ["CUSTOM_CRED"]),
    });
    expect(() => manager.verify(created.path)).toThrow(/API Key/);
    const target = `${fixture.root}-${location}-secret-restore`;
    roots.push(target);
    expect(() => manager.restore(created.path, target)).toThrow(/API Key/);
    expect(existsSync(target)).toBe(false);
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
      harnessPackage: "@deepseek-ai/not-dsh",
      harnessVersion: "0.1.2-rc.2",
      modelCatalogRelease: "catalog-2",
      modelReleaseSha256: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
    };
    for (const field of Object.keys(replacements) as Array<keyof typeof replacements>) {
      const created = fixture.manager.create("manual");
      rewriteManifest(created.path, (manifest) => { manifest.runtimeIdentity[field] = replacements[field]; });
      const expected = field === "harnessPackage" ? /清单结构无效/ : new RegExp(`运行身份.*${field}`);
      expect(() => fixture.manager.verify(created.path)).toThrow(expected);
    }
  }, 15_000);

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

  it("未提交候选的角色检查点无需伪造 candidate_results 也可备份恢复", async () => {
    const fixture = await setup();
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("DELETE FROM candidate_results WHERE experiment_id = 'exp-backup' AND role = 'generator' AND attempt_id = 'g0002-generator-failed'").run();
    const invalidResult = {
      candidateCommit: fixture.promoted.commit,
      championBefore: fixture.promoted.commit,
      championAfter: fixture.promoted.commit,
      outcome: "failed",
      promotionTag: null,
      publicProgress: 0,
      hiddenProgress: 0,
      aggregate: {},
      attemptId: "g0002-generator-failed",
      candidateStatus: "invalid",
    };
    database.prepare(`UPDATE generation_role_checkpoints SET result_json = ?
      WHERE experiment_id = 'exp-backup' AND generation = 2 AND role = 'generator'`)
      .run(JSON.stringify(invalidResult));
    database.close();
    const created = fixture.manager.create("manual");
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${fixture.root}-invalid-candidate-restore`;
    roots.push(target);
    expect(fixture.manager.restore(created.path, target).backupId).toBe(created.manifest.backupId);
  });

  it("已提交代次中的未提交候选结果也可备份恢复", async () => {
    const fixture = await setup();
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("DELETE FROM candidate_results WHERE experiment_id = 'exp-backup' AND role = 'solver' AND attempt_id = 'g0001-solver'").run();
    const invalidResult = {
      candidateCommit: fixture.baseline.solver,
      championBefore: fixture.baseline.solver,
      championAfter: fixture.baseline.solver,
      outcome: "failed",
      promotionTag: null,
      publicProgress: 0,
      hiddenProgress: 0,
      aggregate: {},
      attemptId: "g0001-solver",
      candidateStatus: "invalid",
    };
    const generation = database.prepare("SELECT record_json FROM generation_records WHERE experiment_id = 'exp-backup' AND generation = 1")
      .get() as { record_json: string };
    const record = JSON.parse(generation.record_json) as Record<string, unknown>;
    record.solver = invalidResult;
    database.prepare("UPDATE generation_records SET record_json = ? WHERE experiment_id = 'exp-backup' AND generation = 1")
      .run(JSON.stringify(record));
    database.prepare(`UPDATE generation_role_checkpoints SET result_json = ?
      WHERE experiment_id = 'exp-backup' AND generation = 1 AND role = 'solver'`)
      .run(JSON.stringify(invalidResult));
    database.close();
    const created = fixture.manager.create("manual");
    expect(fixture.manager.verify(created.path).backupId).toBe(created.manifest.backupId);
    const target = `${fixture.root}-committed-invalid-restore`;
    roots.push(target);
    expect(fixture.manager.restore(created.path, target).backupId).toBe(created.manifest.backupId);
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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);

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

  it.each([
    "generation_role_provider_attempt_receipts",
    "generation_role_provider_usage_batches",
  ])("Backup create/verify/restore 均拒绝未发布 Repair66 中间表 %s", async (table) => {
    const fixture = await setup();
    const created = fixture.manager.create("manual");
    const database = new DatabaseSync(fixture.databasePath);
    database.exec(`CREATE TABLE ${table} (marker TEXT)`);
    database.close();
    expect(() => fixture.manager.create("manual"))
      .toThrow(/未发布的 Repair66 Provider usage 中间表/);

    rewriteBackupDatabase(created.path, (backup) => backup.exec(`CREATE TABLE ${table} (marker TEXT)`));
    expect(() => fixture.manager.verify(created.path))
      .toThrow(/未发布的 Repair66 Provider usage 中间表/);
    const target = `${fixture.root}-${table}-restore`;
    roots.push(target);
    expect(() => fixture.manager.restore(created.path, target))
      .toThrow(/未发布的 Repair66 Provider usage 中间表/);
    expect(existsSync(target)).toBe(false);
  });

  it("无运行时谱系包含游离 Provider usage item 时拒绝备份", async () => {
    const fixture = await setup();
    const lineage = new PluginLineageRepository(fixture.lineageRoot, fixture.databasePath);
    await lineage.initialize("validated-draft", "generator", pluginFixture);
    await lineage.initialize("validated-draft", "solver", pluginFixture);
    lineage.close();
    const database = new DatabaseSync(fixture.databasePath);
    database.exec(`CREATE TABLE generation_role_provider_usage_items (
      item_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL
    )`);
    database.prepare("INSERT INTO generation_role_provider_usage_items VALUES (?, ?)")
      .run("orphan-item", "validated-draft");
    database.close();
    expect(() => fixture.manager.create("manual"))
      .toThrow(/未确认基线谱系.*游离候选、晋级或代次事实/);
  });
});
