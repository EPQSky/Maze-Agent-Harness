import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  git(fixture.harness, ["add", "README.md", ".gitignore"]);
  git(fixture.harness, ["commit", "--quiet", "-m", "fixture"]);
  return git(fixture.harness, ["rev-parse", "HEAD"]);
}

function createFixture(overrides: Partial<Record<"node" | "pnpm" | "git" | "docker" | "dsh", string>> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "maze-cli-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const harness = join(root, "deepseek-harness");
  const nodePrelude = join(root, "node-version.cjs");
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(harness);
  writeFileSync(nodePrelude, 'Object.defineProperty(process, "version", { value: "v22.12.0" });\n');

  executable(join(bin, "node"), overrides.node ?? 'printf "v22.12.0\\n"');
  executable(join(bin, "pnpm"), overrides.pnpm ?? 'printf "10.15.0\\n"');
  executable(join(bin, "git"), overrides.git ?? `if [ "\${1:-}" = "--version" ]; then printf "git version 2.45.0\\n"; elif [ "\${3:-}" = "status" ]; then :; else printf "${harnessCommit}\\n"; fi`);
  executable(join(bin, "docker"), overrides.docker ?? 'if [ "${1:-}" = "--version" ]; then printf "Docker version 27.1.0, build fixture\\n"; else printf "27.1.0\\n"; fi');
  const dsh = join(bin, "dsh");
  executable(dsh, overrides.dsh ?? 'printf "dsh 2026.09.1\\n"');

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

describe("正式运行 CLI 黑盒边界", () => {
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
    const fixture = createFixture();
    expect(install(fixture).status).toBe(0);

    const result = run(fixture, ["doctor"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("检查通过：Node.js v22.12.0");
    expect(result.stdout).toContain("检查通过：Docker daemon 27.1.0");
    expect(result.stdout).toContain("检查通过：DeepSeek Harness 身份未漂移");
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
