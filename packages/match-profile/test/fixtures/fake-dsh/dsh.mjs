#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const home = resolve(process.env.DSH_HOME ?? ".");
if (args[0] === "--version") {
  process.stdout.write("2026.09-preview.1\n");
} else if (args[0] === "plugin") {
  if (process.env.DSH_INVOCATION_MARKER) writeFileSync(process.env.DSH_INVOCATION_MARKER, args.join(" "));
  const profile = args[args.indexOf("--profile") + 1];
  const actionIndex = args.findIndex((value) => value === "add" || value === "remove");
  const action = args[actionIndex];
  const values = args.slice(actionIndex + 1).filter((value) => !value.startsWith("--"));
  const path = join(home, "profiles", profile, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.dependencies ??= {};
  manifest.dsh.profile.bundles ??= [];
  if (action === "add") {
    const npmCli = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    const install = spawnSync(process.execPath, [npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--save-exact", ...values], {
      cwd: join(home, "profiles", profile), encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, npm_config_cache: join(home, ".npm-cache") },
    });
    if (install.status !== 0) throw new Error(`npm 离线安装失败：${install.stderr}`);
    const installed = JSON.parse(readFileSync(path, "utf8"));
    for (const spec of values) {
      const root = spec.startsWith("file:") ? spec.slice(5) : spec;
      const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (!packageManifest.dsh?.bundle?.patch) throw new Error(`${packageManifest.name} 不是 dsh.bundle`);
      manifest.dependencies[packageManifest.name] = installed.dependencies[packageManifest.name];
      if (!manifest.dsh.profile.bundles.includes(packageManifest.name)) manifest.dsh.profile.bundles.push(packageManifest.name);
    }
    if (process.env.DSH_TAMPER_INSTALLED_PATCH) {
      const name = Object.keys(installed.dependencies).at(-1);
      const installedRoot = join(home, "profiles", profile, "node_modules", ...name.split("/"));
      writeFileSync(join(installedRoot, "cordis.patch.yml"), "- insert: [{ id: extra, name: dangerous }]\n");
    }
  } else {
    const npmCli = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
    const uninstall = spawnSync(process.execPath, [npmCli, "uninstall", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...values], {
      cwd: join(home, "profiles", profile), encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, npm_config_cache: join(home, ".npm-cache") },
    });
    if (uninstall.status !== 0) throw new Error(`npm 离线卸载失败：${uninstall.stderr}`);
    for (const name of values) {
      delete manifest.dependencies[name];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((value) => value !== name);
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
} else if (args[0] === "--profile") {
  const profile = args[1];
  const manifest = JSON.parse(readFileSync(join(home, "profiles", profile, "package.json"), "utf8"));
  const entries = Object.keys(manifest.dependencies).map((name) => [name, join(home, "profiles", profile, "node_modules", ...name.split("/"))]);
  if (entries.length !== 2) throw new Error("受控 Profile 必须且只能包含两个 bundle");
  const context = {
    provide(name, capability) {
      if (Object.hasOwn(context, name)) throw new Error(`重复能力：${name}`);
      context[name] = capability;
      return () => { delete context[name]; };
    },
  };
  const disposers = [];
  const modules = await Promise.all(entries.map(async ([name, root]) => {
    const entry = name === "@maze-arena/match-profile" ? "dist/host.js" : "dist/index.js";
    return [name, await import(pathToFileURL(join(root, entry)).href)];
  }));
  const role = modules.find(([name]) => name !== "@maze-arena/match-profile")?.[1];
  const protocol = modules.find(([name]) => name === "@maze-arena/match-profile")?.[1];
  if (typeof role?.apply !== "function" || typeof protocol?.apply !== "function") throw new Error("bundle 未导出 apply(ctx)");
  disposers.push(await role.apply(context));
  disposers.push(await protocol.apply(context));
  process.stdin.once("end", () => {
    for (const dispose of disposers.reverse()) if (typeof dispose === "function") dispose();
    if (process.env.DSH_UNLOAD_MARKER) writeFileSync(process.env.DSH_UNLOAD_MARKER, JSON.stringify(Object.keys(context)));
  });
} else {
  throw new Error(`不支持的 dsh 参数：${args.join(" ")}`);
}
