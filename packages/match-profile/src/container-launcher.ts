import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const source = resolve(process.env.MAZE_MATCH_PROFILE_SOURCE ?? "");
const target = resolve(process.env.DSH_HOME ?? "");
const role = process.env.MAZE_MATCH_ROLE;
const command = process.argv.slice(2);

if (!process.env.MAZE_MATCH_PROFILE_SOURCE || !process.env.DSH_HOME || source === target) {
  throw new Error("Match Profile 可信源或临时 DSH_HOME 配置无效");
}
if (role !== "generator" && role !== "solver") throw new Error("Match Profile 角色配置缺失");
if (command.length !== 3 || command[0] !== "dsh" || command[1] !== "--profile"
  || command[2] !== `maze-match-${role}`) {
  throw new Error("Match Profile 启动命令不符合冻结协议");
}

function rejectLinks(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Match Profile 可信快照禁止符号链接：${path}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) rejectLinks(join(path, entry));
}

rejectLinks(source);
mkdirSync(target, { recursive: true, mode: 0o700 });
if (readdirSync(target).length !== 0) throw new Error("临时 DSH_HOME 必须为空");
for (const entry of readdirSync(source)) {
  cpSync(join(source, entry), join(target, entry), { recursive: true, verbatimSymlinks: true });
}

function makeRuntimeCopyWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeRuntimeCopyWritable(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

for (const entry of readdirSync(target)) makeRuntimeCopyWritable(join(target, entry));

const child = spawn(command[0], command.slice(1), { env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
