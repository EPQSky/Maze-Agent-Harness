#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const home = resolve(process.env.DSH_HOME ?? ".");

async function exerciseIsolationAttacks() {
  for (const variable of ["DSH_ATTACK_EXTERNAL_PATH", "DSH_ATTACK_RUNTIME_PATH"]) {
    const path = process.env[variable];
    if (!path) continue;
    try { writeFileSync(path, variable); } catch { /* 受控执行必须拒绝越界或只读写入。 */ }
  }
  if (process.env.DSH_ATTACK_DAEMON_MARKER) {
    spawn(process.execPath, ["-e", `setTimeout(() => { try { require("node:fs").writeFileSync(process.argv[1], "escaped"); } catch {} }, 400); setInterval(() => {}, 1_000);`, process.env.DSH_ATTACK_DAEMON_MARKER, process.env.DSH_ATTACK_DAEMON_IDENTITY ?? ""], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  if (process.env.DSH_ATTACK_SOCKET_PATH) {
    await new Promise((resolveAttempt) => {
      const socket = createConnection(process.env.DSH_ATTACK_SOCKET_PATH);
      const finish = () => { socket.destroy(); resolveAttempt(); };
      socket.once("connect", finish);
      socket.once("error", finish);
      socket.setTimeout(200, finish);
    });
  }
}

await exerciseIsolationAttacks();

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
    const installedPackages = [];
    for (const spec of values) {
      const root = spec.startsWith("file:") ? spec.slice(5) : spec;
      const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (!packageManifest.dsh?.bundle?.patch) throw new Error(`${packageManifest.name} 不是 dsh.bundle`);
      const profileRoot = join(home, "profiles", profile);
      const storeKey = `${packageManifest.name.replace("/", "+")}@file+fixture`;
      const installedRoot = join(profileRoot, "node_modules/.pnpm", storeKey, "node_modules", ...packageManifest.name.split("/"));
      mkdirSync(dirname(installedRoot), { recursive: true });
      cpSync(root, installedRoot, { recursive: true });
      const topLevel = join(profileRoot, "node_modules", ...packageManifest.name.split("/"));
      mkdirSync(dirname(topLevel), { recursive: true });
      rmSync(topLevel, { recursive: true, force: true });
      symlinkSync(relative(dirname(topLevel), installedRoot), topLevel, "dir");
      manifest.dependencies[packageManifest.name] = `file:${root}`;
      if (!manifest.dsh.profile.bundles.includes(packageManifest.name)) manifest.dsh.profile.bundles.push(packageManifest.name);
      installedPackages.push({ name: packageManifest.name, root });
    }
    if (process.env.DSH_TAMPER_INSTALLED_PATCH) {
      const name = Object.keys(manifest.dependencies).at(-1);
      const installedRoot = join(home, "profiles", profile, "node_modules", ...name.split("/"));
      writeFileSync(join(installedRoot, "cordis.patch.yml"), "- insert: [{ id: extra, name: dangerous }]\n");
    }
    const manifestMode = process.env.DSH_PROFILE_MANIFEST_MODE;
    if (manifestMode === "reverse") {
      manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).reverse());
      manifest.dsh.profile.bundles.reverse();
    } else if (manifestMode === "dependency-extra") {
      manifest.dependencies["@maze-arena/extra"] = "file:/untrusted/extra";
    } else if (manifestMode === "dependency-missing") {
      const missing = Object.keys(manifest.dependencies)[0];
      delete manifest.dependencies[missing];
    } else if (manifestMode === "bundle-extra") {
      manifest.dsh.profile.bundles.push("@maze-arena/extra");
    } else if (manifestMode === "bundle-missing") {
      const missing = manifest.dsh.profile.bundles[0];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== missing);
    } else if (manifestMode === "bundle-duplicate") {
      manifest.dsh.profile.bundles.push(manifest.dsh.profile.bundles[0]);
    } else if (manifestMode === "package-source-mismatch") {
      manifest.dependencies[installedPackages[0].name] = "file:/untrusted/mismatch";
    } else if (manifestMode === "patch-reload-live") {
      manifest.dsh.profile.patchReload = "live";
    } else if (manifestMode === "patch-reload-missing") {
      delete manifest.dsh.profile.patchReload;
    }
    const profileRoot = join(home, "profiles", profile);
    const lockPackages = Object.fromEntries(installedPackages.map(({ name, root }) => {
      const reference = `file:${relative(profileRoot, root).split(sep).join("/")}`;
      return [`${name}@${reference}`, { resolution: { directory: reference.slice(5), type: "directory" } }];
    }));
    const lockDependencies = Object.fromEntries(installedPackages.map(({ name, root }) => {
      const relativeReference = `file:${relative(profileRoot, root).split(sep).join("/")}`;
      return [name, { specifier: `file:${root}`, version: relativeReference }];
    }));
    if (manifestMode === "lock-source-mismatch") {
      lockDependencies[installedPackages[0].name].specifier = "file:/untrusted/mismatch";
    }
    writeFileSync(join(profileRoot, "pnpm-lock.yaml"), `${JSON.stringify({
      lockfileVersion: "9.0",
      importers: { ".": { dependencies: lockDependencies } },
      packages: lockPackages,
      snapshots: Object.fromEntries(Object.keys(lockPackages).map((key) => [key, {}])),
    }, null, 2)}\n`);
    if (manifestMode === "installed-content-tamper") {
      const installed = join(profileRoot, "node_modules", ...installedPackages[0].name.split("/"), "package.json");
      writeFileSync(installed, `${readFileSync(installed, "utf8")} `);
    } else if (manifestMode === "virtual-store-escape") {
      const { name, root } = installedPackages[0];
      const topLevel = join(profileRoot, "node_modules", ...name.split("/"));
      rmSync(topLevel, { recursive: true, force: true });
      symlinkSync(root, topLevel, "dir");
    }
  } else {
    for (const name of values) {
      rmSync(join(home, "profiles", profile, "node_modules", ...name.split("/")), { recursive: true, force: true });
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
