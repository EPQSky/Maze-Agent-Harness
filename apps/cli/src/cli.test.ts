import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { hashHarnessRuntimePayload } from "@maze-arena/dsh-integration";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cliPath = join(packageRoot, "dist/cli.js");
const harnessCommit = "0123456789abcdef0123456789abcdef01234567";
const imageId = `sha256:${"b".repeat(64)}`;
const baseImage = `node@sha256:${"a".repeat(64)}`;
const imagePackageDirectories = ["contracts", "engine", "match-profile", "generator-plugin", "solver-plugin"] as const;
const realGit = (process.env.PATH ?? "").split(delimiter)
  .map((directory) => join(directory, "git"))
  .find((path) => existsSync(path));

interface Fixture {
  root: string;
  home: string;
  bin: string;
  harness: string;
  dsh: string;
  nodePrelude: string;
  env: NodeJS.ProcessEnv;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function git(cwd: string, args: string[]): string {
  if (!realGit) throw new Error("测试环境缺少真实 Git");
  const result = spawnSync(realGit, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function initializeHarnessRepository(fixture: Fixture): string {
  executable(join(fixture.bin, "git"), `exec "${realGit}" "$@"`);
  git(fixture.harness, ["init", "--quiet"]);
  git(fixture.harness, ["config", "user.name", "Maze Test"]);
  git(fixture.harness, ["config", "user.email", "maze@example.invalid"]);
  writeFileSync(join(fixture.harness, "README.md"), "locked harness\n");
  writeFileSync(join(fixture.harness, ".gitignore"), "ignored.log\n");
  git(fixture.harness, ["add", "."]);
  git(fixture.harness, ["commit", "--quiet", "-m", "fixture"]);
  return git(fixture.harness, ["rev-parse", "HEAD"]);
}

function initializeRuntimeHarnessRepository(fixture: Fixture): { fixture: Fixture; commit: string } {
  writeFileSync(join(fixture.harness, "package.json"), `${JSON.stringify({
    name: "@deepseek/harness",
    version: "2026.9.1",
    private: true,
    bin: { dsh: "dist/dsh" },
    dependencies: { "runtime-dependency": "1.0.0" },
  }, null, 2)}\n`);
  writeFileSync(join(fixture.harness, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return { fixture, commit: initializeHarnessRepository(fixture) };
}

function createFixture(overrides: Partial<Record<"node" | "pnpm" | "git" | "docker" | "dsh", string>> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "maze-cli-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const harness = join(root, "deepseek-harness");
  const nodePrelude = join(root, "node-version.cjs");
  const modelExport = join(root, "data/maze-arena/harness/model-export.json");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(harness);
  mkdirSync(dirname(modelExport), { recursive: true, mode: 0o700 });
  const projectBackup = join(root, "project-dist-backup");
  mkdirSync(projectBackup);
  for (const directory of imagePackageDirectories) {
    cpSync(join(repositoryRoot, "packages", directory, "dist"), join(projectBackup, directory), { recursive: true });
  }
  writeFileSync(nodePrelude, 'Object.defineProperty(process, "version", { value: "v22.12.0" });\n');
  writeFileSync(modelExport, `${JSON.stringify({
    schemaVersion: 1,
    harnessVersion: "dsh 2026.09.1",
    credentialRefs: ["dsh-credential://vendor-a", "dsh-credential://vendor-b"],
    providers: [
      { id: "vendor-a", label: "Vendor A", models: [{ id: "compact", label: "Compact", capabilities: {
        reasoningEfforts: [], temperature: { minimum: 0, maximum: 2 }, topP: { minimum: 0, maximum: 1 },
        maxContextTokens: 8_000, maxOutputTokens: 2_000, maxTotalTokens: 10_000, providerOptions: {},
      } }] },
      { id: "vendor-b", label: "Vendor B", models: [{ id: "reasoner", label: "Reasoner", capabilities: {
        reasoningEfforts: ["low", "medium", "high"], maxContextTokens: 16_000, maxOutputTokens: 4_000,
        maxTotalTokens: 20_000, providerOptions: { thinkingBudget: { type: "number", minimum: 1_000, maximum: 8_000 } },
      } }] },
    ],
  }, null, 2)}\n`);

  executable(join(bin, "node"), overrides.node ?? 'printf "v22.12.0\\n"');
  executable(join(bin, "pnpm"), overrides.pnpm ?? `
if [ "\${1:-}" = "--version" ]; then printf "10.15.0\\n"; exit 0; fi
directory=""; previous=""; last=""
for argument in "$@"; do
  if [ "$previous" = "--dir" ]; then directory="$argument"; fi
  previous="$argument"; last="$argument"
done
case " $* " in
  *" --filter @maze-arena/contracts --filter @maze-arena/engine --filter @maze-arena/match-profile --filter @maze-arena/generator-plugin --filter @maze-arena/solver-plugin build ")
    printf '%s\\n' "$*" > "${join(root, "project-build-args")}";
    for package in contracts engine match-profile generator-plugin solver-plugin; do
      /bin/mkdir -p "${join(repositoryRoot, "packages")}/$package/dist"
      /bin/cp -R "${join(root, "project-dist-backup")}/$package/." "${join(repositoryRoot, "packages")}/$package/dist/"
    done
    ;;
  *" build ")
    /bin/mkdir -p "$directory/dist"
    /bin/cp "${join(bin, "dsh")}" "$directory/dist/dsh"
    ;;
  *" deploy "*)
    /bin/mkdir -p "$last/dist" "$last/node_modules/runtime-dependency"
    /bin/cp "$directory/package.json" "$last/package.json"
    /bin/cp "$directory/dist/dsh" "$last/dist/dsh"
    if [ ! -f "${join(root, "pnpm-skip-dependency")}" ]; then
      printf '{"name":"runtime-dependency","version":"1.0.0"}\\n' > "$last/node_modules/runtime-dependency/package.json"
    fi
    ;;
esac`);
  executable(join(bin, "git"), overrides.git ?? `if [ "\${1:-}" = "--version" ]; then printf "git version 2.45.0\\n"; elif [ "\${3:-}" = "status" ]; then :; else printf "${harnessCommit}\\n"; fi`);
  const dockerState = join(root, "docker-state");
  writeFileSync(`${dockerState}.image-id`, `${imageId}\n`);
  writeFileSync(`${dockerState}.security`, '["name=seccomp,profile=builtin","name=cgroupns"]\n');
  executable(join(bin, "docker"), overrides.docker ?? `
if [ -f "${join(root, "doctor-delay")}" ] && [ "\${1:-}" = "info" ]; then /bin/sleep 0.5; fi
if [ -f "${join(root, "docker-fail")}" ] && [ "\${1:-}" = "info" ]; then
  printf "opaque-d8e20b53\\n" >&2; exit 7
fi
case "\${1:-}" in
  --version)
    if [ -f "${join(root, "docker-opaque-version")}" ]; then printf "opaque-docker-a18f73c9\\n"; else printf "Docker version 27.1.0, build fixture\\n"; fi
    ;;
  info)
    if [ -f "${join(root, "docker-opaque-security")}" ] && [ "\${3:-}" = "{{json .SecurityOptions}}" ]; then
      printf "opaque-security-f41c82d7\\n"; exit 0
    fi
    case "\${3:-}" in
      *SecurityOptions*) while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dockerState}.security" ;;
      *) printf "27.1.0\\n" ;;
    esac
    ;;
  build)
    iidfile=""
    harness_commit=""; dsh_sha=""; project_sha=""
    context=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--iidfile" ]; then iidfile="$2"; shift 2; continue; fi
      if [ "$1" = "--label" ]; then
        key=\${2%%=*}; value=\${2#*=}
        case "$key" in
          org.maze-arena.harness-commit) harness_commit="$value" ;;
          org.maze-arena.dsh-sha256) dsh_sha="$value" ;;
          org.maze-arena.project-artifact-sha256) project_sha="$value" ;;
        esac
        shift 2; continue
      fi
      context="$1"; shift
    done
    [ -f "$context/harness-runtime/package.json" ] || { printf "missing harness runtime\\n" >&2; exit 1; }
    [ -f "$context/harness-runtime/node_modules/runtime-dependency/package.json" ] || { printf "missing runtime dependency\\n" >&2; exit 1; }
    found_runtime=""; found_link=""
    while IFS= read -r line; do
      case "$line" in
        "COPY harness-runtime /opt/deepseek-harness") found_runtime=1 ;;
        *"ln -s /opt/deepseek-harness/dist/dsh /usr/local/bin/dsh"*) found_link=1 ;;
      esac
    done < "$context/Dockerfile"
    [ -n "$found_runtime" ] && [ -n "$found_link" ] || { printf "invalid Dockerfile runtime payload\\n" >&2; exit 1; }
    [ -f "${join(root, "project-build-args")}" ] || { printf "project packages were not rebuilt\\n" >&2; exit 1; }
    if [ -f "${join(root, "reject-generator-orphan")}" ] && [ -e "$context/packages/generator-plugin/dist/orphan.js" ]; then
      printf "orphan generator artifact copied into image context\\n" >&2; exit 1
    fi
    if [ -f "${join(root, "reject-solver-orphan")}" ] && [ -e "$context/packages/solver-plugin/dist/orphan.js" ]; then
      printf "orphan solver artifact copied into image context\\n" >&2; exit 1
    fi
    while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dockerState}.image-id" > "$iidfile"
    printf '{"org.maze-arena.harness-commit":"%s","org.maze-arena.dsh-sha256":"%s","org.maze-arena.project-artifact-sha256":"%s"}\\n' "$harness_commit" "$dsh_sha" "$project_sha" > "${dockerState}.labels"
    ;;
  image)
    if [ -f "${dockerState}.missing" ]; then printf "no such image\\n" >&2; exit 1; fi
    case "\${5:-}" in
      *Config.Labels*)
        while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dockerState}.labels"
        ;;
      *) while IFS= read -r line; do printf '%s\\n' "$line"; done < "${dockerState}.image-id" ;;
    esac
    ;;
  run)
    arguments=" $* "
    role=""
    case "$arguments" in *" --env=MAZE_MATCH_ROLE=generator "*) role=generator ;; esac
    case "$arguments" in *" --env=MAZE_MATCH_ROLE=solver "*) role=solver ;; esac
    [ -n "$role" ] || { printf "missing smoke role\\n" >&2; exit 1; }
    for required in "--network=none" "--read-only" "--cap-drop=ALL" "--env=DSH_HOME=/arena"; do
      case "$arguments" in *" $required "*) ;; *) printf "missing smoke argument %s\\n" "$required" >&2; exit 1 ;; esac
    done
    case "$arguments" in *" --mount=type=bind,src="*",dst=/arena,readonly "*) ;; *) printf "missing smoke profile mount\\n" >&2; exit 1 ;; esac
    case "$arguments" in *" dsh --profile maze-match-$role ") ;; *) printf "missing smoke profile command\\n" >&2; exit 1 ;; esac
    if [ -f "${dockerState}.handshake-fail" ]; then printf "profile load failed\\n" >&2; exit 1; fi
    if [ "$role" = "solver" ] && [ -f "${dockerState}.solver-handshake-fail" ]; then printf "solver profile load failed\\n" >&2; exit 1; fi
    printf '%s\\n' "$role" >> "${dockerState}.handshake-roles"
    printf '{"type":"match-profile.ready","protocolVersion":1,"role":"%s"}\\n' "$role"
    ;;
  *) printf "unexpected docker command\\n" >&2; exit 1 ;;
esac`);
  const dsh = join(bin, "dsh");
  const pluginInstaller = join(bin, "plugin-install.py");
  writeFileSync(pluginInstaller, `
import json, os, shutil, sys
home, profile, *artifacts = sys.argv[1:]
profile_root = os.path.join(home, "profiles", profile)
dependencies = {}
bundles = []
shutil.rmtree(os.path.join(profile_root, "node_modules"), ignore_errors=True)
for artifact in artifacts:
    with open(os.path.join(artifact, "package.json"), encoding="utf8") as stream:
        manifest = json.load(stream)
    name = manifest["name"]
    dependencies[name] = "file:" + artifact
    bundles.append(name)
    target = os.path.join(profile_root, "node_modules", *name.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    os.symlink(artifact, target, target_is_directory=True)
with open(os.path.join(profile_root, "package.json"), "w", encoding="utf8") as stream:
    json.dump({
        "name": "dsh-profile-" + profile,
        "private": True,
        "dependencies": dependencies,
        "dsh": {"profile": {"bundles": bundles}},
    }, stream, indent=2)
    stream.write("\\n")
`);
  executable(dsh, overrides.dsh ?? `
if [ "\${1:-}" = "--version" ]; then
  if [ -f "${join(root, "dsh-opaque-version")}" ]; then printf "opaque-dsh-b29e84da\\n"; else printf "dsh 2026.09.1\\n"; fi
  exit 0
fi
if [ "\${1:-}" = "models" ] && [ "\${2:-}" = "export" ]; then
  while IFS= read -r line; do printf '%s\\n' "$line"; done < "${modelExport}";
  exit 0
fi
if [ -f "\${DSH_HOME}/plugin-fail" ] && [ "\${1:-}" = "plugin" ]; then
  printf "opaque-c7d19a42\\n" >&2; exit 7
fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "--profile" ] && [ "\${4:-}" = "add" ]; then
  profile="$3"; shift 4
  artifacts=""
  for argument in "$@"; do
    case "$argument" in file:*) artifacts="$artifacts \${argument#file:}" ;; esac
  done
  exec /usr/bin/python3 "\${0%/*}/plugin-install.py" "\${DSH_HOME}" "$profile" $artifacts
fi
printf "unexpected dsh command\\n" >&2; exit 1`);

  return {
    root,
    home,
    bin,
    harness,
    dsh,
    nodePrelude,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      PATH: bin,
      NODE_OPTIONS: `--require=${nodePrelude}`,
    },
  };
}

function run(fixture: Fixture, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: fixture.env,
  });
}

function runAsyncProcess(fixture: Fixture, args: string[]) {
  const child = spawn(process.execPath, [cliPath, ...args], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveResult({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  return { child, result };
}

function runAsync(fixture: Fixture, args: string[]) {
  return runAsyncProcess(fixture, args).result;
}

function runWithPrivateFd(
  fixture: Fixture,
  args: string[],
  request: string,
  endRequest: boolean,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  const requestPipe = child.stdio[3] as Writable;
  requestPipe.on("error", () => {});
  requestPipe.write(request);
  if (endRequest) requestPipe.end();
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("伪造私有请求未在 3 秒内有界退出"));
    }, 3_000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      requestPipe.destroy();
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function runWithLockedPrivateFd(
  fixture: Fixture,
  args: string[],
  request: string,
): Promise<{ status: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const lockPath = join(fixture.root, "state/maze-arena/run/server.lock");
  const startedAt = Date.now();
  const child = spawn("/usr/bin/flock", [
    "--no-fork", "--exclusive", lockPath, process.execPath, cliPath,
  ], { env: fixture.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
  const requestPipe = child.stdio[3] as Writable;
  requestPipe.on("error", () => {});
  requestPipe.write(request);
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("合法持锁私有请求未在 4 秒内有界退出"));
    }, 4_000);
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      requestPipe.destroy();
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function findHostProcess(marker: string): number | undefined {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`).toString("utf8").includes(marker)) return Number(entry);
    } catch { /* 进程可能在枚举期间退出。 */ }
  }
  return undefined;
}

function cleanupFixtureServer(fixture: Fixture): void {
  run(fixture, ["stop"]);
  const statePath = join(fixture.root, "state/maze-arena/run/server.json");
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: unknown; procStartTime?: unknown };
    if (!Number.isSafeInteger(state.pid) || Number(state.pid) <= 0 || typeof state.procStartTime !== "string") return;
    const pid = Number(state.pid);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const actualStartTime = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    if (actualStartTime === state.procStartTime) {
      process.kill(pid, "SIGKILL");
      waitForProcessExit(pid);
    }
  } catch { /* 测试清理不得掩盖原始断言失败。 */ }
}

function waitForProcessExit(pid: number, timeout = 2_000): boolean {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    wait(20);
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

function install(fixture: Fixture) {
  return installAtCommit(fixture, harnessCommit);
}

function installAtCommit(fixture: Fixture, commit: string) {
  return run(fixture, [
    "install",
    "--harness-source", fixture.harness,
    "--harness-commit", commit,
    "--dsh-executable", fixture.dsh,
    "--dsh-version", "dsh 2026.09.1",
  ]);
}

function buildImage(fixture: Fixture, immutableBaseImage = baseImage) {
  return run(fixture, ["image", "build", "--base-image", immutableBaseImage, "--image-name", "maze-arena/match-profile:local"]);
}

function syncModels(fixture: Fixture) {
  return run(fixture, ["models", "sync"]);
}

function prepareBuiltImageFixture(prepareRuntime?: (fixture: Fixture) => void): Fixture {
  const initialized = initializeRuntimeHarnessRepository(createFixture());
  const { fixture, commit } = initialized;
  prepareRuntime?.(fixture);
  expect(installAtCommit(fixture, commit).status).toBe(0);
  const result = buildImage(fixture);
  expect(result.status, result.stderr).toBe(0);
  const sync = syncModels(fixture);
  expect(sync.status, sync.stderr).toBe(0);
  return fixture;
}

describe("正式运行 CLI 黑盒边界", () => {
  it("退出码为零的畸形 Docker 与 DSH 版本输出不会进入管理错误", () => {
    const dockerFixture = createFixture();
    writeFileSync(join(dockerFixture.root, "docker-opaque-version"), "1\n");
    let result = install(dockerFixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("无法解析 Docker 版本，预期包含 major.minor.patch");
    expect(result.stderr).not.toContain("opaque-docker-a18f73c9");

    const dshFixture = createFixture({
      dsh: 'if [ "${1:-}" = "--version" ]; then printf "opaque-dsh-b29e84da\\n"; exit 0; fi',
    });
    result = install(dshFixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dsh 版本不匹配：期望 dsh 2026.09.1");
    expect(result.stderr).not.toContain("opaque-dsh-b29e84da");
  });

  it("从锁定 Harness 显式导出并原子发布只读多提供方目录", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);

    const result = syncModels(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("模型目录已同步：2 个提供方，2 个模型");
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    expect(catalog).toMatchObject({
      schemaVersion: 1,
      harnessVersion: "dsh 2026.09.1",
      credentialRefs: ["dsh-credential://vendor-a", "dsh-credential://vendor-b"],
      providers: [{ id: "vendor-a" }, { id: "vendor-b" }],
    });
    expect(statSync(dirname(catalogPath)).mode & 0o777).toBe(0o500);
    expect(statSync(catalogPath).mode & 0o777).toBe(0o400);
    const exportPath = join(fixture.root, "data/maze-arena/harness/model-export.json");
    const replacement = JSON.parse(readFileSync(exportPath, "utf8"));
    replacement.providers[0].label = "Vendor A Updated";
    writeFileSync(exportPath, `${JSON.stringify(replacement)}\n`);
    expect(syncModels(fixture).status).toBe(0);
    expect(JSON.parse(readFileSync(catalogPath, "utf8")).providers[0].label).toBe("Vendor A Updated");
    expect(readdirSync(join(fixture.root, "data/maze-arena/models/releases"))).toHaveLength(2);
  });

  it("models export 在受控执行器中阻断外部写、Unix socket、后台进程与 runtime 写入", async () => {
    const fixture = createFixture();
    const externalMarker = join(fixture.root, "model-export-external");
    const daemonMarker = join(fixture.root, "model-export-daemon");
    const socketPath = join(fixture.root, "model-export.sock");
    const socketMarker = join(fixture.root, "model-export-connected");
    const daemonIdentity = `maze-model-export-daemon-${fixture.root}`;
    const exportPath = join(fixture.root, "data/maze-arena/harness/model-export.json");
    executable(fixture.dsh, `
if [ "\${1:-}" = "--version" ]; then printf "dsh 2026.09.1\\n"; exit 0; fi
if [ "\${1:-}" = "models" ] && [ "\${2:-}" = "export" ]; then
  runtime_attack="\${0%/*}/runtime-write-must-fail"
  printf escaped > ${JSON.stringify(externalMarker)} 2>/dev/null || :
  printf escaped > "$runtime_attack" 2>/dev/null || :
  /usr/bin/socat -T 0.2 - UNIX-CONNECT:${JSON.stringify(socketPath)} >/dev/null 2>&1 || :
  /bin/sh -c ${JSON.stringify(`/usr/bin/sleep 0.4; printf escaped > ${daemonMarker}; /usr/bin/sleep 10`)} ${JSON.stringify(daemonIdentity)} >/dev/null 2>&1 &
  while IFS= read -r line; do printf '%s\\n' "$line"; done < ${JSON.stringify(exportPath)}
  exit 0
fi
printf "unexpected dsh command\\n" >&2; exit 1`);
    const listener = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const net = require("node:net");
      const server = net.createServer(() => fs.writeFileSync(${JSON.stringify(socketMarker)}, "connected"));
      server.listen(${JSON.stringify(socketPath)});
      setInterval(() => {}, 1_000);
    `], { stdio: "ignore" });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt += 1) wait(10);
      expect(existsSync(socketPath)).toBe(true);
      expect(install(fixture).status).toBe(0);

      const result = syncModels(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("模型目录已同步：2 个提供方，2 个模型");
      wait(700);
      expect(existsSync(externalMarker)).toBe(false);
      expect(existsSync(daemonMarker)).toBe(false);
      expect(existsSync(socketMarker)).toBe(false);
      const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
      expect(existsSync(join(manifest.harness.executable.runtimeRoot, "runtime-write-must-fail"))).toBe(false);
      expect(findHostProcess(daemonIdentity)).toBeUndefined();
    } finally {
      if (listener.exitCode === null && listener.signalCode === null) {
        const closed = new Promise<void>((resolveClosed) => listener.once("close", () => resolveClosed()));
        listener.kill("SIGKILL");
        await closed;
      }
      rmSync(socketPath, { force: true });
    }
  }, 30_000);

  it("models sync 在执行任何 dsh 子命令前拒绝已漂移的冻结 runtime", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    writeFileSync(join(manifest.harness.executable.runtimeRoot, "late-runtime-dependency.js"), "export const changed = true;\n");

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness runtime 冻结载荷身份已漂移");
    expect(existsSync(join(fixture.root, "data/maze-arena/models/current"))).toBe(false);
  });

  it.each([
    ["release 权限变为 0700", (release: string) => chmodSync(release, 0o700)],
    ["catalog 权限变为 0600", (release: string) => chmodSync(join(release, "catalog.json"), 0o600)],
  ] as const)("models sync 拒绝复用%s并保持旧 current", (_label, mutate) => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const release = realpathSync(dirname(catalogPath));
    const before = readFileSync(catalogPath, "utf8");
    mutate(release);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("不可变发布约束");
    expect(realpathSync(dirname(catalogPath))).toBe(release);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
  });

  it("models sync 拒绝复用指向同内容文件的 catalog 符号链接并保持旧 current", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const release = realpathSync(dirname(catalogPath));
    const releaseCatalog = join(release, "catalog.json");
    const before = readFileSync(releaseCatalog, "utf8");
    const replacement = join(fixture.root, "same-catalog.json");
    writeFileSync(replacement, before, { mode: 0o400 });
    chmodSync(release, 0o700);
    rmSync(releaseCatalog);
    symlinkSync(replacement, releaseCatalog, "file");
    chmodSync(release, 0o500);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("不可变发布约束");
    expect(realpathSync(dirname(catalogPath))).toBe(release);
    expect(lstatSync(releaseCatalog).isSymbolicLink()).toBe(true);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
  });

  it.each([
    ["schema 版本", (value: any) => { value.schemaVersion = 2; }, /schemaVersion/],
    ["Harness 版本", (value: any) => { value.harnessVersion = "dsh 2026.08.9"; }, /版本不匹配/],
    ["未知字段", (value: any) => { value.providers[0].models[0].capabilities.extra = true; }, /未知字段/],
    ["非法能力", (value: any) => { value.providers[0].models[0].capabilities.maxTotalTokens = 1; }, /模型能力无效/],
    ["非法凭据引用", (value: any) => { value.credentialRefs = ["plain-secret"]; }, /credentialRefs 无效/],
  ])("models sync 拒绝%s并保留旧目录", (_label, mutate, expected) => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const before = readFileSync(catalogPath, "utf8");
    const exportPath = join(fixture.root, "data/maze-arena/harness/model-export.json");
    const invalid = JSON.parse(readFileSync(exportPath, "utf8"));
    mutate(invalid);
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expected);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
  });

  it("失败时不把 Harness 原始秘密写入目录或命令输出", () => {
    const secret = "sk-live-ticket03-never-persist";
    const fixture = createFixture({ dsh: `
if [ "\${1:-}" = "--version" ]; then printf "dsh 2026.09.1\\n"; exit 0; fi
printf "provider rejected %s\\n" "${secret}" >&2; exit 7` });
    expect(install(fixture).status).toBe(0);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    const modelsRoot = join(fixture.root, "data/maze-arena/models");
    const stored = readdirSync(modelsRoot, { recursive: true })
      .map((entry) => join(modelsRoot, String(entry)))
      .filter((path) => existsSync(path) && statSync(path).isFile())
      .map((path) => readFileSync(path, "utf8")).join("\n");
    expect(stored).not.toContain(secret);
  });

  it("疑似秘密出现在导出自由文本时拒绝发布且不进入目录或输出", () => {
    const secret = "sk-live-catalog-secret-123456";
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const before = readFileSync(catalogPath, "utf8");
    const exportPath = join(fixture.root, "data/maze-arena/harness/model-export.json");
    const invalid = JSON.parse(readFileSync(exportPath, "utf8"));
    invalid.providers[0].label = `Vendor ${secret}`;
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    const stored = readdirSync(join(fixture.root, "data/maze-arena/models"), { recursive: true })
      .map((entry) => join(fixture.root, "data/maze-arena/models", String(entry)))
      .filter((path) => existsSync(path) && statSync(path).isFile())
      .map((path) => readFileSync(path, "utf8")).join("\n");
    expect(stored).not.toContain(secret);
  });

  it("敏感裸字段名出现在 providerOptions 时拒绝发布且不暴露能力", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const before = readFileSync(catalogPath, "utf8");
    const exportPath = join(fixture.root, "data/maze-arena/harness/model-export.json");
    const invalid = JSON.parse(readFileSync(exportPath, "utf8"));
    invalid.providers[0].models[0].capabilities.providerOptions.apiKey = { type: "string" };
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    const result = syncModels(fixture);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("apiKey");
    expect(readFileSync(catalogPath, "utf8")).toBe(before);
    expect(readFileSync(catalogPath, "utf8")).not.toContain("apiKey");
  });

  it("安装到标准用户目录，以 0700 权限保存无秘密身份清单", () => {
    const fixture = createFixture();
    const result = install(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("正式运行目录已初始化");
    const configRoot = join(fixture.root, "config/maze-arena");
    const dataRoot = join(fixture.root, "data/maze-arena");
    const stateRoot = join(fixture.root, "state/maze-arena");
    for (const path of [configRoot, dataRoot, stateRoot, join(dataRoot, "harness"), join(dataRoot, "harness-runtimes"), join(dataRoot, "lineages"), join(dataRoot, "backups"), join(stateRoot, "logs")]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }

    const manifestPath = join(configRoot, "install-manifest.json");
    const text = readFileSync(manifestPath, "utf8");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(text).not.toMatch(/api.?key|secret|credential/i);
    const manifest = JSON.parse(text);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      harness: {
        sourceDirectory: fixture.harness,
        commit: harnessCommit,
        executable: {
          sourcePath: fixture.dsh,
          sourceRuntimeRoot: fixture.bin,
          payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          version: "dsh 2026.09.1",
          sha256: createHash("sha256").update(readFileSync(fixture.dsh)).digest("hex"),
        },
      },
      isolation: { bubblewrap: { path: "/usr/bin/bwrap", version: expect.stringMatching(/^bubblewrap \d+\.\d+\.\d+$/) } },
    });
    expect(manifest.harness.executable.runtimeRoot)
      .toBe(join(dataRoot, "harness-runtimes", manifest.harness.executable.payloadSha256));
    expect(manifest.harness.executable.path).toBe(join(manifest.harness.executable.runtimeRoot, "dsh"));
    expect(resolve(dataRoot).startsWith(resolve(packageRoot))).toBe(false);
    expect(install(fixture).status).toBe(0);
  });

  it("install 的恶意 dsh 版本探测无法写正式路径、连接 Unix socket 或遗留派生进程", async () => {
    const fixture = createFixture();
    const formalAttackPath = join(fixture.root, "data/maze-arena/harness-runtimes/version-attack");
    const daemonMarkerPath = join(fixture.root, "version-daemon-escaped");
    const socketPath = join(fixture.root, "version-probe.sock");
    const socketMarkerPath = join(fixture.root, "version-socket-connected");
    const daemonProcessMarker = `maze-version-daemon-${fixture.root}`;
    writeFileSync(fixture.dsh, `#!${process.execPath}
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
try {
  fs.mkdirSync(process.env.XDG_DATA_HOME + "/maze-arena/harness-runtimes", { recursive: true });
  fs.writeFileSync(process.env.XDG_DATA_HOME + "/maze-arena/harness-runtimes/version-attack", "session-only");
} catch {}
try {
  fs.mkdirSync(${JSON.stringify(dirname(formalAttackPath))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(formalAttackPath)}, "host-write");
} catch {}
spawn(process.execPath, ["-e", ${JSON.stringify(`const fs=require("node:fs");setTimeout(()=>{try{fs.writeFileSync(${JSON.stringify(daemonMarkerPath)},"escaped")}catch{}},400);setInterval(()=>{},1000)` )}, ${JSON.stringify(daemonProcessMarker)}], {
  detached: true, stdio: "ignore",
}).unref();
const socket = net.createConnection(${JSON.stringify(socketPath)});
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  socket.destroy();
  process.stdout.write("dsh 2026.09.1\\n");
};
socket.once("connect", finish);
socket.once("error", finish);
socket.setTimeout(200, finish);
`);
    chmodSync(fixture.dsh, 0o700);
    const listener = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const net = require("node:net");
      const server = net.createServer(() => fs.writeFileSync(${JSON.stringify(socketMarkerPath)}, "connected"));
      server.listen(${JSON.stringify(socketPath)});
      setInterval(() => {}, 1000);
    `], { stdio: "ignore" });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt += 1) wait(10);
      expect(existsSync(socketPath)).toBe(true);

      const result = install(fixture);

      expect(result.status, result.stderr).toBe(0);
      wait(700);
      expect(existsSync(formalAttackPath)).toBe(false);
      expect(existsSync(daemonMarkerPath)).toBe(false);
      expect(existsSync(socketMarkerPath)).toBe(false);
      expect(findHostProcess(daemonProcessMarker)).toBeUndefined();
    } finally {
      if (listener.exitCode === null && listener.signalCode === null) {
        const closed = new Promise<void>((resolveClosed) => listener.once("close", () => resolveClosed()));
        listener.kill("SIGKILL");
        await closed;
      }
      rmSync(socketPath, { force: true });
    }
  }, 30_000);

  it("doctor 对受支持工具与锁定 Harness 身份返回成功", () => {
    const fixture = prepareBuiltImageFixture();

    const result = run(fixture, ["doctor"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("检查通过：Node.js v22.12.0");
    expect(result.stdout).toContain("检查通过：Docker daemon 27.1.0");
    expect(result.stdout).toMatch(/检查通过：bubblewrap \d+\.\d+\.\d+ 文件系统隔离可用/);
    expect(result.stdout).toContain("检查通过：Harness Unix socket 系统调用已隔离且 TCP 回环可用");
    expect(result.stdout).toContain("检查通过：DeepSeek Harness 身份未漂移");
    expect(result.stdout).toContain(`检查通过：Match Profile 镜像 ${imageId}`);
  });

  it("start、status 与 stop 管理回环生产服务，并处理幂等、陈旧 PID、异常退出和秘密净化", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    fixture.env.TEST_PROVIDER_API_KEY = "sk-test-secret-value-123456";
    try {

    let result = run(fixture, ["start"]);
    expect(result.status, result.stderr).toBe(0);
    const processStatePath = join(fixture.root, "state/maze-arena/run/server.json");
    const firstState = JSON.parse(readFileSync(processStatePath, "utf8"));
    const port = firstState.port;
    expect(port).toBeGreaterThanOrEqual(1_024);
    expect(port).toBeLessThanOrEqual(65_535);
    expect(result.stdout).toContain(`http://127.0.0.1:${port}`);
    expect(result.stdout).not.toContain("sk-test-secret-value-123456");

    result = run(fixture, ["start"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("已在运行");

    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：运行中");
    expect(result.stdout).toContain("HTTP：健康");
    expect(result.stdout).toContain(`数据库：${join(fixture.root, "data/maze-arena/maze-arena.sqlite")}`);
    expect(result.stdout).toContain(`Harness：dsh 2026.09.1 @ ${git(fixture.harness, ["rev-parse", "HEAD"])}`);
    expect(result.stdout).toContain(`镜像摘要：${imageId}`);

    const web = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/").then(async r => {
      const text = await r.text(); if (r.status !== 200 || !text.includes("Maze Arena")) process.exit(1);
    }).catch(() => process.exit(1));`]);
    expect(web.status).toBe(0);

    const requestSecrets = [
      "opaque-a7f31d9c",
      "opaque-b8e42a0d",
      "opaque-c9f53b1e",
      "opaque-d0a64c2f",
      "opaque-e1b75d30",
      "opaque-f2c86e41",
      "opaque-a3d97f52",
      "opaque-b4e08a63",
      "opaque-c5f19b74",
    ];
    const encodedPathSecret = [...requestSecrets[8]!]
      .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
    const loggedRequest = spawnSync(process.execPath, ["-e", `
      const urls = [
        "http://127.0.0.1:${port}/api/health?API%5FKEY=${requestSecrets[0]}",
        "http://127.0.0.1:${port}/api/health?access_token=${requestSecrets[1]}&access_token=${requestSecrets[2]}",
        "http://127.0.0.1:${port}/api/health?client_secret=${requestSecrets[3]}",
        "http://127.0.0.1:${port}/api/health?ClIeNt_SeCrEt=${requestSecrets[4]}",
        "http://127.0.0.1:${port}/api/health?foo=ok;access_token=${requestSecrets[5]}",
        "http://127.0.0.1:${port}/api/health?%2561pi_key=${requestSecrets[6]}",
        "http://127.0.0.1:${port}/${encodedPathSecret}",
      ];
      const hostRequest = new Promise((resolve, reject) => {
        const net = require("node:net");
        const socket = net.createConnection({ host: "127.0.0.1", port: ${port} }, () => {
          socket.end("GET /api/health HTTP/1.1\\r\\nHost: ${requestSecrets[7]}\\r\\nConnection: close\\r\\n\\r\\n");
        });
        let response = "";
        socket.on("data", chunk => { response += chunk; });
        socket.on("error", reject);
        socket.on("close", () => response.includes(" 200 ") ? resolve() : reject(new Error(response)));
      });
      Promise.all([...urls.map(url => fetch(url).then(response => {
        if (response.status !== 200) throw new Error(String(response.status));
      })), hostRequest]).then(() => process.exit(0)).catch(() => process.exit(1));
    `]);
    expect(loggedRequest.status).toBe(0);

    expect(realpathSync(firstState.databasePath).startsWith(realpathSync(repositoryRoot))).toBe(false);
    expect(readFileSync(firstState.logPath, "utf8")).not.toContain("sk-test-secret-value-123456");

    result = run(fixture, ["stop"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("已安全停止");
    const productionLog = readFileSync(firstState.logPath, "utf8");
    expect(productionLog).not.toContain("sk-test-secret-value-123456");
    for (const requestSecret of requestSecrets) expect(productionLog).not.toContain(requestSecret);
    expect(productionLog).not.toContain(encodedPathSecret);
    expect(productionLog).toContain("[REDACTED]");
    expect(run(fixture, ["stop"]).stdout).toContain("已停止");

    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：已停止");
    expect(result.stdout).toContain(`数据库：${join(fixture.root, "data/maze-arena/maze-arena.sqlite")}`);
    expect(result.stdout).toContain(`Harness：dsh 2026.09.1 @ ${git(fixture.harness, ["rev-parse", "HEAD"])}`);
    expect(result.stdout).toContain("模型目录版本：");
    expect(result.stdout).toContain(`镜像摘要：${imageId}`);

    writeFileSync(processStatePath, `${JSON.stringify({ ...firstState, pid: 999_999, procStartTime: "stale" })}\n`, { mode: 0o600 });
    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：已停止");
    expect(result.stdout).toContain(`数据库：${join(fixture.root, "data/maze-arena/maze-arena.sqlite")}`);
    expect(result.stdout).toContain(`Harness：dsh 2026.09.1 @ ${git(fixture.harness, ["rev-parse", "HEAD"])}`);
    expect(result.stdout).toContain("模型目录版本：");
    expect(result.stdout).toContain(`镜像摘要：${imageId}`);
    expect(existsSync(processStatePath)).toBe(false);

    const restarted = run(fixture, ["start"]);
    expect(restarted.status, restarted.stderr).toBe(0);
    const secondState = JSON.parse(readFileSync(processStatePath, "utf8"));
    const secondStat = readFileSync(`/proc/${secondState.pid}/stat`, "utf8");
    const secondStartTime = secondStat.slice(secondStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    expect(secondStartTime).toBe(secondState.procStartTime);
    process.kill(secondState.pid, "SIGKILL");
    for (let attempt = 0; attempt < 50 && existsSync(`/proc/${secondState.pid}`); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：已停止");
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 60_000);

  it("Server 启动后只使用实例私有快照，不再绑定可变的外部 Harness 运行目录", () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
      expect(run(fixture, ["start"]).status).toBe(0);
      const state = JSON.parse(readFileSync(join(fixture.root, "state/maze-arena/run/server.json"), "utf8"));
      const frozenCommand = readFileSync(state.harnessExecutablePath, "utf8");

      executable(fixture.dsh, 'printf "dsh 2099.01.1\\n"');
      writeFileSync(join(fixture.bin, "late-live-dependency.js"), "export const value = 'B';\n");

      expect(state.harnessRuntimeRoot).not.toBe(fixture.bin);
      expect(readFileSync(state.harnessExecutablePath, "utf8")).toBe(frozenCommand);
      expect(existsSync(join(state.harnessRuntimeRoot, "late-live-dependency.js"))).toBe(false);
      expect(hashHarnessRuntimePayload(state.harnessRuntimeRoot)).toBe(state.harnessRuntimePayloadSha256);
      const status = run(fixture, ["status"]);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("HTTP：健康");
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it.each([
    ["命令内容", "start", (state: any) => writeFileSync(state.harnessExecutablePath, "#!/bin/sh\\nprintf 'tampered\\n'\\n")],
    ["依赖内容", "status", (state: any) => writeFileSync(join(state.harnessRuntimeRoot, "runtime-dependency.js"), "export const value = 'B';\n")],
    ["符号链接目标", "status", (state: any) => {
      const link = join(state.harnessRuntimeRoot, "runtime-link");
      rmSync(link);
      symlinkSync("link-target-b", link);
    }],
    ["权限", "status", (state: any) => chmodSync(state.harnessExecutablePath, 0o777)],
  ] as const)("幂等 %s 漂移时 start/status 对冻结实例身份关闭失败", (_label, command, mutate) => {
    const fixture = prepareBuiltImageFixture((prepared) => {
      writeFileSync(join(prepared.bin, "link-target-a"), "A\n");
      writeFileSync(join(prepared.bin, "link-target-b"), "B\n");
      symlinkSync("link-target-a", join(prepared.bin, "runtime-link"));
    });
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
      expect(run(fixture, ["start"]).status).toBe(0);
      const state = JSON.parse(readFileSync(join(fixture.root, "state/maze-arena/run/server.json"), "utf8"));
      mutate(state);

      const result = run(fixture, [command]);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/运行中 (?:dsh 可执行文件|Harness runtime 快照)身份已漂移/);
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("doctor 校验期间原子交换清单时，start 仍只使用同一份已验证上下文", () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const originalManifestText = readFileSync(manifestPath, "utf8");
    const maliciousManifest = JSON.parse(originalManifestText);
    maliciousManifest.harness.executable.path = "/bin/false";
    maliciousManifest.harness.executable.runtimeRoot = "/bin";
    maliciousManifest.harness.executable.payloadSha256 = "0".repeat(64);
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    const temporaryManifest = `${manifestPath}.exchange`;
    writeFileSync(fixture.nodePrelude, `${originalPrelude}
const fs = require("node:fs");
const moduleBuiltin = require("node:module");
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalRenameSync = fs.renameSync;
let exchanged = false;
fs.readFileSync = function(path, ...args) {
  const value = originalReadFileSync(path, ...args);
  if (!exchanged && String(path) === ${JSON.stringify(manifestPath)}) {
    exchanged = true;
    originalWriteFileSync(${JSON.stringify(temporaryManifest)}, ${JSON.stringify(`${JSON.stringify(maliciousManifest, null, 2)}\n`)}, { mode: 0o600 });
    originalRenameSync(${JSON.stringify(temporaryManifest)}, ${JSON.stringify(manifestPath)});
  }
  return value;
};
moduleBuiltin.syncBuiltinESMExports();
`);
    try {
      const started = run(fixture, ["start"]);
      expect(started.status, started.stderr).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).harness.executable.path).toBe("/bin/false");
      const state = JSON.parse(readFileSync(join(fixture.root, "state/maze-arena/run/server.json"), "utf8"));
      expect(state.harnessExecutablePath).not.toBe("/bin/false");
      expect(state.harnessRuntimePayloadSha256).toBe(JSON.parse(originalManifestText).harness.executable.payloadSha256);
      expect(hashHarnessRuntimePayload(state.harnessRuntimeRoot)).toBe(state.harnessRuntimePayloadSha256);
    } finally {
      writeFileSync(fixture.nodePrelude, originalPrelude);
      writeFileSync(manifestPath, originalManifestText, { mode: 0o600 });
      rmSync(temporaryManifest, { force: true });
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("流式健康响应在墙钟截止后失败并释放运行管理锁", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
    expect(run(fixture, ["start"]).status).toBe(0);
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const port = state.port;
    expect(run(fixture, ["stop"]).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    cpSync(manifest.harness.executable.runtimeRoot, state.harnessRuntimeRoot, { recursive: true, verbatimSymlinks: true });

    const streaming = spawn(process.execPath, ["-e", `
      const http = require("node:http");
      http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const timer = setInterval(() => response.write(" "), 10);
        response.on("close", () => clearInterval(timer));
      }).listen(${port}, "127.0.0.1");
    `], { stdio: "ignore" });
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const ready = spawnSync(process.execPath, ["-e", `require("node:http").get("http://127.0.0.1:${port}", r => {
          r.destroy(); process.exit(0);
        }).on("error", () => process.exit(1));`]);
        if (ready.status === 0) break;
        wait(20);
      }
      const procStat = readFileSync(`/proc/${streaming.pid}/stat`, "utf8");
      const procStartTime = procStat.slice(procStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      writeFileSync(statePath, `${JSON.stringify({ ...state, pid: streaming.pid, procStartTime })}\n`, { mode: 0o600 });
      const startedAt = Date.now();
      const checked = run(fixture, ["status"]);
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toContain("HTTP：异常");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      const recovered = run(fixture, ["status"]);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stderr).not.toContain("另一个运行管理命令正在执行");
    } finally {
      if (streaming.exitCode === null && streaming.signalCode === null) {
        const closed = new Promise<void>((resolveClosed) => streaming.once("close", () => resolveClosed()));
        streaming.kill("SIGKILL");
        await closed;
      }
    }
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("stop 健康检查期间进程身份变化时不向替代身份发送信号或等待超时", () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const signalMarker = join(fixture.root, "unexpected-stop-signal");
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    expect(run(fixture, ["start"]).status).toBe(0);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    try {
      writeFileSync(fixture.nodePrelude, `${originalPrelude}
const fs = require("node:fs");
const moduleBuiltin = require("node:module");
const originalReadFileSync = fs.readFileSync;
const originalKill = process.kill.bind(process);
const targetPid = Number(process.env.MAZE_TEST_IDENTITY_PID);
let targetStatReads = 0;
fs.readFileSync = function(path, ...args) {
  const value = originalReadFileSync(path, ...args);
  if (String(path) !== "/proc/" + targetPid + "/stat" || typeof value !== "string") return value;
  targetStatReads += 1;
  if (targetStatReads < 2) return value;
  const close = value.lastIndexOf(")");
  const fields = value.slice(close + 2).trim().split(/\\s+/);
  fields[19] = String(BigInt(fields[19]) + 1n);
  return value.slice(0, close + 2) + fields.join(" ");
};
process.kill = function(pid, signal) {
  if (pid === targetPid && signal !== undefined && signal !== 0) {
    fs.writeFileSync(process.env.MAZE_TEST_SIGNAL_MARKER, String(signal));
    const error = new Error("replacement identity must not be signaled");
    error.code = "ESRCH";
    throw error;
  }
  return originalKill(pid, signal);
};
moduleBuiltin.syncBuiltinESMExports();
`);
      fixture.env.MAZE_TEST_IDENTITY_PID = String(state.pid);
      fixture.env.MAZE_TEST_SIGNAL_MARKER = signalMarker;
      const startedAt = Date.now();
      const result = run(fixture, ["stop"]);
      expect(result.status, result.stderr).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(existsSync(signalMarker)).toBe(false);
      expect(existsSync(statePath)).toBe(false);
      expect(() => process.kill(state.pid, 0)).not.toThrow();
    } finally {
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_IDENTITY_PID;
      delete fixture.env.MAZE_TEST_SIGNAL_MARKER;
      if (!existsSync(statePath)) writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("正式入口在活动原子步骤期间合并重复 stop 与交错信号，完成后才退出", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const closeMarker = join(fixture.root, "long-atomic-step-close");
    const exitTrigger = join(fixture.root, "finish-long-atomic-step");
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    let state: { pid: number; procStartTime: string } | undefined;
    let released = false;
    try {
      writeFileSync(fixture.nodePrelude, `${originalPrelude}
if (process.env.ARENA_INSTANCE_ID && process.env.ARENA_STARTUP_HANDSHAKE_FD === "3") {
  const fs = require("node:fs");
  const http = require("node:http");
  const originalClose = http.Server.prototype.close;
  http.Server.prototype.close = function(callback) {
    fs.appendFileSync(${JSON.stringify(closeMarker)}, "close\\n");
    const server = this;
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(exitTrigger)})) return;
      clearInterval(timer);
      originalClose.call(server, callback);
    }, 20);
    return server;
  };
}
`);
      const started = run(fixture, ["start"]);
      expect(started.status, started.stderr).toBe(0);
      const stateText = readFileSync(statePath, "utf8");
      const runningState = JSON.parse(stateText) as { pid: number; procStartTime: string };
      state = runningState;

      // Server 已加载上面的正式入口故障注入；后续 CLI 进程仅缩短 30 秒等待窗口。
      writeFileSync(fixture.nodePrelude, `${readFileSync(fixture.nodePrelude, "utf8")}
if (process.env.MAZE_TEST_FAST_STOP === "1") {
  const originalDateNow = Date.now;
  let offset = 0;
  Date.now = () => {
    const value = originalDateNow() + offset;
    offset += 31_000;
    return value;
  };
}
`);
      fixture.env.MAZE_TEST_FAST_STOP = "1";

      const startedAt = Date.now();
      let result = run(fixture, ["stop"]);
      expect(result.status).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(result.stderr).toContain("未能安全停止");
      expect(result.stderr).toContain("活动原子步骤");
      expect(result.stdout).not.toContain("安全停止");
      expect(existsSync(statePath)).toBe(true);
      expect(readFileSync(statePath, "utf8")).toBe(stateText);
      expect(() => process.kill(runningState.pid, 0)).not.toThrow();
      expect(readFileSync(closeMarker, "utf8")).toBe("close\n");

      process.kill(runningState.pid, "SIGINT");
      result = run(fixture, ["stop"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("活动原子步骤");
      expect(result.stdout).not.toContain("安全停止");
      expect(readFileSync(closeMarker, "utf8")).toBe("close\n");
      expect(existsSync(statePath)).toBe(true);
      expect(readFileSync(statePath, "utf8")).toBe(stateText);
      expect(() => process.kill(runningState.pid, 0)).not.toThrow();

      const stormStartedAt = Date.now();
      for (let index = 0; index < 100; index += 1) {
        process.kill(runningState.pid, index % 2 === 0 ? "SIGTERM" : "SIGINT");
      }
      wait(100);
      expect(Date.now() - stormStartedAt).toBeLessThan(2_000);
      expect(readFileSync(closeMarker, "utf8")).toBe("close\n");
      expect(readFileSync(statePath, "utf8")).toBe(stateText);
      expect(() => process.kill(runningState.pid, 0)).not.toThrow();

      writeFileSync(exitTrigger, "done\n");
      released = true;
      expect(waitForProcessExit(runningState.pid, 3_000)).toBe(true);
      result = run(fixture, ["status"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("进程：已停止");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      if (!released) writeFileSync(exitTrigger, "done\n");
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_FAST_STOP;
      if (state) waitForProcessExit(state.pid, 3_000);
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("活动 Server 的缺失或非法 procStartTime 关闭失败并保留状态，恢复身份后可安全停止", () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    try {
      expect(run(fixture, ["start"]).status).toBe(0);
      const originalStateText = readFileSync(statePath, "utf8");
      const state = JSON.parse(originalStateText);
      const invalidValues: unknown[] = [undefined, null, "", "0", "01", "-1", "not-a-start-time", 123];
      for (const procStartTime of invalidValues) {
        const invalidState = { ...state, procStartTime };
        if (procStartTime === undefined) delete invalidState.procStartTime;
        const invalidStateText = `${JSON.stringify(invalidState)}\n`;
        for (const command of ["start", "status", "stop"] as const) {
          writeFileSync(statePath, invalidStateText, { mode: 0o600 });
          const result = run(fixture, [command]);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("缺少有效启动时间");
          expect(result.stderr).toContain("状态文件已保留");
          expect(readFileSync(statePath, "utf8")).toBe(invalidStateText);
          expect(() => process.kill(state.pid, 0)).not.toThrow();
        }
      }

      writeFileSync(statePath, originalStateText, { mode: 0o600 });
      writeFileSync(fixture.nodePrelude, `${originalPrelude}
if (process.env.MAZE_TEST_UNREADABLE_PROCESS_IDENTITY) {
  const fs = require("node:fs");
  const moduleBuiltin = require("node:module");
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function(path, ...args) {
    if (String(path) === "/proc/" + process.env.MAZE_TEST_UNREADABLE_PROCESS_IDENTITY + "/stat") {
      const error = new Error("identity unavailable");
      error.code = "EACCES";
      throw error;
    }
    return originalReadFileSync(path, ...args);
  };
  moduleBuiltin.syncBuiltinESMExports();
}
`);
      fixture.env.MAZE_TEST_UNREADABLE_PROCESS_IDENTITY = String(state.pid);
      for (const command of ["start", "status", "stop"] as const) {
        const result = run(fixture, [command]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("无法验证运行进程身份");
        expect(result.stderr).toContain("状态文件已保留");
        expect(readFileSync(statePath, "utf8")).toBe(originalStateText);
        expect(() => process.kill(state.pid, 0)).not.toThrow();
      }
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_UNREADABLE_PROCESS_IDENTITY;

      const status = run(fixture, ["status"]);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("HTTP：健康");
      expect(run(fixture, ["stop"]).status).toBe(0);

      writeFileSync(statePath, `${JSON.stringify({ ...state, pid: 2_147_483_647, procStartTime: null })}\n`, { mode: 0o600 });
      const stale = run(fixture, ["status"]);
      expect(stale.status, stale.stderr).toBe(0);
      expect(stale.stdout).toContain("进程：已停止");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_UNREADABLE_PROCESS_IDENTITY;
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("外部命令失败不回显 opaque stderr", async () => {
    const fixture = prepareBuiltImageFixture();
    try {
    writeFileSync(join(fixture.root, "docker-fail"), "fail\n");
    let result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("opaque-d8e20b53");
    expect(result.stderr).toContain("docker 检查失败（退出码 7）");

    rmSync(join(fixture.root, "docker-fail"));
    writeFileSync(join(fixture.root, "data/maze-arena/harness/plugin-fail"), "fail\n");
    fixture.env.MAZE_ARENA_PORT = "0";
    result = run(fixture, ["start"]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("opaque-c7d19a42");
    const logsRoot = join(fixture.root, "state/maze-arena/logs");
    const logs = readdirSync(logsRoot).map((name) => readFileSync(join(logsRoot, name), "utf8")).join("\n");
    expect(logs).not.toContain("opaque-c7d19a42");
    expect(logs).toMatch(/dsh .*退出码 7/);
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("Docker 成功退出但返回畸形结构化输出时不回显原文", () => {
    const fixture = prepareBuiltImageFixture();
    writeFileSync(join(fixture.root, "docker-opaque-security"), "1\n");
    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("无法解析 Docker 安全能力，预期为字符串数组 JSON");
    expect(`${result.stdout}${result.stderr}`).not.toContain("opaque-security-f41c82d7");
  });

  it("并发双 start、start/status 与 start/stop 由同一内核锁串行化", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
    const lockPath = join(fixture.root, "state/maze-arena/run/server.lock");
    writeFileSync(lockPath, "stale-owner\n", { mode: 0o600 });
    expect(run(fixture, ["status"]).stdout).toContain("进程：已停止");
    writeFileSync(join(fixture.root, "doctor-delay"), "delay\n");

    for (const contender of ["start", "status", "stop"] as const) {
      const first = runAsync(fixture, ["start"]);
      wait(100);
      const forged = run(fixture, ["--runtime-lock-held", contender]);
      expect(forged.status).toBe(1);
      expect(forged.stderr).toContain("用法：maze-arena");
      expect(forged.stdout).not.toMatch(/Maze Arena 已|进程：|HTTP：/);
      if (contender === "status") {
        const request = JSON.stringify({ schemaVersion: 1, args: ["status"] });
        const injected = await runWithPrivateFd(fixture, ["status"], request, true);
        expect(injected.status).toBe(1);
        expect(injected.stderr).toContain("未持有目标互斥锁");
        expect(injected.stdout).not.toMatch(/进程：|HTTP：/);
        const unbounded = await runWithPrivateFd(fixture, ["status"], request, false);
        expect(unbounded.status).toBe(1);
        expect(unbounded.stderr).toContain("未持有目标互斥锁");
        expect(unbounded.stdout).not.toMatch(/进程：|HTTP：/);
      }
      const collision = run(fixture, [contender]);
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain("另一个运行管理命令正在执行");
      const started = await first;
      expect(started.status, started.stderr).toBe(0);
      expect(run(fixture, ["status"]).stdout).toContain("HTTP：健康");
      expect(run(fixture, ["stop"]).status).toBe(0);
    }
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 60_000);

  it("锁持有者在 doctor 期间异常终止时 action 同步终止且后续命令可恢复", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    writeFileSync(join(fixture.root, "doctor-delay"), "delay\n");
    try {

    const pending = runAsyncProcess(fixture, ["start"]);
    let lockOwner = 0;
    for (let attempt = 0; attempt < 50 && lockOwner === 0; attempt += 1) {
      wait(20);
      try {
        lockOwner = Number(readFileSync(`/proc/${pending.child.pid}/task/${pending.child.pid}/children`, "utf8").trim().split(/\s+/)[0]);
      } catch {}
    }
    expect(lockOwner).toBeGreaterThan(0);
    process.kill(lockOwner, "SIGKILL");
    const interrupted = await pending.result;
    expect(interrupted.status).not.toBe(0);
    expect(existsSync(join(fixture.root, "state/maze-arena/run/server.json"))).toBe(false);

    rmSync(join(fixture.root, "doctor-delay"));
    expect(run(fixture, ["start"]).status).toBe(0);
    expect(run(fixture, ["status"]).stdout).toContain("HTTP：健康");
    expect(run(fixture, ["stop"]).status).toBe(0);
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 60_000);

  it("Server ready 后写状态前杀死实际锁持有者会关闭未确认实例且允许后续启动", async () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const beforeStateMarker = join(fixture.root, "before-server-state-write.json");
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    let lockOwner = 0;
    let serverPid = 0;
    const pending = (() => {
      writeFileSync(fixture.nodePrelude, `${originalPrelude}
if (process.env.MAZE_TEST_BLOCK_BEFORE_STATE_WRITE === "1") {
  const fs = require("node:fs");
  const moduleBuiltin = require("node:module");
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function(path, ...args) {
    if (String(path).startsWith(${JSON.stringify(join(fixture.root, "state/maze-arena/run/.server."))})
      && String(path).endsWith(".tmp")) {
      originalWriteFileSync(${JSON.stringify(beforeStateMarker)}, JSON.stringify({
        ownerPid: process.pid,
        state: JSON.parse(String(args[0])),
      }));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return originalWriteFileSync(path, ...args);
  };
  moduleBuiltin.syncBuiltinESMExports();
}
`);
      fixture.env.MAZE_TEST_BLOCK_BEFORE_STATE_WRITE = "1";
      return runAsyncProcess(fixture, ["start"]);
    })();
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(beforeStateMarker); attempt += 1) wait(20);
      expect(existsSync(beforeStateMarker)).toBe(true);
      const beforeState = JSON.parse(readFileSync(beforeStateMarker, "utf8"));
      lockOwner = Number(beforeState.ownerPid);
      expect(lockOwner).toBeGreaterThan(0);
      expect(lockOwner).not.toBe(pending.child.pid);
      serverPid = Number(beforeState.state.pid);
      expect(serverPid).toBeGreaterThan(0);
      expect(existsSync(statePath)).toBe(false);
      const pendingHealth = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${String(beforeState.state.port)}/api/health")
        .then(async response => {
          const body = await response.json();
          process.exit(response.status === 503 && body.error?.code === "STARTUP_PENDING" ? 0 : 1);
        }).catch(() => process.exit(1));`]);
      expect(pendingHealth.status).toBe(0);

      process.kill(lockOwner, "SIGKILL");
      const interrupted = await Promise.race([
        pending.result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("锁持有者未在 SIGKILL 后退出")), 3_000)),
      ]);
      expect(interrupted.status).not.toBe(0);
      expect(waitForProcessExit(serverPid, 3_000)).toBe(true);
      expect(existsSync(statePath)).toBe(false);
      expect(readdirSync(dirname(statePath)).some((name) => name.startsWith(".server.") && name.endsWith(".tmp"))).toBe(false);

      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_BLOCK_BEFORE_STATE_WRITE;
      const restarted = run(fixture, ["start"]);
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(run(fixture, ["status"]).stdout).toContain("HTTP：健康");
      expect(run(fixture, ["stop"]).status).toBe(0);
    } finally {
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_BLOCK_BEFORE_STATE_WRITE;
      if (lockOwner > 0) {
        try { process.kill(lockOwner, "SIGKILL"); } catch {}
      }
      if (serverPid > 0 && !waitForProcessExit(serverPid, 1_000)) {
        try { process.kill(serverPid, "SIGKILL"); } catch {}
      }
      cleanupFixtureServer(fixture);
    }
  }, 60_000);

  it.each([
    ["非法", "invalid"],
    ["超限", "oversized"],
    ["超时", "dropped"],
  ] as const)("Server 对%s commit 确认关闭失败并清理未确认实例", (_label, mode) => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const statePath = join(fixture.root, "state/maze-arena/run/server.json");
    const serverMarker = join(fixture.root, `startup-commit-${mode}.pid`);
    const originalPrelude = readFileSync(fixture.nodePrelude, "utf8");
    try {
      writeFileSync(fixture.nodePrelude, `${originalPrelude}
if (process.env.MAZE_TEST_STARTUP_COMMIT_MODE) {
  const fs = require("node:fs");
  const net = require("node:net");
  const originalWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function(chunk, ...args) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!text.includes('"phase":"commit"')) return originalWrite.call(this, chunk, ...args);
    const record = JSON.parse(text);
    fs.writeFileSync(${JSON.stringify(serverMarker)}, String(record.pid));
    if (process.env.MAZE_TEST_STARTUP_COMMIT_MODE === "dropped") {
      for (const argument of args) if (typeof argument === "function") queueMicrotask(argument);
      return true;
    }
    const replacement = process.env.MAZE_TEST_STARTUP_COMMIT_MODE === "oversized"
      ? "x".repeat(9 * 1024) + "\\n"
      : JSON.stringify({ ...record, phase: "invalid" }) + "\\n";
    return originalWrite.call(this, replacement, ...args);
  };
}
`);
      fixture.env.MAZE_TEST_STARTUP_COMMIT_MODE = mode;
      const startedAt = Date.now();
      const result = run(fixture, ["start"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("生产 Server 启动");
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(existsSync(statePath)).toBe(false);
      const serverPid = Number(readFileSync(serverMarker, "utf8"));
      expect(waitForProcessExit(serverPid, 3_000)).toBe(true);
    } finally {
      writeFileSync(fixture.nodePrelude, originalPrelude);
      delete fixture.env.MAZE_TEST_STARTUP_COMMIT_MODE;
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("拒绝伪造、越界、超长和悬挂的 Server 启动握手且不留下状态或进程", () => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    const serverEntry = join(repositoryRoot, "apps/server/dist/index.js");
    const originalEntry = readFileSync(serverEntry);
    const cases = [
      { name: "wrong-instance", payload: '{schemaVersion:1,phase:"ready",instanceId:"wrong-instance",pid:process.pid,port:43210}' },
      { name: "wrong-pid", payload: '{schemaVersion:1,phase:"ready",instanceId:process.env.ARENA_INSTANCE_ID,pid:process.pid+1,port:43210}' },
      { name: "invalid-port", payload: '{schemaVersion:1,phase:"ready",instanceId:process.env.ARENA_INSTANCE_ID,pid:process.pid,port:0}' },
      { name: "extra-field", payload: '{schemaVersion:1,phase:"ready",instanceId:process.env.ARENA_INSTANCE_ID,pid:process.pid,port:43210,secret:"opaque-handshake-secret"}' },
      { name: "oversized", payload: '"x".repeat(9*1024)' },
      { name: "hanging", payload: undefined },
    ] as const;
    try {
      for (const handshakeCase of cases) {
        const marker = join(fixture.root, `handshake-${handshakeCase.name}.pid`);
        writeFileSync(serverEntry, `
import { closeSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
const descriptor = Number(process.env.ARENA_STARTUP_HANDSHAKE_FD);
${handshakeCase.payload === undefined ? "" : `writeFileSync(descriptor, JSON.stringify(${handshakeCase.payload}) + "\\n"); closeSync(descriptor);`}
setInterval(() => {}, 1000);
`);
        const result = run(fixture, ["start"]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("生产 Server 启动握手");
        expect(`${result.stdout}${result.stderr}`).not.toContain("opaque-handshake-secret");
        expect(existsSync(join(fixture.root, "state/maze-arena/run/server.json"))).toBe(false);
        const pid = Number(readFileSync(marker, "utf8"));
        expect(waitForProcessExit(pid), `${handshakeCase.name} 残留 PID ${pid}`).toBe(true);
      }
    } finally {
      writeFileSync(serverEntry, originalEntry);
      cleanupFixtureServer(fixture);
    }
  }, 60_000);

  it("合法锁持有者的悬挂私有请求超时后关闭 FD 并释放运行锁", async () => {
    const fixture = prepareBuiltImageFixture();
    const request = JSON.stringify({ schemaVersion: 1, args: ["status"] });
    const hanging = await runWithLockedPrivateFd(fixture, ["status"], request);
    expect(hanging.status).toBe(1);
    expect(hanging.stderr).toContain("私有请求读取超时");
    expect(hanging.elapsedMs).toBeGreaterThanOrEqual(1_800);
    expect(hanging.elapsedMs).toBeLessThan(4_000);
    const recovered = run(fixture, ["status"]);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("进程：已停止");
  }, 30_000);

  it("从锁定 Harness 与当前构建产物构建镜像并保存 Docker 实际摘要", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);

    const result = buildImage(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`正式不可变镜像引用：${imageId}`);
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toMatchObject({
      imageId,
      imageReference: imageId,
      harnessCommit: commit,
      dshExecutableSha256: createHash("sha256").update(readFileSync(fixture.dsh)).digest("hex"),
      resourcePolicy: {
        network: "none",
        readOnlyRootFilesystem: true,
        user: "65532:65532",
        capabilities: "ALL",
      },
    });
    expect(manifest.matchProfile.projectArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\nsolver\n");
  });

  it("Generator 源码已变化且 dist 陈旧时仍在哈希和复制前显式重建全部镜像包", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.root, "generator-source-changed"), "new source\n");
    writeFileSync(join(fixture.root, "generator-stale-dist"), "old artifact\n");

    const result = buildImage(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "project-build-args"), "utf8")).toBe([
      "--filter @maze-arena/contracts",
      "--filter @maze-arena/engine",
      "--filter @maze-arena/match-profile",
      "--filter @maze-arena/generator-plugin",
      "--filter @maze-arena/solver-plugin",
      "build\n",
    ].join(" "));
  });

  it("清理 Generator dist 孤儿文件后再构建、哈希并复制镜像产物", () => {
    const orphan = join(repositoryRoot, "packages/generator-plugin/dist/orphan.js");
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(orphan, "stale orphan artifact\n");
    writeFileSync(join(fixture.root, "reject-generator-orphan"), "1\n");
    try {
      const result = buildImage(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(orphan, { force: true });
    }
  });

  it("清理 Solver dist 孤儿文件后再构建、哈希并复制镜像产物", () => {
    const orphan = join(repositoryRoot, "packages/solver-plugin/dist/orphan.js");
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(orphan, "stale solver artifact\n");
    writeFileSync(join(fixture.root, "reject-solver-orphan"), "1\n");
    try {
      const result = buildImage(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(orphan, { force: true });
    }
  });

  it("Harness 生产部署缺少运行依赖时拒绝构建镜像", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.root, "pnpm-skip-dependency"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("生产部署缺少运行依赖");
  });

  it("镜像内最小 Match Profile 无法完成 ready 握手时拒绝记录摘要", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.handshake-fail"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker 检查失败（退出码 1）");
    expect(result.stderr).not.toContain("profile load failed");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it("镜像内 Solver Match Profile 无法完成 ready 握手时拒绝记录摘要", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.solver-handshake-fail"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker 检查失败（退出码 1）");
    expect(result.stderr).not.toContain("solver profile load failed");
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\n");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it.each(["latest", "maze-arena/match-profile:1.0.0", "sha256:abcd"])(
    "拒绝浮动或不完整的基础镜像引用 %s",
    (reference) => {
      const fixture = createFixture();
      expect(install(fixture).status).toBe(0);
      const result = run(fixture, ["image", "build", "--base-image", reference, "--image-name", "maze-arena/match-profile:local"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("必须使用完整 SHA-256 摘要");
    },
  );

  it.each([
    `node:latest@sha256:${"a".repeat(64)}`,
    `node:1.2.3@sha256:${"a".repeat(64)}`,
  ])("即使摘要合法也拒绝带 tag 的基础镜像引用 %s", (reference) => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const result = run(fixture, ["image", "build", "--base-image", reference, "--image-name", "maze-arena/match-profile:local"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("必须使用完整 SHA-256 摘要");
  });

  it("允许 registry 端口与无 tag 路径组成的摘要基础镜像引用", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    const reference = `localhost:5000/runtime/node@sha256:${"a".repeat(64)}`;
    expect(buildImage(fixture, reference).status).toBe(0);
  });

  it("doctor 拒绝缺失镜像、镜像替换和浮动正式引用", () => {
    const fixture = prepareBuiltImageFixture();
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    writeFileSync(join(fixture.root, "docker-state.missing"), "1\n");
    let result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("镜像缺失或不可读取");
    rmSync(join(fixture.root, "docker-state.missing"));

    writeFileSync(join(fixture.root, "docker-state.image-id"), `sha256:${"c".repeat(64)}\n`);
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("镜像摘要漂移");

    writeFileSync(join(fixture.root, "docker-state.image-id"), `${imageId}\n`);
    manifest.matchProfile.imageReference = `maze-arena/match-profile:latest@sha256:${"a".repeat(64)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("禁止 latest 或普通版本标签");

    delete manifest.matchProfile;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("镜像尚未构建");
  });

  it("doctor 拒绝镜像构建身份漂移与 Docker 安全能力不足", () => {
    const fixture = prepareBuiltImageFixture();
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.matchProfile.harnessCommit = "f".repeat(40);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    let result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("构建身份与当前安装清单不一致");

    manifest.matchProfile.harnessCommit = manifest.harness.commit;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(join(fixture.root, "docker-state.security"), '["name=cgroupns"]\n');
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少必需的 seccomp");
  });

  it("doctor 拒绝实际运行 CLI 的不受支持 Node.js", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(fixture.nodePrelude, 'Object.defineProperty(process, "version", { value: "v21.7.0" });\n');
    executable(join(fixture.bin, "node"), 'printf "v21.7.0\\n"');

    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node.js 版本不受支持");
  });

  it.each([
    ["pnpm", 'printf "9.15.0\\n"', "pnpm 版本不受支持"],
    ["git", 'if [ "${1:-}" = "--version" ]; then printf "git version 2.30.0\\n"; else printf "not-used\\n"; fi', "Git 版本不受支持"],
    ["docker", 'if [ "${1:-}" = "--version" ]; then printf "Docker version 23.0.0, build fixture\\n"; else printf "23.0.0\\n"; fi', "Docker 版本不受支持"],
  ] as const)("doctor 清晰拒绝不受支持的 %s", (tool, script, message) => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    executable(join(fixture.bin, tool), script);

    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("doctor 清晰拒绝缺失工具且不尝试下载", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const emptyBin = join(fixture.root, "empty-bin");
    mkdirSync(emptyBin);
    const result = run({ ...fixture, env: { ...fixture.env, PATH: emptyBin } }, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少必需工具 node");
    expect(result.stderr).not.toMatch(/download|clone|upgrade|installing/i);
  });

  it("doctor 对 Harness 提交、可执行文件和精确版本漂移均关闭失败", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);

    executable(join(fixture.bin, "git"), 'if [ "${1:-}" = "--version" ]; then printf "git version 2.45.0\\n"; else printf "ffffffffffffffffffffffffffffffffffffffff\\n"; fi');
    let result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness 源码提交漂移");

    executable(join(fixture.bin, "git"), `if [ "\${1:-}" = "--version" ]; then printf "git version 2.45.0\\n"; elif [ "\${3:-}" = "status" ]; then :; else printf "${harnessCommit}\\n"; fi`);
    executable(fixture.dsh, 'printf "dsh 2026.09.2\\n"');
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dsh 可执行文件内容漂移");

    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.harness.executable.sha256 = createHash("sha256").update(readFileSync(fixture.dsh)).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dsh 版本漂移|Harness runtime 冻结载荷身份已漂移/);
  });

  it("doctor 拒绝把源码身份目录冒充独立的 Harness 运行载荷根", () => {
    const fixture = prepareBuiltImageFixture();
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.harness.executable.sourceRuntimeRoot).toBe(fixture.bin);
    expect(manifest.harness.executable.runtimeRoot)
      .toBe(join(fixture.root, "data/maze-arena/harness-runtimes", manifest.harness.executable.payloadSha256));
    expect(manifest.harness.executable.runtimeRoot).not.toBe(manifest.harness.sourceDirectory);
    manifest.harness.executable.runtimeRoot = manifest.harness.sourceDirectory;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness runtime root 漂移");
  });

  it("doctor 拒绝安装后漂移的 Harness 运行依赖载荷", () => {
    const fixture = prepareBuiltImageFixture();
    writeFileSync(join(fixture.bin, "late-runtime-dependency.js"), "export const changed = true;\n");

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Harness runtime (?:来源载荷内容漂移|冻结载荷身份已漂移)/);
  });

  it("doctor 拒绝权限过宽的敏感目录", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    chmodSync(join(fixture.root, "data/maze-arena"), 0o755);

    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("目录权限必须为 0700");
  });

  it.each(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const)(
    "拒绝相对路径覆盖 %s，且不会在当前工作目录创建运行数据",
    (name) => {
      const fixture = createFixture();
      const relativeRoot = `relative-${name.toLowerCase()}`;
      const result = run({
        ...fixture,
        env: { ...fixture.env, [name]: relativeRoot },
      }, [
        "install",
        "--harness-source", fixture.harness,
        "--harness-commit", harnessCommit,
        "--dsh-executable", fixture.dsh,
        "--dsh-version", "dsh 2026.09.1",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name} 必须是绝对路径`);
      expect(existsSync(join(packageRoot, relativeRoot))).toBe(false);
    },
  );

  it("全部 XDG 目录未设置时拒绝相对 HOME，且不会在当前工作目录创建运行数据", () => {
    const fixture = createFixture();
    const relativeHome = "relative-home";
    const result = run({
      ...fixture,
      env: {
        ...fixture.env,
        HOME: relativeHome,
        XDG_CONFIG_HOME: undefined,
        XDG_DATA_HOME: undefined,
        XDG_STATE_HOME: undefined,
      },
    }, [
      "install",
      "--harness-source", fixture.harness,
      "--harness-commit", harnessCommit,
      "--dsh-executable", fixture.dsh,
      "--dsh-version", "dsh 2026.09.1",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HOME 必须是绝对路径");
    expect(existsSync(join(packageRoot, relativeHome))).toBe(false);
  });

  it.each(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const)(
    "拒绝绝对 %s 把运行根放入 Maze Arena 源码树",
    (name) => {
      const fixture = createFixture();
      const forbiddenRoot = join(repositoryRoot, "maze-arena");
      const result = run({
        ...fixture,
        env: { ...fixture.env, [name]: repositoryRoot },
      }, [
        "install",
        "--harness-source", fixture.harness,
        "--harness-commit", harnessCommit,
        "--dsh-executable", fixture.dsh,
        "--dsh-version", "dsh 2026.09.1",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("目录不得位于 Maze Arena 源码仓库内");
      expect(existsSync(forbiddenRoot)).toBe(false);
    },
  );

  it("拒绝通过符号链接把运行根回指 Maze Arena 源码树", () => {
    const fixture = createFixture();
    const sourceLink = join(fixture.root, "source-link");
    symlinkSync(repositoryRoot, sourceLink, "dir");
    const forbiddenRoot = join(repositoryRoot, "maze-arena");
    const result = run({
      ...fixture,
      env: { ...fixture.env, XDG_DATA_HOME: sourceLink },
    }, [
      "install",
      "--harness-source", fixture.harness,
      "--harness-commit", harnessCommit,
      "--dsh-executable", fixture.dsh,
      "--dsh-version", "dsh 2026.09.1",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("数据目录不得位于 Maze Arena 源码仓库内");
    expect(existsSync(forbiddenRoot)).toBe(false);
  });

  it.each([
    ["tracked unstaged", (fixture: Fixture) => writeFileSync(join(fixture.harness, "README.md"), "changed\n")],
    ["staged", (fixture: Fixture) => {
      writeFileSync(join(fixture.harness, "README.md"), "staged\n");
      git(fixture.harness, ["add", "README.md"]);
    }],
    ["untracked", (fixture: Fixture) => writeFileSync(join(fixture.harness, "untracked.txt"), "new\n")],
  ] as const)("工作树存在 %s 变化时拒绝 install", (_kind, makeDirty) => {
    const fixture = createFixture();
    const commit = initializeHarnessRepository(fixture);
    makeDirty(fixture);

    const result = installAtCommit(fixture, commit);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness 源码工作树不干净");
    expect(existsSync(join(fixture.root, "config/maze-arena/install-manifest.json"))).toBe(false);
  });

  it("安装后出现 tracked 修改时 doctor 关闭失败", () => {
    const fixture = createFixture();
    const commit = initializeHarnessRepository(fixture);
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.harness, "README.md"), "changed after install\n");

    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness 源码工作树不干净");
  });

  it("Harness ignored 文件不视为源码身份漂移", () => {
    const fixture = createFixture();
    const commit = initializeHarnessRepository(fixture);
    writeFileSync(join(fixture.harness, "ignored.log"), "local cache\n");

    const result = installAtCommit(fixture, commit);
    expect(result.status, result.stderr).toBe(0);
  });
});
