#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
appendFileSync(process.env.MAZE_FAKE_DOCKER_LOG, `${JSON.stringify(args)}\n`);

if (args[0] === "inspect") {
  process.stderr.write(`Error: No such object: ${args[1]}\n`);
  process.exitCode = 1;
} else if (args[0] === "rm") {
  process.exitCode = 0;
} else if (args[0] === "run") {
  const mount = args.find((value) => value.startsWith("--mount=type=bind,"));
  const home = mount?.match(/(?:^|,)src=([^,]+)/)?.[1];
  const role = args.find((value) => value.startsWith("--env=MAZE_MATCH_ROLE="))?.split("=").at(-1);
  if (!home || !role || !process.env.MAZE_FAKE_DSH) throw new Error("假 Docker 缺少 Profile 输入");
  const child = spawn(process.execPath, [process.env.MAZE_FAKE_DSH, "--profile", `maze-match-${role}`], {
    env: { ...process.env, DSH_HOME: home, MAZE_MATCH_ROLE: role },
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} else {
  throw new Error(`不支持的假 Docker 参数：${args.join(" ")}`);
}
