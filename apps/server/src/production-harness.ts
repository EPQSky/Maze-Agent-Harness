import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ExportedHarnessConfigAdapter,
  HarnessConfigurationError,
  type HarnessAdapter, type HarnessEvolutionRequest, type HarnessEvolutionResponse,
} from "@maze-arena/dsh-integration";

const DEFAULT_EVOLUTION_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export function createProductionHarnessAdapter(environment: NodeJS.ProcessEnv): HarnessAdapter {
  const exportPath = environment.DSH_HARNESS_EXPORT_PATH;
  const harnessVersion = environment.DSH_HARNESS_VERSION;
  const evolutionCommand = environment.DSH_EVOLUTION_COMMAND;
  const smokeCommand = environment.DSH_SMOKE_COMMAND;
  if (!exportPath || !harnessVersion || !evolutionCommand || !smokeCommand) {
    throw new HarnessConfigurationError("生产启动必须配置 DSH_HARNESS_EXPORT_PATH、DSH_HARNESS_VERSION、DSH_EVOLUTION_COMMAND 与 DSH_SMOKE_COMMAND");
  }
  const timeoutMs = parseTimeout(environment.DSH_EVOLUTION_TIMEOUT_MS);
  const config = ExportedHarnessConfigAdapter.fromFile(resolve(exportPath), harnessVersion);
  return {
    listModels: () => config.listModels(),
    validateModelProfile: (input) => config.validateModelProfile(input),
    smokeModel: (profile) => runSmokeCommand(resolve(smokeCommand), profile, timeoutMs),
    evolvePlugin: (request) => runEvolutionCommand(resolve(evolutionCommand), request, timeoutMs),
  };
}

async function runEvolutionCommand(
  command: string,
  request: HarnessEvolutionRequest,
  timeoutMs: number,
): Promise<HarnessEvolutionResponse> {
  const { signal, ...serializableRequest } = request;
  const value = await runJsonCommand(command, "evolve", serializableRequest, timeoutMs, signal);
  if (!isEvolutionResponse(value)) throw new Error("DSH 自治进程响应字段非法");
  return value;
}

async function runSmokeCommand(
  command: string,
  modelProfile: Parameters<NonNullable<HarnessAdapter["smokeModel"]>>[0],
  timeoutMs: number,
): Promise<{ providerText?: string }> {
  const value = await runJsonCommand(command, "smoke", { modelProfile }, timeoutMs);
  if (!isPlainObject(value) || !Object.keys(value).every((key) => key === "providerText")
    || (value.providerText !== undefined && typeof value.providerText !== "string")) {
    throw new Error("DSH 冒烟进程响应字段非法");
  }
  return value as { providerText?: string };
}

async function runJsonCommand(
  command: string,
  operation: "evolve" | "smoke",
  request: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const child = spawn(command, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_HARNESS_PROTOCOL: "1", DSH_HARNESS_OPERATION: operation },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const code = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const fail = (error: Error) => {
      if (!child.killed) child.kill("SIGTERM");
      finish(() => reject(error));
    };
    const append = (target: Buffer[], chunk: Buffer, kind: "stdout" | "stderr") => {
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((kind === "stdout" ? stdoutBytes : stderrBytes) > MAX_PROCESS_OUTPUT_BYTES) {
        fail(new Error(`DSH 自治进程 ${kind} 超过 1 MiB 限制`));
        return;
      }
      target.push(chunk);
    };
    const abort = () => fail(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程已取消`));
    const timer = setTimeout(() => fail(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程超过 ${timeoutMs}ms 超时限制`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (exitCode) => finish(() => resolve(exitCode)));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(JSON.stringify(request));
  });
  if (code !== 0) throw new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程失败：${Buffer.concat(stderr).toString("utf8").slice(0, 2_000)}`);
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
  catch { throw new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程未返回合法 JSON`); }
  return value;
}

function isEvolutionResponse(value: unknown): value is HarnessEvolutionResponse {
  if (!isPlainObject(value)) return false;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  return Object.keys(record).every((key) => ["hypothesis", "strategyPlan", "submitted", "usage", "reasoning", "toolActivity"].includes(key))
    && typeof record.hypothesis === "string" && typeof record.strategyPlan === "string"
    && typeof record.submitted === "boolean" && isPlainObject(usage)
    && Object.keys(usage).every((key) => ["tokens", "cost"].includes(key))
    && Number.isInteger(usage.tokens) && Number(usage.tokens) >= 0
    && typeof usage.cost === "number" && Number.isFinite(usage.cost) && Number(usage.cost) >= 0
    && (record.reasoning === undefined || typeof record.reasoning === "string")
    && (record.toolActivity === undefined || typeof record.toolActivity === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EVOLUTION_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new HarnessConfigurationError("DSH_EVOLUTION_TIMEOUT_MS 必须为 1000 到 600000 之间的整数毫秒数");
  }
  return parsed;
}
