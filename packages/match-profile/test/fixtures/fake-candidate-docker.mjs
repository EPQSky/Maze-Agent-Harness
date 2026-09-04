#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.MAZE_FAKE_DOCKER_LOG, `${JSON.stringify(args)}\n`);

const mode = process.env.MAZE_FAKE_DOCKER_MODE ?? "success";
if (args[0] === "run" && mode === "test-failure") {
  process.stderr.write("candidate test sentinel failure\n");
  process.exitCode = 9;
} else if (args[0] === "rm" && mode === "cleanup-failure") {
  process.stderr.write("docker daemon unavailable\n");
  process.exitCode = 1;
} else if (args[0] === "inspect") {
  process.stderr.write(`Error: No such object: ${args[1]}\n`);
  process.exitCode = 1;
}
