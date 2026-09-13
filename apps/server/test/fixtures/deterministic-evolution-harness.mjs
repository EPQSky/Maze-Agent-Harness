#!/usr/bin/env node
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

const expectedTools = ["read", "edit", "search", "shell", "test", "public-check", "submit"];
if (request.type !== "maze-arena.harness-evolution.request" || request.protocolVersion !== 1) process.exit(20);
if (request.session.id !== process.env.DSH_HARNESS_SESSION_ID) process.exit(21);
if (resolve(request.session.home) !== resolve(process.env.DSH_HOME ?? "")) process.exit(22);
if (resolve(request.session.workspace) !== process.cwd()) process.exit(23);
if (JSON.stringify(request.session.allowedTools) !== JSON.stringify(expectedTools)) process.exit(24);
if (process.env.DSH_HARNESS_TOOL_POLICY !== "locked"
  || process.env.DSH_HARNESS_ALLOWED_TOOLS !== expectedTools.join(",")) process.exit(28);
if (request.session.role !== request.input.role || request.session.workspace !== request.input.championRoot) process.exit(25);
if (request.attempt.repairAttempt === 0 && readdirSync(request.session.home).length !== 0) process.exit(26);
if (!request.session.roleConstraint.includes(request.session.role === "generator" ? "Generator Plugin" : "Solver Plugin")) process.exit(27);
if (process.env.DSH_GLOBAL_HOME) {
  try { appendFileSync(join(process.env.DSH_GLOBAL_HOME, "readonly.txt"), "modified"); process.exit(29); }
  catch { /* 全局 Harness home 必须由 bubblewrap 只读挂载。 */ }
}
try { appendFileSync("/etc/passwd", "modified"); process.exit(30); }
catch { /* 宿主根文件系统必须只读。 */ }
writeFileSync(join(request.session.home, "session-write.txt"), "allowed");

const sourcePath = join(request.session.workspace, "src/index.ts");
let source = readFileSync(sourcePath, "utf8");
if (request.session.role === "generator" && request.attempt.generation === 1) {
  source = source.replace("  const random = randomFor(seed);", `  {
    const challenge: Array<{ from: Coordinate; to: Coordinate }> = [];
    challenge.push({ from: { x: 0, y: 0 }, to: { x: 0, y: 1 } });
    for (let y = 1; y < size; y += 1) {
      if (y > 1) {
        const x = y % 2 === 0 ? size - 2 : 0;
        challenge.push({ from: { x, y: y - 1 }, to: { x, y } });
      }
      if (y % 2 === 1) {
        for (let x = 0; x < size - 2; x += 1) challenge.push({ from: { x, y }, to: { x: x + 1, y } });
      } else {
        for (let x = size - 2; x > 0; x -= 1) challenge.push({ from: { x, y }, to: { x: x - 1, y } });
      }
    }
    for (let x = 0; x < size - 1; x += 1) challenge.push({ from: { x, y: 0 }, to: { x: x + 1, y: 0 } });
    for (let y = 0; y < size - 1; y += 1) challenge.push({ from: { x: size - 1, y }, to: { x: size - 1, y: y + 1 } });
    return challenge;
  }
  const random = randomFor(seed);`);
}
if (request.session.role === "solver" && request.attempt.generation === 2) {
  source = source.replace(
    'if (direction) return { type: "solver.move", direction, kind: "move" };',
    'if (direction) return { type: "solver.move", direction: "north", kind: "move" };',
  );
}
writeFileSync(sourcePath, source, "utf8");
const attemptExport = request.attempt.attemptId.replace(/[^a-zA-Z0-9_$]/g, "_");
const attemptDeclaration = `export const deterministicEvolutionAttempt_${attemptExport} = ${JSON.stringify(request.attempt.attemptId)};`;
if (!source.includes(attemptDeclaration)) appendFileSync(sourcePath, `\n${attemptDeclaration}\n`, "utf8");
process.stdout.write(JSON.stringify({
  type: "maze-arena.harness-evolution.response",
  protocolVersion: 1,
  sessionId: request.session.id,
  result: {
    hypothesis: "确定性夹具通过生产协议修改源码",
    strategyPlan: "验证会话与工具边界后编辑 src/index.ts",
    submitted: true,
    toolActivity: "read,edit,test,submit",
  },
  usage: { tokens: request.attempt.attemptId.startsWith("g000") ? 2_500 : 64, cost: 0, modelCalls: 1 },
}));
