import { createInterface } from "node:readline";
import type {
  GeneratorCapability,
  MatchPluginRole,
  MatchProtocolRequest,
  MatchProtocolResponse,
  SolverCapability,
} from "@maze-arena/contracts";
const MATCH_OUTPUT_LIMIT_BYTES = 16 * 1024;
const MATCH_PROTOCOL_VERSION = 1;

type Capability = GeneratorCapability | SolverCapability;
interface HarnessContext {
  mazeGenerator?: GeneratorCapability;
  mazeSolver?: SolverCapability;
}

export function apply(ctx: HarnessContext): () => void {
  const role = process.env.MAZE_MATCH_ROLE as MatchPluginRole | undefined;
  if (!role || !["generator", "solver"].includes(role)) throw new Error("Match Profile 角色配置缺失");
  const capability = role === "generator" ? ctx.mazeGenerator : ctx.mazeSolver;
  if (!capability || typeof capability.handle !== "function") throw new Error("插件没有注册唯一角色能力");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let expectedSequence = 1;
  process.stdout.write(`${JSON.stringify({ type: "match-profile.ready", protocolVersion: MATCH_PROTOCOL_VERSION, role })}\n`);
  input.on("line", async (line) => {
    if (Buffer.byteLength(line) > MATCH_OUTPUT_LIMIT_BYTES) throw new Error("请求帧超限");
    input.pause();
    const request = JSON.parse(line) as MatchProtocolRequest;
    validateRequest(request, role, expectedSequence);
    const payload = await capability!.handle(request.payload as never);
    const response: MatchProtocolResponse = {
      protocolVersion: MATCH_PROTOCOL_VERSION,
      requestId: request.requestId,
      sequence: request.sequence,
      role,
      payload,
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
    expectedSequence += 1;
    input.resume();
  });
  return () => { input.close(); };
}

function validateRequest(value: MatchProtocolRequest, role: MatchPluginRole, expectedSequence: number): void {
  if (!value || value.protocolVersion !== MATCH_PROTOCOL_VERSION || value.role !== role
    || typeof value.requestId !== "string" || value.requestId.length < 1 || value.requestId.length > 128
    || value.sequence !== expectedSequence || !value.payload || typeof value.payload !== "object") throw new Error("请求信封非法");
  if (role === "solver" && "seed" in value.payload) throw new Error("Solver 请求禁止包含生成种子");
}
