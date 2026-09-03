import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "good";
if (mode === "exit") process.exit(17);
if (mode === "oom") process.kill(process.pid, "SIGKILL");
if (mode === "hold-open") setInterval(() => {}, 1_000);
if (mode !== "never-ready") {
  const delay = mode === "slow-ready" ? 150 : 0;
  const ready = `${JSON.stringify({ type: "match-profile.ready", protocolVersion: 1, role: process.env.MAZE_MATCH_ROLE ?? "solver" })}\n`;
  setTimeout(() => {
    process.stdout.write(ready);
    if (mode === "double-ready-initializing") setTimeout(() => process.stdout.write(ready), 10);
  }, delay);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "timeout") return;
  if (mode === "oversize") return process.stdout.write(`${"x".repeat(17_000)}\n`);
  const response = {
    protocolVersion: mode === "future-version" ? 2 : 1,
    requestId: mode === "wrong-id" ? "wrong" : request.requestId,
    sequence: request.sequence,
    role: request.role,
    payload: mode === "illegal-domain"
      ? { type: "solver.move", direction: "diagonal", kind: "teleport" }
      : request.role === "generator" ? { type: "generator.complete" } : { type: "solver.ready" },
  };
  if (mode === "pollution") return process.stdout.write(`not-json\n${JSON.stringify(response)}\n`);
  if (mode === "multiple") return process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(response)}\n`);
  if (mode === "delayed-extra") {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return setImmediate(() => process.stdout.write("late-pollution\n"));
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
