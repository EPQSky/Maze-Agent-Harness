import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import {
  ExportedHarnessConfigAdapter,
  HarnessConfigurationError,
  type HarnessAdapter, type HarnessEvolutionRequest, type HarnessEvolutionResponse,
} from "@maze-arena/dsh-integration";

const DEFAULT_EVOLUTION_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const FORCE_KILL_CONFIRMATION_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 10;
const NAMESPACE_STARTUP_TIMEOUT_MS = 1_000;

export function createProductionHarnessAdapter(environment: NodeJS.ProcessEnv): HarnessAdapter {
  const catalogPath = environment.ARENA_MODEL_CATALOG_PATH;
  const harnessVersion = environment.DSH_HARNESS_VERSION;
  const evolutionCommand = environment.DSH_EVOLUTION_COMMAND;
  const smokeCommand = environment.DSH_SMOKE_COMMAND;
  const unshareCommand = environment.DSH_UNSHARE_EXECUTABLE ?? "/usr/bin/unshare";
  if (!catalogPath || !harnessVersion || !evolutionCommand || !smokeCommand) {
    throw new HarnessConfigurationError("生产启动必须配置 ARENA_MODEL_CATALOG_PATH、DSH_HARNESS_VERSION、DSH_EVOLUTION_COMMAND 与 DSH_SMOKE_COMMAND");
  }
  const timeoutMs = parseTimeout(environment.DSH_EVOLUTION_TIMEOUT_MS);
  const resolvedCatalogPath = resolve(catalogPath);
  const currentConfig = () => ExportedHarnessConfigAdapter.fromFile(resolvedCatalogPath, harnessVersion);
  return {
    listModels: () => currentConfig().listModels(),
    validateModelProfile: (input) => currentConfig().validateModelProfile(input),
    smokeModel: (profile) => runSmokeCommand(resolve(unshareCommand), resolve(smokeCommand), profile, timeoutMs),
    evolvePlugin: (request) => runEvolutionCommand(resolve(unshareCommand), resolve(evolutionCommand), request, timeoutMs),
  };
}

async function runEvolutionCommand(
  unshareCommand: string,
  command: string,
  request: HarnessEvolutionRequest,
  timeoutMs: number,
): Promise<HarnessEvolutionResponse> {
  const { signal, ...serializableRequest } = request;
  const value = await runJsonCommand(unshareCommand, command, "evolve", serializableRequest, timeoutMs, signal);
  if (!isEvolutionResponse(value)) throw new Error("DSH 自治进程响应字段非法");
  return value;
}

async function runSmokeCommand(
  unshareCommand: string,
  command: string,
  modelProfile: Parameters<NonNullable<HarnessAdapter["smokeModel"]>>[0],
  timeoutMs: number,
): Promise<{ providerText?: string }> {
  const value = await runJsonCommand(unshareCommand, command, "smoke", { modelProfile }, timeoutMs);
  if (!isPlainObject(value) || !Object.keys(value).every((key) => key === "providerText")
    || (value.providerText !== undefined && typeof value.providerText !== "string")) {
    throw new Error("DSH 冒烟进程响应字段非法");
  }
  return value as { providerText?: string };
}

async function runJsonCommand(
  unshareCommand: string,
  command: string,
  operation: "evolve" | "smoke",
  request: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const child = spawn(unshareCommand, [
    "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", command,
  ], {
    // PID namespace 是不可由被管理后代逃离的祖先边界，进程组仅负责终止外层 supervisor。
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_HARNESS_PROTOCOL: "1", DSH_HARNESS_OPERATION: operation },
  });
  const processGroupId = child.pid;
  const hostPidNamespace = readlinkSync("/proc/self/ns/pid");
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const code = await new Promise<number | null>((resolve, reject) => {
    let settled = false;
    let terminationError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    let closeCode: number | null | undefined;
    let shuttingDownGroup = false;
    let namespaceInit: { pid: number; identity: string } | undefined;
    let namespaceDiscoveryDone = false;
    const stdoutData = (chunk: Buffer) => append(stdout, chunk, "stdout");
    const stderrData = (chunk: Buffer) => append(undefined, chunk, "stderr");
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      if (groupPollTimer) clearTimeout(groupPollTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", stdoutData);
      child.stderr.off("data", stderrData);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      callback();
    };
    const groupExists = () => {
      if (!processGroupId) return false;
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const signalGroup = (signalToSend: NodeJS.Signals) => {
      if (!processGroupId) return;
      try { process.kill(-processGroupId, signalToSend); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const namespaceExists = () => {
      if (!namespaceDiscoveryDone) return true;
      if (!namespaceInit) return false;
      try { return readlinkSync(`/proc/${namespaceInit.pid}/ns/pid`) === namespaceInit.identity; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    };
    const signalNamespaceInit = (signalToSend: NodeJS.Signals) => {
      if (!namespaceInit || !namespaceExists()) return;
      try { process.kill(namespaceInit.pid, signalToSend); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const maybeFinish = () => {
      if (closeCode === undefined || groupExists() || namespaceExists()) return false;
      finish(() => terminationError ? reject(terminationError) : resolve(closeCode!));
      return true;
    };
    const pollGroup = () => {
      if (maybeFinish() || settled) return;
      groupPollTimer = setTimeout(pollGroup, PROCESS_GROUP_POLL_MS);
    };
    const terminate = (error?: Error) => {
      terminationError ??= error;
      if (shuttingDownGroup) return;
      shuttingDownGroup = true;
      child.stdin.destroy();
      if (namespaceInit) signalNamespaceInit("SIGTERM");
      else signalGroup("SIGTERM");
      pollGroup();
      killTimer = setTimeout(() => {
        if (groupExists()) signalGroup("SIGKILL");
        if (namespaceExists()) signalNamespaceInit("SIGKILL");
        confirmationTimer = setTimeout(() => {
          if (maybeFinish()) return;
          finish(() => reject(new Error(
            `DSH ${operation === "evolve" ? "自治" : "冒烟"}进程组强制终止后无法确认退出`,
          )));
        }, FORCE_KILL_CONFIRMATION_MS);
      }, TERMINATION_GRACE_MS);
    };
    const append = (target: Buffer[] | undefined, chunk: Buffer, kind: "stdout" | "stderr") => {
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((kind === "stdout" ? stdoutBytes : stderrBytes) > MAX_PROCESS_OUTPUT_BYTES) {
        terminate(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程 ${kind} 超过 1 MiB 限制`));
        return;
      }
      target?.push(chunk);
    };
    const abort = () => terminate(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程已取消`));
    const timer = setTimeout(() => terminate(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程超过 ${timeoutMs}ms 超时限制`)), timeoutMs);
    child.stdout.on("data", stdoutData);
    child.stderr.on("data", stderrData);
    child.stdin.on("error", () => { /* 终止期间的 EPIPE 由进程退出结果统一处理。 */ });
    child.once("error", () => finish(() => reject(new Error(`无法启动 DSH ${operation === "evolve" ? "自治" : "冒烟"}进程`))));
    child.once("close", (exitCode) => {
      closeCode = exitCode;
      if (!maybeFinish() && namespaceExists() && !shuttingDownGroup) terminate();
    });
    signal?.addEventListener("abort", abort, { once: true });
    void discoverNamespaceInit(processGroupId, hostPidNamespace, NAMESPACE_STARTUP_TIMEOUT_MS).then((discovered) => {
      namespaceInit = discovered;
      namespaceDiscoveryDone = true;
      if (signal?.aborted) return abort();
      if (settled || shuttingDownGroup) return;
      child.stdin.end(JSON.stringify(request));
    }, () => {
      namespaceDiscoveryDone = true;
      if (settled) return;
      terminate(new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程无法建立受控 PID namespace`));
    });
  });
  if (code !== 0) throw new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程失败（退出码 ${code ?? "未知"}）`);
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
  catch { throw new Error(`DSH ${operation === "evolve" ? "自治" : "冒烟"}进程未返回合法 JSON`); }
  return value;
}

async function discoverNamespaceInit(
  supervisorPid: number | undefined,
  hostNamespace: string,
  timeoutMs: number,
): Promise<{ pid: number; identity: string }> {
  if (!supervisorPid) throw new Error("unshare supervisor 缺少 PID");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const children = readFileSync(`/proc/${supervisorPid}/task/${supervisorPid}/children`, "utf8").trim().split(/\s+/);
      for (const value of children) {
        const pid = Number(value);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const identity = readlinkSync(`/proc/${pid}/ns/pid`);
        if (identity !== hostNamespace) return { pid, identity };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, PROCESS_GROUP_POLL_MS));
  }
  throw new Error("未发现隔离 namespace init");
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
