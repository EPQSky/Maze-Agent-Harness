import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hashHarnessRuntimePayload } from "@maze-arena/dsh-integration";
import { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cliPath = join(packageRoot, "dist/cli.js");
const dshVersion = "0.1.2-rc.1";
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
  dsh: string;
  nodePrelude: string;
  env: NodeJS.ProcessEnv;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o700);
}

function restoreDirectoryModes(source: string, target: string): void {
  chmodSync(target, statSync(source).mode & 0o777);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreDirectoryModes(join(source, entry.name), join(target, entry.name));
  }
}

function git(cwd: string, args: string[]): string {
  if (!realGit) throw new Error("测试环境缺少真实 Git");
  const result = spawnSync(realGit, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function createFixture(overrides: Partial<Record<"node" | "npm" | "pnpm" | "git" | "docker" | "dsh", string>> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "maze-cli-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const nodePrelude = join(root, "node-version.cjs");
  const modelExport = join(root, "data/maze-arena/harness/settings.yaml");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(dirname(modelExport), { recursive: true, mode: 0o700 });
  const projectBackup = join(root, "project-dist-backup");
  mkdirSync(projectBackup);
  for (const directory of imagePackageDirectories) {
    cpSync(join(repositoryRoot, "packages", directory, "dist"), join(projectBackup, directory), { recursive: true });
  }
  writeFileSync(nodePrelude, 'Object.defineProperty(process, "version", { value: "v22.12.0" });\n');
  writeFileSync(modelExport, `${JSON.stringify({
    "llm-pi-ai": { providers: {
      "vendor-a": { displayName: "Vendor A", apiKeyEnv: "VENDOR_A_API_KEY",
        baseURL: "https://vendor-a.example/v1", api: "openai-completions",
        models: [{ id: "compact", name: "Compact", contextWindow: 8_000, maxTokens: 2_000 }] },
      "vendor-b": { displayName: "Vendor B", apiKeyEnv: "VENDOR_B_API_KEY",
        baseURL: "https://vendor-b.example/v1", api: "openai-completions",
        models: [{ id: "reasoner", name: "Reasoner", contextWindow: 16_000, maxTokens: 4_000,
          reasoningEfforts: { off: "off", low: "low", high: "high", max: "max" } }] },
    } },
    "maze-arena-cost-policy": { id: "pi-ai-configured-cost-v1", multipliers: {
      "vendor-a/compact": 1, "vendor-b/reasoner": 2,
    } },
  }, null, 2)}\n`);

  executable(join(bin, "node"), overrides.node ?? 'printf "v22.12.0\\n"');
  executable(join(bin, "pnpm"), overrides.pnpm ?? `
if [ -n "\${DSH_HOME:-}" ]; then
  printf '%s\\n' "$0" > "\${DSH_HOME}/frozen-pnpm-executable"
else
  printf '%s\\n' "$0" >> "${join(root, "pnpm-executables")}"
fi
if [ "\${1:-}" = "--version" ]; then printf "10.15.0\\n"; exit 0; fi
printf '%s\\n' "$*" >> "${join(root, "pnpm-invocations")}"
printf '%s\\n' "\${npm_config_store_dir:-}" > "${join(root, "pnpm-store-dir")}"
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
  *" exec tsx scripts/release/pack.ts --family "*)
    family=""; output=""; previous=""
    for argument in "$@"; do
      if [ "$previous" = "--family" ]; then family="$argument"; fi
      if [ "$previous" = "--out" ]; then output="$argument"; fi
      previous="$argument"
    done
    /bin/mkdir -p "$output"
    if [ "$family" = "vendor" ]; then
      : > "$output/deepseek-ai-cordis-plugin-group-4.0.0.tgz"
    else
      : > "$output/deepseek-ai-dsh-runtime-0.1.2-rc.1.tgz"
      : > "$output/deepseek-ai-dsh-0.1.2-rc.1.tgz"
    fi
    ;;
  *" build ")
    /bin/mkdir -p "$directory/apps/dsh/lib"
    /bin/cp "${join(bin, "dsh")}" "$directory/apps/dsh/lib/bin.js"
    ;;
esac`);
  executable(join(bin, "npm"), overrides.npm ?? `
prefix=""; previous=""
for argument in "$@"; do
  if [ "$previous" = "--prefix" ]; then prefix="$argument"; fi
  previous="$argument"
done
[ -n "$prefix" ] || { printf "missing npm prefix\\n" >&2; exit 1; }
/bin/mkdir -p "$prefix/node_modules/@deepseek-ai/dsh/lib" "$prefix/node_modules/@deepseek-ai/dsh-runtime" "$prefix/node_modules/@deepseek-ai/dsh-sdk-protocol" "$prefix/node_modules/pnpm/bin" "$prefix/node_modules/.bin"
/bin/cp "${join(bin, "dsh")}" "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
/bin/cp "${join(bin, "plugin-install.py")}" "$prefix/node_modules/@deepseek-ai/dsh/lib/plugin-install.py"
/bin/cp "${join(bin, "pnpm")}" "$prefix/node_modules/pnpm/bin/pnpm.cjs"
/bin/ln -s ../pnpm/bin/pnpm.cjs "$prefix/node_modules/.bin/pnpm"
printf 'A\\n' > "$prefix/link-target-a"
printf 'B\\n' > "$prefix/link-target-b"
/bin/ln -s link-target-a "$prefix/runtime-link"
installed_version="0.1.2-rc.1"
if [ -f "${join(root, "npm-wrong-version")}" ]; then installed_version="0.1.2-rc.2"; fi
printf '%s\\n' '{"name":"@deepseek-ai/dsh-runtime","version":"0.1.2-rc.1"}' > "$prefix/node_modules/@deepseek-ai/dsh-runtime/package.json"
printf '%s\\n' '{"name":"@deepseek-ai/dsh-sdk-protocol","version":"0.1.2-rc.1"}' > "$prefix/node_modules/@deepseek-ai/dsh-sdk-protocol/package.json"
printf '%s\\n' '{"name":"pnpm","version":"10.15.0","bin":{"pnpm":"bin/pnpm.cjs"}}' > "$prefix/node_modules/pnpm/package.json"
printf '{"name":"@deepseek-ai/dsh","version":"%s","bin":{"dsh":"lib/bin.js"},"dependencies":{"@deepseek-ai/dsh-runtime":"0.1.2-rc.1","@deepseek-ai/cordis-plugin-group":"4.0.0"}}\\n' "$installed_version" > "$prefix/node_modules/@deepseek-ai/dsh/package.json"
if [ ! -f "${join(root, "pnpm-skip-dependency")}" ]; then
  /bin/mkdir -p "$prefix/node_modules/@deepseek-ai/cordis-plugin-group"
  printf '%s\\n' '{"name":"@deepseek-ai/cordis-plugin-group","version":"4.0.0"}' > "$prefix/node_modules/@deepseek-ai/cordis-plugin-group/package.json"
fi
printf '%s\\n' "$*" > "${join(root, "npm-install-args")}"
`);
  executable(join(bin, "git"), overrides.git ?? 'if [ "${1:-}" = "--version" ]; then printf "git version 2.45.0\\n"; else printf "unexpected git invocation\\n" >&2; exit 1; fi');
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
    harness_package=""; harness_version=""; harness_runtime_sha=""; dsh_sha=""; project_sha=""
    context=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--iidfile" ]; then iidfile="$2"; shift 2; continue; fi
      if [ "$1" = "--label" ]; then
        key=\${2%%=*}; value=\${2#*=}
        case "$key" in
          org.maze-arena.harness-package) harness_package="$value" ;;
          org.maze-arena.harness-version) harness_version="$value" ;;
          org.maze-arena.harness-runtime-sha256) harness_runtime_sha="$value" ;;
          org.maze-arena.dsh-sha256) dsh_sha="$value" ;;
          org.maze-arena.project-artifact-sha256) project_sha="$value" ;;
        esac
        shift 2; continue
      fi
      context="$1"; shift
    done
    [ -f "$context/harness-runtime/node_modules/@deepseek-ai/dsh/package.json" ] || { printf "missing harness runtime\\n" >&2; exit 1; }
    [ -f "$context/harness-runtime/node_modules/@deepseek-ai/cordis-plugin-group/package.json" ] || { printf "missing vendor runtime dependency\\n" >&2; exit 1; }
    found_runtime=""; found_link=""
    while IFS= read -r line; do
      case "$line" in
        "COPY harness-runtime /opt/deepseek-harness") found_runtime=1 ;;
        *"ln -s /opt/deepseek-harness/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh"*) found_link=1 ;;
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
    printf '{"org.maze-arena.harness-package":"%s","org.maze-arena.harness-version":"%s","org.maze-arena.harness-runtime-sha256":"%s","org.maze-arena.dsh-sha256":"%s","org.maze-arena.project-artifact-sha256":"%s"}\\n' "$harness_package" "$harness_version" "$harness_runtime_sha" "$dsh_sha" "$project_sha" > "${dockerState}.labels"
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
    role=""; smoke_source=""; container_name=""; previous=""
    for argument in "$@"; do
      case "$argument" in
        --mount=type=bind,src=*,dst=/arena-source,readonly)
          smoke_source=\${argument#--mount=type=bind,src=}; smoke_source=\${smoke_source%%,dst=*} ;;
      esac
      if [ "$previous" = "--name" ]; then container_name="$argument"; fi
      previous="$argument"
    done
    case "$arguments" in *" --env=MAZE_MATCH_ROLE=generator "*) role=generator ;; esac
    case "$arguments" in *" --env=MAZE_MATCH_ROLE=solver "*) role=solver ;; esac
    [ -n "$role" ] || { printf "missing smoke role\\n" >&2; exit 1; }
    for required in "--interactive" "--network=none" "--read-only" "--cap-drop=ALL" "--env=DSH_HOME=/arena" "--env=MAZE_MATCH_PROFILE_SOURCE=/arena-source" "--tmpfs=/arena:rw,noexec,nosuid,size=32m,mode=0700,uid=65532,gid=65532"; do
      case "$arguments" in *" $required "*) ;; *) printf "missing smoke argument %s\\n" "$required" >&2; exit 1 ;; esac
    done
    case "$arguments" in *" --mount=type=bind,src="*",dst=/arena-source,readonly "*) ;; *) printf "missing smoke profile mount\\n" >&2; exit 1 ;; esac
    /bin/grep -q '"patchReload": "startup"' "$smoke_source/profiles/maze-match-$role/package.json" || { printf "missing startup patch reload\\n" >&2; exit 1; }
    case "$arguments" in *" node /opt/maze-arena/packages/match-profile/dist/container-launcher.js dsh --profile maze-match-$role ") ;; *) printf "missing smoke profile command\\n" >&2; exit 1 ;; esac
    if [ -f "${dockerState}.handshake-fail" ]; then printf "profile load failed\\n" >&2; exit 1; fi
    if [ "$role" = "solver" ] && [ -f "${dockerState}.solver-handshake-fail" ]; then printf "solver profile load failed\\n" >&2; exit 1; fi
    printf '{"type":"match-profile.ready","protocolVersion":1,"role":"%s"}\\n' "$role"
    if [ -f "${dockerState}.post-ready-fail" ]; then printf "hmr failed\\n" >&2; exit 42; fi
    IFS= read -r request || { printf "missing smoke request\\n" >&2; exit 1; }
    if [ "$role" = "generator" ]; then
      case "$request" in *'"requestId":"image-smoke-generator"'*'"type":"generator.start"'*) ;; *) printf "invalid generator smoke request\\n" >&2; exit 1 ;; esac
      printf '{"protocolVersion":1,"requestId":"image-smoke-generator","sequence":1,"role":"generator","payload":{"type":"generator.carve","from":{"x":0,"y":0},"to":{"x":1,"y":0}}}\\n'
    else
      case "$request" in *'"requestId":"image-smoke-solver"'*'"type":"solver.start"'*) ;; *) printf "invalid solver smoke request\\n" >&2; exit 1 ;; esac
      printf '{"protocolVersion":1,"requestId":"image-smoke-solver","sequence":1,"role":"solver","payload":{"type":"solver.ready"}}\\n'
    fi
    if IFS= read -r extra; then printf "unexpected extra smoke request\\n" >&2; exit 1; fi
    printf '%s\\n' "$role" >> "${dockerState}.handshake-roles"
    if [ -f "${dockerState}.natural-smoke-exit-zero" ] || [ -f "${dockerState}.kill-not-running" ]; then exit 0; fi
    while [ ! -f "${dockerState}.term-$container_name" ]; do /bin/sleep 0.05; done
    if [ -f "${dockerState}.smoke-exit-zero" ]; then exit 0; fi
    exit 143
    ;;
  kill)
    printf 'kill\\n' >> "${dockerState}.cleanup-calls"
    container_name="\${3:-}"
    [ -n "$container_name" ] || { printf "missing container name\\n" >&2; exit 1; }
    if [ -f "${dockerState}.natural-smoke-exit-zero" ]; then printf 'Error response from daemon: No such container: %s\\n' "$container_name" >&2; exit 1; fi
    if [ -f "${dockerState}.kill-not-running" ]; then printf 'Error response from daemon: cannot kill container: %s: container is not running\\n' "$container_name" >&2; exit 1; fi
    if [ -f "${dockerState}.kill-fail" ]; then printf 'kill denied\\n' >&2; exit 1; fi
    if [ ! -f "${dockerState}.ignore-smoke-sigterm" ]; then printf 'TERM\\n' > "${dockerState}.term-$container_name"; fi
    exit 0
    ;;
  rm)
    printf 'rm\\n' >> "${dockerState}.cleanup-calls"
    if [ -f "${dockerState}.rm-fail" ]; then printf 'permission denied\\n' >&2; exit 1; fi
    exit 0
    ;;
  inspect)
    printf 'inspect\\n' >> "${dockerState}.cleanup-calls"
    if [ -f "${dockerState}.inspect-daemon-fail" ]; then printf 'cannot connect to daemon\\n' >&2; exit 1; fi
    if [ -f "${dockerState}.inspect-reappear" ]; then
      if [ ! -f "${dockerState}.inspect-once" ]; then
        printf '1\\n' > "${dockerState}.inspect-once"
      elif [ ! -f "${dockerState}.inspect-reappeared" ]; then
        printf '1\\n' > "${dockerState}.inspect-reappeared"; exit 0
      fi
    fi
    printf 'no such object\\n' >&2; exit 1
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
lock_dependencies = {}
lock_packages = {}
shutil.rmtree(os.path.join(profile_root, "node_modules"), ignore_errors=True)
for artifact in artifacts:
    with open(os.path.join(artifact, "package.json"), encoding="utf8") as stream:
        manifest = json.load(stream)
    name = manifest["name"]
    dependencies[name] = "file:" + artifact
    bundles.append(name)
    reference = "file:" + os.path.relpath(artifact, profile_root)
    key = name + "@" + reference
    lock_dependencies[name] = {"specifier": "file:" + artifact, "version": reference}
    lock_packages[key] = {"resolution": {"directory": reference[5:], "type": "directory"}}
    store = os.path.join(profile_root, "node_modules", ".pnpm", name.replace("/", "+") + "@file+fixture", "node_modules", *name.split("/"))
    os.makedirs(os.path.dirname(store), exist_ok=True)
    shutil.copytree(artifact, store)
    target = os.path.join(profile_root, "node_modules", *name.split("/"))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    os.symlink(os.path.relpath(store, os.path.dirname(target)), target, target_is_directory=True)
with open(os.path.join(profile_root, "package.json"), "w", encoding="utf8") as stream:
    json.dump({
        "name": "dsh-profile-" + profile,
        "private": True,
        "dependencies": dependencies,
        "dsh": {"profile": {"bundles": bundles, "patchReload": "startup"}},
    }, stream, indent=2)
    stream.write("\\n")
with open(os.path.join(profile_root, "pnpm-lock.yaml"), "w", encoding="utf8") as stream:
    json.dump({
        "lockfileVersion": "9.0",
        "importers": {".": {"dependencies": lock_dependencies}},
        "packages": lock_packages,
        "snapshots": {key: {} for key in lock_packages},
    }, stream, indent=2)
    stream.write("\\n")
`);
  executable(dsh, overrides.dsh ?? `
if [ "\${1:-}" = "--version" ]; then
  if [ -f "${join(root, "dsh-opaque-version")}" ]; then printf "opaque-dsh-b29e84da\\n"; else printf "0.1.2-rc.1\\n"; fi
  exit 0
fi
if [ "\${1:-}" = "--profile" ] && [ "\${2:-}" = "sdk" ] && [ "\${3:-}" = "--dump-default-config" ]; then
  while IFS= read -r line; do printf '%s\\n' "$line"; done < "${modelExport}";
  exit 0
fi
if [ -f "\${DSH_HOME}/plugin-fail" ] && [ "\${1:-}" = "plugin" ]; then
  printf "opaque-c7d19a42\\n" >&2; exit 7
fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "--profile" ] && [ "\${4:-}" = "add" ]; then
  [ "$(pnpm --version)" = "10.15.0" ] || { printf "frozen pnpm unavailable\\n" >&2; exit 41; }
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
  return installVersion(fixture, dshVersion);
}

function installVersion(fixture: Fixture, version: string) {
  return run(fixture, [
    "install",
    "--dsh-version", version,
  ]);
}

function buildImage(fixture: Fixture, immutableBaseImage = baseImage) {
  return run(fixture, ["image", "build", "--base-image", immutableBaseImage, "--image-name", "maze-arena/match-profile:local"]);
}

function syncModels(fixture: Fixture) {
  return run(fixture, ["models", "sync"]);
}

function prepareBuiltImageFixture(prepareRuntime?: (fixture: Fixture) => void): Fixture {
  const fixture = createFixture();
  prepareRuntime?.(fixture);
  expect(install(fixture).status).toBe(0);
  const result = buildImage(fixture);
  expect(result.status, result.stderr).toBe(0);
  const sync = syncModels(fixture);
  expect(sync.status, sync.stderr).toBe(0);
  return fixture;
}

function replaceFrozenCredentialReference(fixture: Fixture, name: string): void {
  const modelsRoot = join(fixture.root, "data/maze-arena/models");
  const current = join(modelsRoot, "current");
  const release = realpathSync(current);
  const catalog = JSON.parse(readFileSync(join(release, "catalog.json"), "utf8"));
  const runtime = JSON.parse(readFileSync(join(release, "model-export.json"), "utf8"));
  const settings = JSON.parse(readFileSync(join(release, "settings.yaml"), "utf8"));
  catalog.credentialRefs[0] = `dsh-credential://${name}`;
  runtime.credentialRefs[0] = `dsh-credential://${name}`;
  runtime.runtimeProviders[0].credentialRef = `dsh-credential://${name}`;
  settings["llm-pi-ai"].providers["vendor-a"].apiKeyEnv = name;
  const serialized = [catalog, runtime, settings].map((value) => `${JSON.stringify(value, null, 2)}\n`);
  const digest = createHash("sha256").update(serialized[0]!).update("\0").update(serialized[1]!)
    .update("\0").update(serialized[2]!).digest("hex");
  const forged = join(modelsRoot, "releases", digest);
  mkdirSync(forged, { mode: 0o700 });
  const files: Array<[string, string]> = [
    ["catalog.json", serialized[0]!],
    ["model-export.json", serialized[1]!],
    ["settings.yaml", serialized[2]!],
  ];
  for (const [file, contents] of files) writeFileSync(join(forged, file), contents, { mode: 0o400 });
  chmodSync(forged, 0o500);
  rmSync(current);
  symlinkSync(forged, current);
}

describe("正式运行 CLI 黑盒边界", () => {
  it("仓库根 pnpm arena 将首个用户参数原样交给 CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-root-arena-"));
    const result = spawnSync("pnpm", ["arena", "status"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.HOME!, ".cache", "node", "corepack"),
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("state/maze-arena/run/server.lock");
    expect(result.stdout).toContain("node dist/cli.js status");
    expect(`${result.stdout}${result.stderr}`).not.toContain("node dist/cli.js -- status");
  });

  it("正式金丝雀拒绝确定性夹具且不尝试降级运行", () => {
    const fixture = createFixture();
    fixture.env.DSH_EVOLUTION_EXECUTION_KIND = "deterministic-fixture";
    const result = run(fixture, ["canary", "run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("只允许 executionKind=real-provider");
    expect(existsSync(join(fixture.root, "data/maze-arena/canary-reports"))).toBe(false);
  });

  it("正式金丝雀在连接 Server 前关闭失败地限制预算边界", () => {
    const fixture = createFixture();
    const common = [
      "canary", "run", "--name", "预算边界", "--provider", "vendor-a", "--model", "compact",
      "--credential-ref", "dsh-credential://VENDOR_A_API_KEY", "--context-tokens", "2000", "--output-tokens", "500",
    ];
    for (const [tokenLimit, costLimit] of [["20000", "0.5"], ["640000", "5"]] as const) {
      const accepted = run(fixture, [...common, "--token-limit", tokenLimit, "--cost-limit", costLimit]);
      expect(accepted.status).toBe(1);
      expect(accepted.stderr).toContain("请先完成 install、image build、models sync、backup create 与 start");
      expect(accepted.stderr).not.toContain("令牌上限不得超过");
      expect(accepted.stderr).not.toContain("成本上限不得超过");
    }
    let result = run(fixture, [...common, "--token-limit", "640001", "--cost-limit", "0.5"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("令牌上限不得超过 640000");
    result = run(fixture, [...common, "--token-limit", "640000", "--cost-limit", "5.01"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("成本上限不得超过 5");
    result = run(fixture, [
      ...common.slice(0, -4), "--context-tokens", "256000", "--output-tokens", "64001",
      "--token-limit", "640000", "--cost-limit", "5",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("必须至少覆盖 Generator 与 Solver 两个会话");
  });

  it("正式金丝雀对未安装环境给出完整前置命令且不降级", () => {
    const fixture = createFixture();
    const result = run(fixture, [
      "canary", "run", "--name", "未配置环境", "--provider", "vendor-a", "--model", "compact",
      "--credential-ref", "dsh-credential://VENDOR_A_API_KEY", "--context-tokens", "2000", "--output-tokens", "500",
      "--token-limit", "5000", "--cost-limit", "0.5",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("请先完成 install、image build、models sync、backup create 与 start");
    expect(result.stderr).not.toContain("fixture");
  });

  it("backup create/verify/restore 以真实 SQLite 与 Git 谱系完成隔离恢复，doctor 检查最近完整备份", async () => {
    const fixture = prepareBuiltImageFixture();
    const databasePath = join(fixture.root, "data/maze-arena/maze-arena.sqlite");
    const lineageRoot = join(fixture.root, "data/maze-arena/lineages");
    const lineage = new PluginLineageRepository(lineageRoot, databasePath);
    const champions = { generator: "", solver: "" };
    let promotedCommit = "";
    let solverCommit = "";
    try {
      champions.generator = await lineage.initialize("exp-cli-backup", "generator", join(repositoryRoot, "packages/generator-plugin"));
      champions.solver = await lineage.initialize("exp-cli-backup", "solver", join(repositoryRoot, "packages/solver-plugin"));
      await lineage.initialize("validated-draft", "generator", join(repositoryRoot, "packages/generator-plugin"));
      await lineage.initialize("validated-draft", "solver", join(repositoryRoot, "packages/solver-plugin"));
      const candidateRoot = join(fixture.root, "cli-backup-candidate");
      cpSync(join(repositoryRoot, "packages/generator-plugin"), candidateRoot, {
        recursive: true,
        filter: (source) => !source.includes("node_modules") && !source.includes("/dist"),
      });
      const candidateSource = join(candidateRoot, "src/index.ts");
      writeFileSync(candidateSource, `${readFileSync(candidateSource, "utf8")}\n// CLI 真实晋级候选\n`);
      const promoted = await lineage.commitCandidate({ experimentId: "exp-cli-backup", role: "generator",
        sourceRoot: candidateRoot, attemptId: "g0001-generator", hypothesis: "CLI 备份晋级",
        resultSummary: "通过", outcome: "promoted", generation: 1 });
      promotedCommit = promoted.commit;
      const solverRoot = join(fixture.root, "cli-backup-solver");
      cpSync(join(repositoryRoot, "packages/solver-plugin"), solverRoot, {
        recursive: true,
        filter: (source) => !source.includes("node_modules") && !source.includes("/dist"),
      });
      const solverSource = join(solverRoot, "src/index.ts");
      writeFileSync(solverSource, `${readFileSync(solverSource, "utf8")}\n// CLI 求解器平局候选\n`);
      solverCommit = (await lineage.commitCandidate({ experimentId: "exp-cli-backup", role: "solver",
        sourceRoot: solverRoot, attemptId: "g0001-solver", hypothesis: "CLI 备份平局",
        resultSummary: "平局", outcome: "tie" })).commit;
    } finally { lineage.close(); }
    const runtime = new ExperimentRuntimeRepository(databasePath);
    runtime.registerReady({ experimentId: "exp-cli-backup", champions, tokenLimit: 10_000,
      compatibilityFingerprint: "cli-backup-v1" });
    runtime.start("exp-cli-backup");
    const generatorResult = { candidateCommit: promotedCommit, championBefore: champions.generator,
      championAfter: promotedCommit, outcome: "promoted" as const,
      promotionTag: "promotion/exp-cli-backup/generator/g0001", publicProgress: 1, hiddenProgress: 1, aggregate: {} };
    const solverResult = { candidateCommit: solverCommit, championBefore: champions.solver,
      championAfter: champions.solver, outcome: "tie" as const,
      promotionTag: null, publicProgress: 1, hiddenProgress: 1, aggregate: {} };
    runtime.saveRoleCheckpoint({ experimentId: "exp-cli-backup", generation: 1, role: "generator",
      attemptId: "g0001-generator", result: generatorResult, tokens: 0, cost: 0 });
    runtime.saveRoleCheckpoint({ experimentId: "exp-cli-backup", generation: 1, role: "solver",
      attemptId: "g0001-solver", result: solverResult, tokens: 0, cost: 0 });
    runtime.commitGeneration({ experimentId: "exp-cli-backup", generator: generatorResult, solver: solverResult,
      checkpointKey: "generation-1" });
    runtime.close();
    executable(join(fixture.bin, "git"), `exec "${realGit}" "$@"`);

    const created = run(fixture, ["backup", "create"]);
    expect(created.status, created.stderr).toBe(0);
    expect(created.stdout).toContain("备份未由应用加密");
    const backupPath = created.stdout.match(/完整备份已创建：(.+)/)?.[1];
    expect(backupPath).toBeTruthy();
    const verified = run(fixture, ["backup", "verify", backupPath!]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("完整备份校验通过");

    const outputSecret = "sk-ticket11-output-secret";
    fixture.env.MAZE_API_KEY = outputSecret;
    const restoreTarget = `${fixture.root}-${outputSecret}-isolated-restore`;
    const restored = run(fixture, ["backup", "restore", backupPath!, "--target", restoreTarget]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("已恢复到隔离目录");
    expect(restored.stdout).not.toContain(outputSecret);
    expect(restored.stdout).toContain("[REDACTED]");
    expect(existsSync(join(restoreTarget, "maze-arena.sqlite"))).toBe(true);
    const restoredLineage = new PluginLineageRepository(join(restoreTarget, "lineages"), join(restoreTarget, "maze-arena.sqlite"));
    expect(restoredLineage.verifyAllIntegrity().map(({ experimentId, role }) => `${experimentId}:${role}`).sort()).toEqual([
      "exp-cli-backup:generator",
      "exp-cli-backup:solver",
      "validated-draft:generator",
      "validated-draft:solver",
    ]);
    restoredLineage.close();

    const doctor = run(fixture, ["doctor"]);
    expect(doctor.status, doctor.stderr).toBe(0);
    expect(doctor.stdout).toContain("检查通过：最近完整备份");
    const singleSqlite = join(fixture.root, "single.sqlite");
    writeFileSync(singleSqlite, readFileSync(join(backupPath!, "maze-arena.sqlite")));
    const refused = run(fixture, ["backup", "restore", singleSqlite, "--target", `${fixture.root}-bad-restore`]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("备份目录");
    rmSync(restoreTarget, { recursive: true, force: true });
    delete fixture.env.MAZE_API_KEY;
  }, 30_000);

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
    expect(result.stderr).toContain("dsh --version 与 npm 包版本不一致：期望 0.1.2-rc.1");
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
      harnessVersion: "0.1.2-rc.1",
      credentialRefs: ["dsh-credential://VENDOR_A_API_KEY", "dsh-credential://VENDOR_B_API_KEY"],
      providers: [{ id: "vendor-a" }, { id: "vendor-b" }],
    });
    expect(statSync(dirname(catalogPath)).mode & 0o777).toBe(0o500);
    expect(statSync(catalogPath).mode & 0o777).toBe(0o400);
    const runtimeExportPath = join(dirname(catalogPath), "model-export.json");
    expect(statSync(runtimeExportPath).mode & 0o777).toBe(0o400);
    expect(JSON.parse(readFileSync(runtimeExportPath, "utf8")).runtimeProviders).toHaveLength(2);
    const exportPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
    const replacement = JSON.parse(readFileSync(exportPath, "utf8"));
    replacement["llm-pi-ai"].providers["vendor-a"].displayName = "Vendor A Updated";
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
    const exportPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
    executable(fixture.dsh, `
if [ "\${1:-}" = "--version" ]; then printf "0.1.2-rc.1\\n"; exit 0; fi
if [ "\${1:-}" = "--profile" ] && [ "\${2:-}" = "sdk" ] && [ "\${3:-}" = "--dump-default-config" ]; then
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
    expect(result.stderr).toContain("Harness 私有 runtime 载荷已漂移");
    expect(existsSync(join(fixture.root, "data/maze-arena/models/current"))).toBe(false);
  });

  it.each([
    ["release 权限变为 0700", (release: string) => chmodSync(release, 0o700)],
    ["catalog 权限变为 0600", (release: string) => chmodSync(join(release, "catalog.json"), 0o600)],
    ["runtime 导出权限变为 0600", (release: string) => chmodSync(join(release, "model-export.json"), 0o600)],
    ["Harness settings 权限变为 0600", (release: string) => chmodSync(join(release, "settings.yaml"), 0o600)],
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
    ["成本策略身份", (value: any) => { value["maze-arena-cost-policy"].id = "floating"; }, /模型导出失败/],
    ["成本倍率", (value: any) => { value["maze-arena-cost-policy"].multipliers["vendor-a/compact"] = 0; }, /模型导出失败/],
    ["模型结构", (value: any) => { value["llm-pi-ai"].providers["vendor-a"].models = []; }, /模型导出失败/],
    ["非法能力", (value: any) => { value["llm-pi-ai"].providers["vendor-a"].models[0].contextWindow = 0; }, /模型导出失败/],
    ["非法凭据引用", (value: any) => { value["llm-pi-ai"].providers["vendor-a"].apiKeyEnv = "vendor-a"; }, /模型导出失败/],
  ])("models sync 拒绝%s并保留旧目录", (_label, mutate, expected) => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    expect(syncModels(fixture).status).toBe(0);
    const catalogPath = join(fixture.root, "data/maze-arena/models/current/catalog.json");
    const before = readFileSync(catalogPath, "utf8");
    const exportPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
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
if [ "\${1:-}" = "--version" ]; then printf "0.1.2-rc.1\\n"; exit 0; fi
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
    const exportPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
    const invalid = JSON.parse(readFileSync(exportPath, "utf8"));
    invalid["llm-pi-ai"].providers["vendor-a"].displayName = `Vendor ${secret}`;
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
    const exportPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
    const invalid = JSON.parse(readFileSync(exportPath, "utf8"));
    invalid["llm-pi-ai"].providers["vendor-a"].apiKey = "secret-capability";
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
    const environmentPath = join(configRoot, "env");
    expect(statSync(environmentPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(environmentPath, "utf8")).toContain("NAME=value");
    const text = readFileSync(manifestPath, "utf8");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(text).not.toMatch(/api.?key|secret|credential/i);
    const manifest = JSON.parse(text);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      harness: {
        packageName: "@deepseek-ai/dsh",
        packageVersion: dshVersion,
        executable: {
          payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          version: dshVersion,
          sha256: createHash("sha256").update(readFileSync(fixture.dsh)).digest("hex"),
        },
      },
      isolation: { bubblewrap: { path: "/usr/bin/bwrap", version: expect.stringMatching(/^bubblewrap \d+\.\d+\.\d+$/) } },
    });
    expect(manifest.harness.executable.runtimeRoot)
      .toBe(join(dataRoot, "harness-runtimes", manifest.harness.executable.payloadSha256));
    expect(manifest.harness.executable.path)
      .toBe(join(manifest.harness.executable.runtimeRoot, "node_modules/@deepseek-ai/dsh/lib/bin.js"));
    expect(statSync(join(manifest.harness.executable.runtimeRoot, "maze-arena/credential-environment-policy.js")).mode & 0o777)
      .toBe(0o400);
    expect(realpathSync(join(manifest.harness.executable.runtimeRoot, "node_modules/.bin/pnpm")))
      .toBe(join(manifest.harness.executable.runtimeRoot, "node_modules/pnpm/bin/pnpm.cjs"));
    expect(readFileSync(join(fixture.root, "npm-install-args"), "utf8")).toContain("pnpm@10.15.0");
    expect(resolve(dataRoot).startsWith(resolve(packageRoot))).toBe(false);
    writeFileSync(environmentPath, "VENDOR_A_API_KEY=preserved-value\n", { mode: 0o600 });
    expect(install(fixture).status).toBe(0);
    expect(readFileSync(environmentPath, "utf8")).toBe("VENDOR_A_API_KEY=preserved-value\n");
  });

  it("start 从用户 env 加载已登记凭据且显式进程环境优先，全链路不持久化秘密", () => {
    const fixture = prepareBuiltImageFixture();
    const environmentPath = join(fixture.root, "config/maze-arena/env");
    const fileSecret = "opaque-file-secret-a91f";
    const shadowedSecret = "opaque-shadowed-secret-b82e";
    const processSecret = "opaque-process-secret-c73d";
    writeFileSync(environmentPath, [
      "# 自定义 provider 凭据",
      `VENDOR_A_API_KEY=${fileSecret}`,
      `VENDOR_B_API_KEY=${shadowedSecret}`,
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(environmentPath, 0o600);
    fixture.env.VENDOR_B_API_KEY = processSecret;
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
      const result = run(fixture, ["start"]);
      expect(result.status, result.stderr).toBe(0);
      const statePath = join(fixture.root, "state/maze-arena/run/server.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      const environ = readFileSync(`/proc/${state.pid}/environ`, "utf8").split("\0");
      expect(environ).toContain(`VENDOR_A_API_KEY=${fileSecret}`);
      expect(environ).toContain(`VENDOR_B_API_KEY=${processSecret}`);
      expect(environ).not.toContain(`VENDOR_B_API_KEY=${shadowedSecret}`);
      const persisted = [
        result.stdout,
        result.stderr,
        readFileSync(statePath, "utf8"),
        readFileSync(state.logPath, "utf8"),
        readFileSync(`/proc/${state.pid}/cmdline`, "utf8"),
      ].join("\n");
      for (const secret of [fileSecret, shadowedSecret, processSecret]) expect(persisted).not.toContain(secret);
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it("CUSTOM_CRED 只按冻结目录登记也能净化日志且不进入状态、数据库、Git 或备份", async () => {
    const fixture = prepareBuiltImageFixture();
    const settingsPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings["llm-pi-ai"].providers["vendor-a"].apiKeyEnv = "CUSTOM_CRED";
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const synced = syncModels(fixture);
    expect(synced.status, synced.stderr).toBe(0);

    const secret = "s3cr3t";
    const environmentPath = join(fixture.root, "config/maze-arena/env");
    writeFileSync(environmentPath, `CUSTOM_CRED=${secret}\n`, { mode: 0o600 });
    fixture.env.MAZE_ARENA_PORT = "0";
    let state: { pid: number; port: number; logPath: string; databasePath: string } | undefined;
    let startResult: ReturnType<typeof run> | undefined;
    try {
      startResult = run(fixture, ["start"]);
      expect(startResult.status, startResult.stderr).toBe(0);
      const statePath = join(fixture.root, "state/maze-arena/run/server.json");
      const runningState = JSON.parse(readFileSync(statePath, "utf8")) as NonNullable<typeof state>;
      state = runningState;
      const request = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${runningState.port}/api/health?note=${secret}")
        .then(response => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1));`]);
      expect(request.status).toBe(0);
      expect(readFileSync(`/proc/${runningState.pid}/cmdline`, "utf8")).not.toContain(secret);
      expect(readFileSync(statePath, "utf8")).not.toContain(secret);
    } finally {
      cleanupFixtureServer(fixture);
    }

    expect(state).toBeDefined();
    const log = readFileSync(state!.logPath, "utf8");
    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain(secret);
    const lineage = new PluginLineageRepository(
      join(fixture.root, "data/maze-arena/lineages"),
      state!.databasePath,
    );
    try {
      await lineage.initialize("custom-credential-scan", "generator", join(repositoryRoot, "packages/generator-plugin"));
      await lineage.initialize("custom-credential-scan", "solver", join(repositoryRoot, "packages/solver-plugin"));
    } finally { lineage.close(); }
    executable(join(fixture.bin, "git"), `exec "${realGit}" "$@"`);
    const backup = run(fixture, ["backup", "create"]);
    expect(backup.status, backup.stderr).toBe(0);
    const persisted = [
      startResult?.stdout ?? "",
      startResult?.stderr ?? "",
      backup.stdout,
      backup.stderr,
      ...readdirSync(join(fixture.root, "data/maze-arena"), { recursive: true })
        .map((entry) => join(fixture.root, "data/maze-arena", String(entry)))
        .filter((path) => existsSync(path) && statSync(path).isFile())
        .map((path) => readFileSync(path)),
      ...readdirSync(join(fixture.root, "state/maze-arena"), { recursive: true })
        .map((entry) => join(fixture.root, "state/maze-arena", String(entry)))
        .filter((path) => existsSync(path) && statSync(path).isFile())
        .map((path) => readFileSync(path)),
    ];
    for (const value of persisted) expect(Buffer.from(value).includes(Buffer.from(secret))).toBe(false);
  }, 30_000);

  it("env 文件中的 NODE_OPTIONS 无法在 flock 二次 Node 启动前注入代码", () => {
    const fixture = prepareBuiltImageFixture();
    const environmentPath = join(fixture.root, "config/maze-arena/env");
    const attackModule = join(fixture.root, "node-options-attack.cjs");
    const marker = join(fixture.root, "node-options-executed");
    writeFileSync(attackModule, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed")\n`);
    writeFileSync(environmentPath, `NODE_OPTIONS=--require=${attackModule}\n`, { mode: 0o600 });

    const result = run(fixture, ["start"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("禁止把进程或运行控制变量登记为凭据");
    expect(existsSync(marker)).toBe(false);
  });

  it("start 拒绝冻结模型目录未登记的 env 名称", () => {
    const fixture = prepareBuiltImageFixture();
    const environmentPath = join(fixture.root, "config/maze-arena/env");
    writeFileSync(environmentPath, "CUSTOM_CRED=opaque-unregistered-value\n", { mode: 0o600 });

    const result = run(fixture, ["start"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("冻结模型目录未登记的名称：CUSTOM_CRED");
    expect(result.stderr).not.toContain("opaque-unregistered-value");
  });

  it.each([
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD",
    "BASH_ENV", "ENV", "PATH", "HOME", "ARENA_ATTACK", "DSH_ATTACK", "OPENSSL_MODULES",
    "UV_THREADPOOL_SIZE", "NPM_TOKEN", "YARN_ENABLE_SCRIPTS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  ])(
    "models sync 拒绝把运行控制名 %s 登记成凭据",
    (name) => {
      const fixture = createFixture();
      expect(install(fixture).status).toBe(0);
      const settingsPath = join(fixture.root, "data/maze-arena/harness/settings.yaml");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settings["llm-pi-ai"].providers["vendor-a"].apiKeyEnv = name;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

      const result = syncModels(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Harness 模型导出失败");
      expect(existsSync(join(fixture.root, "data/maze-arena/models/current"))).toBe(false);
    },
  );

  it.each([
    "OPENSSL_MODULES", "UV_THREADPOOL_SIZE", "NPM_TOKEN", "YARN_ENABLE_SCRIPTS", "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
  ])("start 防御性拒绝内容与摘要均自洽但登记 %s 的恶意冻结目录", (name) => {
    const fixture = prepareBuiltImageFixture();
    replaceFrozenCredentialReference(fixture, name);
    writeFileSync(join(fixture.root, "config/maze-arena/env"), `${name}=opaque-forged-value\n`, { mode: 0o600 });

    const result = run(fixture, ["start"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/credentialRefs 无效|凭据环境变量名|运行控制变量/);
    expect(existsSync(join(fixture.root, "state/maze-arena/run/server.json"))).toBe(false);
  });

  it.each([
    ["宽松权限", (path: string) => chmodSync(path, 0o640), "权限必须为 0600"],
    ["符号链接", (path: string) => {
      const target = `${path}.target`;
      writeFileSync(target, "VENDOR_A_API_KEY=hidden\n", { mode: 0o600 });
      rmSync(path);
      symlinkSync(target, path);
    }, "不得为符号链接"],
    ["export 语法", (path: string) => writeFileSync(path, "export VENDOR_A_API_KEY=opaque-invalid-export\n", { mode: 0o600 }), "第 1 行格式无效"],
    ["命令替换", (path: string) => writeFileSync(path, "VENDOR_A_API_KEY=$(opaque-invalid-command)\n", { mode: 0o600 }), "第 1 行格式无效"],
    ["重复名称", (path: string) => writeFileSync(path, "VENDOR_A_API_KEY=first\nVENDOR_A_API_KEY=opaque-invalid-duplicate\n", { mode: 0o600 }), "第 2 行格式无效"],
  ] as const)("start 拒绝凭据 env 的%s且错误不回显值", (_name, mutate, expected) => {
    const fixture = prepareBuiltImageFixture();
    const configRoot = join(fixture.root, "config/maze-arena");
    const environmentPath = join(configRoot, "env");
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    writeFileSync(environmentPath, "VENDOR_A_API_KEY=baseline\n", { mode: 0o600 });
    mutate(environmentPath);

    const result = run(fixture, ["start"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain("opaque-invalid");
  });

  it("start 拒绝不属于当前用户的凭据 env", () => {
    const fixture = prepareBuiltImageFixture();
    const configRoot = join(fixture.root, "config/maze-arena");
    const environmentPath = join(configRoot, "env");
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    writeFileSync(environmentPath, "VENDOR_A_API_KEY=opaque-owner-secret\n", { mode: 0o600 });
    const prelude = readFileSync(fixture.nodePrelude, "utf8");
    writeFileSync(fixture.nodePrelude, `${prelude}\nconst actualUid=process.getuid();Object.defineProperty(process,"getuid",{value:()=>actualUid+1});\n`);

    const result = run(fixture, ["start"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("必须由当前用户拥有");
    expect(result.stderr).not.toContain("opaque-owner-secret");
  });

  it("canary 自动加载用户 env，并在缺失或空凭据时于联网前关闭失败", () => {
    const fixture = prepareBuiltImageFixture();
    const configRoot = join(fixture.root, "config/maze-arena");
    const environmentPath = join(configRoot, "env");
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    const args = [
      "canary", "run", "--name", "env preflight", "--provider", "vendor-a", "--model", "compact",
      "--credential-ref", "dsh-credential://VENDOR_A_API_KEY", "--context-tokens", "2000", "--output-tokens", "500",
      "--token-limit", "5000", "--cost-limit", "0.5",
    ];
    writeFileSync(environmentPath, "VENDOR_A_API_KEY=\n", { mode: 0o600 });
    let result = run(fixture, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VENDOR_A_API_KEY 未配置");
    writeFileSync(environmentPath, "VENDOR_A_API_KEY=opaque-canary-secret\n", { mode: 0o600 });
    result = run(fixture, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("已经由正式 start 启动且健康");
    expect(`${result.stdout}${result.stderr}`).not.toContain("opaque-canary-secret");
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
  process.stdout.write("0.1.2-rc.1\\n");
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
    expect(result.stdout).toContain("检查通过：Harness Unix socket 外部连接已隔离且 TCP 回环可用");
    expect(result.stdout).toContain("检查通过：DeepSeek Harness 身份未漂移");
    expect(result.stdout).toContain(`检查通过：Match Profile 镜像 ${imageId}`);
  });

  it.each([
    "generation_role_provider_attempt_receipts",
    "generation_role_provider_usage_batches",
  ])("doctor 拒绝正式数据库中的未发布 Repair66 中间表：%s", (table) => {
    const fixture = prepareBuiltImageFixture();
    const databasePath = join(fixture.root, "data/maze-arena/maze-arena.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE ${table} (marker TEXT)`);
    database.close();

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("未发布的 Repair66 Provider usage 中间表");
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
    expect(readFileSync(join(fixture.root, "data/maze-arena/harness/frozen-pnpm-executable"), "utf8").trim())
      .toBe(join(firstState.harnessRuntimeRoot, "node_modules/.bin/pnpm"));

    result = run(fixture, ["start"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("已在运行");

    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：运行中");
    expect(result.stdout).toContain("HTTP：健康");
    expect(result.stdout).toContain(`数据库：${join(fixture.root, "data/maze-arena/maze-arena.sqlite")}`);
    expect(result.stdout).toContain("Harness：@deepseek-ai/dsh@0.1.2-rc.1");
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
    expect(result.stdout).toContain("Harness：@deepseek-ai/dsh@0.1.2-rc.1");
    expect(result.stdout).toContain("模型目录版本：");
    expect(result.stdout).toContain(`镜像摘要：${imageId}`);

    writeFileSync(processStatePath, `${JSON.stringify({ ...firstState, pid: 999_999, procStartTime: "stale" })}\n`, { mode: 0o600 });
    result = run(fixture, ["status"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("进程：已停止");
    expect(result.stdout).toContain(`数据库：${join(fixture.root, "data/maze-arena/maze-arena.sqlite")}`);
    expect(result.stdout).toContain("Harness：@deepseek-ai/dsh@0.1.2-rc.1");
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
      expect(state.modelReleaseRoot).not.toBe(dirname(realpathSync(join(fixture.root, "data/maze-arena/models/current/catalog.json"))));
      expect(readFileSync(state.harnessExecutablePath, "utf8")).toBe(frozenCommand);
      expect(existsSync(join(state.harnessRuntimeRoot, "late-live-dependency.js"))).toBe(false);
      expect(hashHarnessRuntimePayload(state.harnessRuntimeRoot)).toBe(state.harnessRuntimePayloadSha256);
      const originalSettings = join(fixture.root, "data/maze-arena/models/current/settings.yaml");
      chmodSync(originalSettings, 0o600);
      writeFileSync(originalSettings, "{}\n");
      const status = run(fixture, ["status"]);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("HTTP：健康");
    } finally {
      cleanupFixtureServer(fixture);
    }
  }, 30_000);

  it.each([
    ["catalog 内容", (state: any) => {
      chmodSync(state.modelReleaseRoot, 0o700);
      chmodSync(state.modelCatalogPath, 0o600);
      writeFileSync(state.modelCatalogPath, "{}\n");
    }],
    ["export 权限", (state: any) => chmodSync(state.modelExportPath, 0o600)],
    ["settings 内容", (state: any) => {
      chmodSync(state.modelReleaseRoot, 0o700);
      chmodSync(state.modelSettingsPath, 0o600);
      writeFileSync(state.modelSettingsPath, "{}\n");
    }],
  ] as const)("实例模型发布 %s 漂移时 status 关闭失败", (_label, mutate) => {
    const fixture = prepareBuiltImageFixture();
    fixture.env.MAZE_ARENA_PORT = "0";
    try {
      expect(run(fixture, ["start"]).status).toBe(0);
      const state = JSON.parse(readFileSync(join(fixture.root, "state/maze-arena/run/server.json"), "utf8"));
      mutate(state);
      const result = run(fixture, ["status"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/模型发布.*漂移/);
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
    const fixture = prepareBuiltImageFixture();
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
    restoreDirectoryModes(manifest.harness.executable.runtimeRoot, state.harnessRuntimeRoot);
    const modelRelease = realpathSync(join(fixture.root, "data/maze-arena/models/current"));
    cpSync(modelRelease, state.modelReleaseRoot, { recursive: true, verbatimSymlinks: true });
    restoreDirectoryModes(modelRelease, state.modelReleaseRoot);

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

  it("从冻结 npm Harness runtime 与当前构建产物构建镜像并保存 Docker 实际摘要", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);

    const result = buildImage(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`正式不可变镜像引用：${imageId}`);
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toMatchObject({
      imageId,
      imageReference: imageId,
      harnessPackage: "@deepseek-ai/dsh",
      harnessPackageVersion: dshVersion,
      harnessRuntimePayloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
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

  it("镜像构建只复用冻结 runtime，不再次调用 npm 或 Harness 源码构建", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const npmBefore = readFileSync(join(fixture.root, "npm-install-args"), "utf8");

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "npm-install-args"), "utf8")).toBe(npmBefore);
    expect(readFileSync(join(fixture.root, "pnpm-invocations"), "utf8")).not.toContain("scripts/release/pack.ts");
  });

  it("Generator 源码已变化且 dist 陈旧时仍在哈希和复制前显式重建全部镜像包", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
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
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
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
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
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

  it("npm 返回的实际包版本不符时拒绝发布安装清单", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, "npm-wrong-version"), "1\n");

    const result = install(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm 安装的 DSH 包版本漂移");
    expect(existsSync(join(fixture.root, "config/maze-arena/install-manifest.json"))).toBe(false);
  });

  it("镜像内最小 Match Profile 无法完成 ready 握手时拒绝记录摘要", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.handshake-fail"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 异常退出");
    expect(result.stderr).not.toContain("profile load failed");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it("镜像内 Solver Match Profile 无法完成 ready 握手时拒绝记录摘要", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.solver-handshake-fail"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("solver Match Profile smoke 异常退出");
    expect(result.stderr).not.toContain("solver profile load failed");
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\n");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it("镜像 smoke 在 ready 后发生 HMR 式异常退出时拒绝记录摘要", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.post-ready-fail"), "1\n");

    const result = buildImage(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 异常退出");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it("镜像 smoke 完成响应后对长驻 DSH 发起受控 SIGTERM 关闭", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\nsolver\n");
  });

  it("镜像 smoke 接受真实 launcher 与官方 DSH 优雅关闭的 exit 0", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.smoke-exit-zero"), "1\n");

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\nsolver\n");
  });

  it("镜像 smoke 接受响应后容器自然 exit 0 且 SIGTERM 竞态返回容器不存在", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.natural-smoke-exit-zero"), "1\n");

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\nsolver\n");
  });

  it("镜像 smoke 接受响应后容器已退出且 SIGTERM 竞态返回未运行", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.kill-not-running"), "1\n");

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "docker-state.handshake-roles"), "utf8")).toBe("generator\nsolver\n");
  });

  it("镜像 smoke 拒绝未能发送到容器的 SIGTERM", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.kill-fail"), "1\n");

    const result = buildImage(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 无法向容器发送 SIGTERM");
  });

  it("镜像 smoke 长驻 DSH 忽略 SIGTERM 时强制结束并清理容器", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.ignore-smoke-sigterm"), "1\n");

    const result = buildImage(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 受控关闭超时");
    expect(readFileSync(join(fixture.root, "docker-state.cleanup-calls"), "utf8")).toBe("kill\nrm\ninspect\ninspect\n");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  }, 30_000);

  it("镜像 smoke 对 rm -f 权限故障关闭失败", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.rm-fail"), "1\n");

    const result = buildImage(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 容器强制清理失败");
  });

  it("镜像 smoke 不把 inspect daemon 故障当作容器不存在", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.inspect-daemon-fail"), "1\n");

    const result = buildImage(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generator Match Profile smoke 容器清理未确认");
  });

  it("镜像 smoke 容器短暂消失后重现时再次删除并双重确认", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.inspect-reappear"), "1\n");

    const result = buildImage(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.root, "docker-state.cleanup-calls"), "utf8")).toContain(
      "kill\nrm\ninspect\ninspect\nrm\ninspect\ninspect\n",
    );
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
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
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
    manifest.matchProfile.harnessPackageVersion = "0.1.2-rc.2";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    let result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("构建身份与当前安装清单不一致");

    manifest.matchProfile.harnessPackageVersion = manifest.harness.packageVersion;
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

  it("doctor 对冻结 npm 包、入口和完整 runtime 漂移均关闭失败", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packagePath = join(manifest.harness.executable.runtimeRoot, "node_modules/@deepseek-ai/dsh/package.json");
    const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"));
    packageManifest.version = "0.1.2-rc.2";
    writeFileSync(packagePath, `${JSON.stringify(packageManifest)}\n`);
    const result = run(fixture, ["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/npm 包身份|runtime 载荷/);
  });

  it("doctor 对冻结 pnpm 精确版本漂移关闭失败", () => {
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packagePath = join(manifest.harness.executable.runtimeRoot, "node_modules/pnpm/package.json");
    const packageManifest = JSON.parse(readFileSync(packagePath, "utf8"));
    packageManifest.version = "10.15.1";
    writeFileSync(packagePath, `${JSON.stringify(packageManifest)}\n`);

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("冻结 pnpm 包身份不一致，要求 pnpm@10.15.0");
  });

  it("doctor 拒绝把 Arena 私有目录之外的路径冒充冻结 runtime", () => {
    const fixture = prepareBuiltImageFixture();
    const manifestPath = join(fixture.root, "config/maze-arena/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.harness.executable.runtimeRoot)
      .toBe(join(fixture.root, "data/maze-arena/harness-runtimes", manifest.harness.executable.payloadSha256));
    manifest.harness.executable.runtimeRoot = fixture.bin;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DSH npm package.json|Harness 私有 runtime/);
  });

  it("doctor 拒绝安装后漂移的 Harness 运行依赖载荷", () => {
    const fixture = prepareBuiltImageFixture();
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    writeFileSync(join(manifest.harness.executable.runtimeRoot, "late-runtime-dependency.js"), "export const changed = true;\n");

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Harness 私有 runtime 载荷已漂移/);
  });

  it.each([
    ["权限漂移", (release: string) => chmodSync(join(release, "settings.yaml"), 0o600)],
    ["内容漂移", (release: string) => {
      const path = join(release, "settings.yaml");
      chmodSync(path, 0o600);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      chmodSync(path, 0o400);
    }],
    ["符号链接替换", (release: string) => {
      const path = join(release, "settings.yaml");
      const replacement = join(dirname(dirname(release)), "external-settings.yaml");
      writeFileSync(replacement, readFileSync(path, "utf8"), { mode: 0o400 });
      chmodSync(release, 0o700);
      rmSync(path);
      symlinkSync(replacement, path, "file");
      chmodSync(release, 0o500);
    }],
  ] as const)("doctor 对不可变 Harness settings 的%s关闭失败", (_label, mutate) => {
    const fixture = prepareBuiltImageFixture();
    const release = realpathSync(join(fixture.root, "data/maze-arena/models/current"));
    mutate(release);

    const result = run(fixture, ["doctor"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Harness 模型目录无效");
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
      }, ["install", "--dsh-version", dshVersion]);

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
    }, ["install", "--dsh-version", dshVersion]);

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
      }, ["install", "--dsh-version", dshVersion]);

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
    }, ["install", "--dsh-version", dshVersion]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("数据目录不得位于 Maze Arena 源码仓库内");
    expect(existsSync(forbiddenRoot)).toBe(false);
  });

  it.each(["latest", "next", "^0.1.2", "~0.1.2", ">=0.1.2", "file:../dsh", "git+https://example.invalid/dsh.git", "https://example.invalid/dsh.tgz"])(
    "install 拒绝非精确 npm 版本 %s，且不调用 npm",
    (version) => {
    const fixture = createFixture();
    const result = installVersion(fixture, version);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("必须是精确 SemVer");
    expect(existsSync(join(fixture.root, "npm-install-args"))).toBe(false);
    expect(existsSync(join(fixture.root, "config/maze-arena/install-manifest.json"))).toBe(false);
  });

  it("npm 安装失败时不发布清单并清理暂存目录", () => {
    const fixture = createFixture({ npm: 'printf "install failed\\n" >&2; exit 9' });
    const result = install(fixture);
    expect(result.status).toBe(1);
    expect(existsSync(join(fixture.root, "config/maze-arena/install-manifest.json"))).toBe(false);
    expect(readdirSync(join(fixture.root, "state/maze-arena")).some((name) => name.startsWith(".harness-npm-install-"))).toBe(false);
  });
});
