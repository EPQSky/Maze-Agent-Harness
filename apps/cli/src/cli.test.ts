import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const modelExport = join(root, "model-export.json");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(harness);
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
case "\${1:-}" in
  --version) printf "Docker version 27.1.0, build fixture\\n" ;;
  info)
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
  executable(dsh, overrides.dsh ?? `
if [ "\${1:-}" = "--version" ]; then printf "dsh 2026.09.1\\n"; exit 0; fi
if [ "\${1:-}" = "models" ] && [ "\${2:-}" = "export" ]; then
  printf '%s\\n' "\${DSH_HOME:-}" > "${join(root, "model-export-home")}";
  while IFS= read -r line; do printf '%s\\n' "$line"; done < "${modelExport}";
  exit 0
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

function prepareBuiltImageFixture(): Fixture {
  const initialized = initializeRuntimeHarnessRepository(createFixture());
  const { fixture, commit } = initialized;
  expect(installAtCommit(fixture, commit).status).toBe(0);
  const result = buildImage(fixture);
  expect(result.status, result.stderr).toBe(0);
  return fixture;
}

describe("正式运行 CLI 黑盒边界", () => {
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
    expect(readFileSync(join(fixture.root, "model-export-home"), "utf8").trim())
      .toBe(join(fixture.root, "data/maze-arena/harness"));

    const exportPath = join(fixture.root, "model-export.json");
    const replacement = JSON.parse(readFileSync(exportPath, "utf8"));
    replacement.providers[0].label = "Vendor A Updated";
    writeFileSync(exportPath, `${JSON.stringify(replacement)}\n`);
    expect(syncModels(fixture).status).toBe(0);
    expect(JSON.parse(readFileSync(catalogPath, "utf8")).providers[0].label).toBe("Vendor A Updated");
    expect(readdirSync(join(fixture.root, "data/maze-arena/models/releases"))).toHaveLength(2);
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
    const exportPath = join(fixture.root, "model-export.json");
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
    const exportPath = join(fixture.root, "model-export.json");
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
    const exportPath = join(fixture.root, "model-export.json");
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
    for (const path of [configRoot, dataRoot, stateRoot, join(dataRoot, "harness"), join(dataRoot, "lineages"), join(dataRoot, "backups"), join(stateRoot, "logs")]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }

    const manifestPath = join(configRoot, "install-manifest.json");
    const text = readFileSync(manifestPath, "utf8");
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(text).not.toMatch(/api.?key|secret|credential/i);
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      harness: {
        sourceDirectory: fixture.harness,
        commit: harnessCommit,
        executable: {
          path: fixture.dsh,
          version: "dsh 2026.09.1",
          sha256: createHash("sha256").update(readFileSync(fixture.dsh)).digest("hex"),
        },
      },
    });
    expect(resolve(dataRoot).startsWith(resolve(packageRoot))).toBe(false);
    expect(install(fixture).status).toBe(0);
  });

  it("doctor 对受支持工具与锁定 Harness 身份返回成功", () => {
    const fixture = prepareBuiltImageFixture();

    const result = run(fixture, ["doctor"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("检查通过：Node.js v22.12.0");
    expect(result.stdout).toContain("检查通过：Docker daemon 27.1.0");
    expect(result.stdout).toContain("检查通过：DeepSeek Harness 身份未漂移");
    expect(result.stdout).toContain(`检查通过：Match Profile 镜像 ${imageId}`);
  });

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
    expect(result.stderr).toContain("profile load failed");
    const manifest = JSON.parse(readFileSync(join(fixture.root, "config/maze-arena/install-manifest.json"), "utf8"));
    expect(manifest.matchProfile).toBeUndefined();
  });

  it("镜像内 Solver Match Profile 无法完成 ready 握手时拒绝记录摘要", () => {
    const { fixture, commit } = initializeRuntimeHarnessRepository(createFixture());
    expect(installAtCommit(fixture, commit).status).toBe(0);
    writeFileSync(join(fixture.root, "docker-state.solver-handshake-fail"), "1\n");

    const result = buildImage(fixture);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("solver profile load failed");
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
    expect(result.stderr).toContain("dsh 版本漂移");
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
