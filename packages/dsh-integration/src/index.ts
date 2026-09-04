import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isSensitiveProviderOptionName,
  type HarnessAgentEnvironments,
  type HarnessCatalogResponse,
  type HarnessModel,
  type ModelProfile,
  type ModelProfileInput,
  type ProviderOptionCapability,
  type ProviderOptionValue,
} from "@maze-arena/contracts";

export interface HarnessAdapter {
  listModels(): HarnessCatalogResponse;
  validateModelProfile(input: ModelProfileInput): ModelProfile;
  smokeModel?(profile: ModelProfile): Promise<{ providerText?: string }>;
  evolvePlugin?(request: HarnessEvolutionRequest): Promise<HarnessEvolutionResponse>;
}

export const HARNESS_EVOLUTION_PROTOCOL_VERSION = 1 as const;
export const HARNESS_EVOLUTION_REQUEST_TYPE = "maze-arena.harness-evolution.request" as const;
export const HARNESS_EVOLUTION_RESPONSE_TYPE = "maze-arena.harness-evolution.response" as const;
/** 完整协议请求必须严格小于该字节数。 */
export const HARNESS_EVOLUTION_MAX_REQUEST_BYTES = 1024 * 1024;
/** 为会话、模型配置和诊断信息保留固定余量，可信反馈最多占用请求预算的一半。 */
export const HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES = 512 * 1024;
/** 进化反馈仅保留最近的可信尝试，避免长实验令协议请求无界增长。 */
export const HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS = 64;
export const HARNESS_EVOLUTION_MAX_LINEAGE_PLANS = 16;
export const HARNESS_EVOLUTION_MAX_PUBLIC_TRACES = 16;
export const HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS = 64;
export const HARNESS_EVOLUTION_MAX_TRACE_METRICS = 64;
export const HARNESS_EVOLUTION_MAX_TRACE_EVENTS = 128;
export const HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES = 8 * 1024;
export const HARNESS_EVOLUTION_ALLOWED_TOOLS = Object.freeze([
  "read", "edit", "search", "shell", "test", "public-check", "submit",
] as const);

const SECCOMP_DATA_ARCH_OFFSET = 4;
const SECCOMP_DATA_ARGUMENTS_OFFSET = 16;
const X32_SYSCALL_BIT = 0x40000000;
const ADDRESS_FAMILY_UNIX = 1;
const SECCOMP_RETURN_ALLOW = 0x7fff0000;
const SECCOMP_RETURN_KILL_PROCESS = 0x80000000;
const SECCOMP_RETURN_ERRNO = 0x00050000;
const ERROR_ADDRESS_FAMILY_NOT_SUPPORTED = 97;
const ERROR_FUNCTION_NOT_IMPLEMENTED = 38;
const ISOLATED_PROCESS_POLL_MS = 10;
const ISOLATED_NAMESPACE_STARTUP_TIMEOUT_MS = 1_000;
const ISOLATED_TERMINATION_GRACE_MS = 250;
const ISOLATED_FORCE_KILL_CONFIRMATION_MS = 1_000;

interface SeccompArchitecture {
  auditArchitecture: number;
  socketSystemCall: number;
  socketPairSystemCall: number;
}

const seccompArchitectures: Readonly<Record<string, SeccompArchitecture>> = Object.freeze({
  x64: { auditArchitecture: 0xc000003e, socketSystemCall: 41, socketPairSystemCall: 53 },
  arm64: { auditArchitecture: 0xc00000b7, socketSystemCall: 198, socketPairSystemCall: 199 },
});

/** 生成供 bubblewrap 使用的经典 BPF，阻断宿主路径和抽象命名空间中的 Unix socket。 */
export function createHarnessNetworkSeccompProgram(architecture: string = process.arch): Buffer {
  const selected = seccompArchitectures[architecture];
  if (!selected) throw new HarnessConfigurationError(`Harness 网络隔离不支持当前 CPU 架构：${architecture}`);
  const instructions = [
    [0x20, 0, 0, SECCOMP_DATA_ARCH_OFFSET],
    [0x15, 1, 0, selected.auditArchitecture],
    [0x06, 0, 0, SECCOMP_RETURN_KILL_PROCESS],
    [0x20, 0, 0, 0],
    [0x35, 0, 1, X32_SYSCALL_BIT],
    [0x06, 0, 0, SECCOMP_RETURN_ERRNO | ERROR_FUNCTION_NOT_IMPLEMENTED],
    [0x15, 1, 0, selected.socketSystemCall],
    [0x15, 2, 5, selected.socketPairSystemCall],
    [0x20, 0, 0, SECCOMP_DATA_ARGUMENTS_OFFSET],
    [0x15, 2, 3, ADDRESS_FAMILY_UNIX],
    [0x20, 0, 0, SECCOMP_DATA_ARGUMENTS_OFFSET],
    [0x15, 0, 1, ADDRESS_FAMILY_UNIX],
    [0x06, 0, 0, SECCOMP_RETURN_ERRNO | ERROR_ADDRESS_FAMILY_NOT_SUPPORTED],
    [0x06, 0, 0, SECCOMP_RETURN_ALLOW],
  ] as const;
  const program = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jumpTrue, jumpFalse, value], index) => {
    const offset = index * 8;
    program.writeUInt16LE(code, offset);
    program.writeUInt8(jumpTrue, offset + 2);
    program.writeUInt8(jumpFalse, offset + 3);
    program.writeUInt32LE(value >>> 0, offset + 4);
  });
  return program;
}

/** 对正式运行载荷的目录、权限、链接目标和文件内容生成稳定身份。 */
export function hashHarnessRuntimePayload(runtimeRoot: string): string {
  const root = realpathSync(resolve(runtimeRoot));
  if (!lstatSync(root).isDirectory()) throw new HarnessConfigurationError("Harness runtime root 必须为目录");
  const digest = createHash("sha256");
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const local = relative(root, current).split(sep).join("/") || ".";
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      digest.update(`directory\0${local}\0${stat.mode & 0o777}\0`);
      pending.push(...readdirSync(current).map((entry) => join(current, entry)).sort().reverse());
    } else if (stat.isFile()) {
      digest.update(`file\0${local}\0${stat.mode & 0o777}\0${stat.size}\0`);
      digest.update(readFileSync(current));
      digest.update("\0");
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(current);
      const resolvedTarget = realpathSync(current);
      const relation = relative(root, resolvedTarget);
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new HarnessConfigurationError(`Harness runtime 载荷符号链接越出运行根：${local}`);
      }
      digest.update(`symlink\0${local}\0${target}\0`);
    } else {
      throw new HarnessConfigurationError(`Harness runtime 载荷包含不支持的文件类型：${local}`);
    }
  }
  return digest.digest("hex");
}

export interface IsolatedHarnessCommandOptions {
  command: string;
  args: readonly string[];
  runtimeRoot: string;
  expectedRuntimePayloadSha256: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  outputLimitBytes?: number;
  cwd?: string;
  writablePaths?: readonly string[];
  readOnlyPaths?: readonly string[];
  unshareCommand?: string;
  bubblewrapCommand?: string;
  signal?: AbortSignal;
}

export interface IsolatedHarnessCommandResult {
  stdout: string;
  exitCode: number;
}

export class IsolatedHarnessCommandError extends Error {
  constructor(
    message: string,
    readonly kind: "cancelled" | "timeout" | "output" | "process" | "exit",
    readonly exitCode?: number | null,
  ) {
    super(message);
    this.name = "IsolatedHarnessCommandError";
  }
}

/** 在最小只读宿主视图中执行 Harness 子命令，并在返回前收敛整个 PID namespace。 */
export async function runIsolatedHarnessCommand(
  options: IsolatedHarnessCommandOptions,
): Promise<IsolatedHarnessCommandResult> {
  const timeoutMs = options.timeoutMs;
  const outputLimitBytes = options.outputLimitBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1) {
    throw new IsolatedHarnessCommandError("Harness 隔离命令资源限制无效", "process");
  }
  const runtimeRoot = isolatedRealDirectory(options.runtimeRoot, "Harness runtime root");
  if (hashHarnessRuntimePayload(runtimeRoot) !== options.expectedRuntimePayloadSha256) {
    throw new IsolatedHarnessCommandError("Harness runtime 冻结载荷身份已漂移", "process");
  }
  const command = isolatedRealFile(options.command, "Harness 命令");
  if (!isolatedNestedPath(runtimeRoot, command)) {
    throw new IsolatedHarnessCommandError("Harness 命令必须位于冻结 runtime root 内", "process");
  }
  const writablePaths = (options.writablePaths ?? []).map((path) => isolatedRealPath(path, "Harness 可写路径"));
  const readOnlyPaths = (options.readOnlyPaths ?? []).map((path) => isolatedRealPath(path, "Harness 只读路径"));
  const cwd = options.cwd ? isolatedRealDirectory(options.cwd, "Harness 工作目录") : undefined;
  if (cwd && !writablePaths.some((path) => isolatedNestedPath(path, cwd))) {
    throw new IsolatedHarnessCommandError("Harness 工作目录必须位于显式可写路径内", "process");
  }
  const sandboxArguments = isolatedRuntimeArguments(command, options.environment, runtimeRoot);
  for (const path of writablePaths) sandboxArguments.push("--bind", path, path);
  for (const path of readOnlyPaths) sandboxArguments.push("--ro-bind", path, path);
  if (cwd) sandboxArguments.push("--chdir", cwd);
  sandboxArguments.push(
    "--remount-ro", "/run", "--remount-ro", "/tmp", "--remount-ro", "/var/tmp",
    "--seccomp", "3", "--", "/bin/sh", "-c", 'IFS= read -r _; exec "$@"',
    "maze-harness-command-gate", command, ...options.args,
  );
  const seccompDescriptor = openIsolatedHarnessSeccompDescriptor();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.unshareCommand ?? "/usr/bin/unshare", [
      "--user", "--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc",
      options.bubblewrapCommand ?? "/usr/bin/bwrap", ...sandboxArguments,
    ], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe", seccompDescriptor],
      cwd: "/",
      env: options.environment,
    }) as ChildProcessWithoutNullStreams;
  } finally {
    closeSync(seccompDescriptor);
  }
  const processGroupId = child.pid;
  const hostNamespace = readlinkSync("/proc/self/ns/pid");
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const code = await new Promise<number | null>((resolveCode, reject) => {
    let settled = false;
    let terminalError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let closeCode: number | null | undefined;
    let shuttingDown = false;
    let namespaceInit: { pid: number; identity: string } | undefined;
    let namespaceDiscoveryDone = false;
    const stdoutData = (chunk: Buffer) => append(stdout, chunk, "stdout");
    const stderrData = (chunk: Buffer) => append(undefined, chunk, "stderr");
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      if (pollTimer) clearTimeout(pollTimer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.off("data", stdoutData);
      child.stderr.off("data", stderrData);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      callback();
    };
    const groupExists = () => {
      if (!processGroupId) return false;
      try { process.kill(-processGroupId, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const namespaceExists = () => {
      if (!namespaceDiscoveryDone) return true;
      if (!namespaceInit) return false;
      try { return readlinkSync(`/proc/${namespaceInit.pid}/ns/pid`) === namespaceInit.identity; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!processGroupId) return;
      try { process.kill(-processGroupId, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const signalNamespace = (signal: NodeJS.Signals) => {
      if (!namespaceInit || !namespaceExists()) return;
      try { process.kill(namespaceInit.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    const maybeFinish = () => {
      if (closeCode === undefined || groupExists() || namespaceExists()) return false;
      finish(() => terminalError ? reject(terminalError) : resolveCode(closeCode!));
      return true;
    };
    const poll = () => {
      if (maybeFinish() || settled) return;
      pollTimer = setTimeout(poll, ISOLATED_PROCESS_POLL_MS);
    };
    const terminate = (error?: Error) => {
      terminalError ??= error;
      if (shuttingDown) return;
      shuttingDown = true;
      child.stdin.destroy();
      if (namespaceInit) signalNamespace("SIGTERM");
      else signalGroup("SIGTERM");
      poll();
      killTimer = setTimeout(() => {
        if (groupExists()) signalGroup("SIGKILL");
        if (namespaceExists()) signalNamespace("SIGKILL");
        confirmationTimer = setTimeout(() => {
          if (maybeFinish()) return;
          finish(() => reject(new IsolatedHarnessCommandError(
            "Harness 进程组强制终止后无法确认退出",
            "process",
          )));
        }, ISOLATED_FORCE_KILL_CONFIRMATION_MS);
      }, ISOLATED_TERMINATION_GRACE_MS);
    };
    const append = (target: Buffer[] | undefined, chunk: Buffer, kind: "stdout" | "stderr") => {
      if (kind === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((kind === "stdout" ? stdoutBytes : stderrBytes) > outputLimitBytes) {
        terminate(new IsolatedHarnessCommandError(`Harness 进程 ${kind} 超过 ${outputLimitBytes} 字节限制`, "output"));
        return;
      }
      target?.push(chunk);
    };
    const abort = () => terminate(new IsolatedHarnessCommandError("Harness 进程已取消", "cancelled"));
    const timeoutTimer = setTimeout(
      () => terminate(new IsolatedHarnessCommandError(`Harness 进程超过 ${timeoutMs}ms 超时限制`, "timeout")),
      timeoutMs,
    );
    child.stdout.on("data", stdoutData);
    child.stderr.on("data", stderrData);
    child.stdin.on("error", () => { /* 终止期间的 EPIPE 由进程退出统一处理。 */ });
    child.once("error", () => finish(() => reject(new IsolatedHarnessCommandError("无法启动隔离 Harness 进程", "process"))));
    child.once("close", (exitCode) => {
      closeCode = exitCode;
      if (!maybeFinish() && namespaceExists() && !shuttingDown) terminate();
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    void discoverIsolatedNamespaceInit(processGroupId, hostNamespace, ISOLATED_NAMESPACE_STARTUP_TIMEOUT_MS).then((discovered) => {
      namespaceInit = discovered;
      namespaceDiscoveryDone = true;
      if (options.signal?.aborted) return abort();
      if (settled || shuttingDown) return;
      child.stdin.write("\n");
      child.stdin.end(options.stdin ?? "");
    }, () => {
      namespaceDiscoveryDone = true;
      if (!settled) terminate(new IsolatedHarnessCommandError("Harness 进程无法建立受控 PID namespace", "process"));
    });
  });
  if (code !== 0) throw new IsolatedHarnessCommandError(`Harness 进程失败（退出码 ${code ?? "未知"}）`, "exit", code);
  return { stdout: Buffer.concat(stdout).toString("utf8"), exitCode: code };
}

function isolatedRuntimeArguments(command: string, environment: NodeJS.ProcessEnv, runtimeRoot: string): string[] {
  const argumentsList = ["--die-with-parent", "--new-session", "--unshare-ipc", "--ro-bind", "/usr", "/usr"];
  for (const [target, source] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"]] as const) {
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) argumentsList.push("--symlink", source, target);
  }
  for (const path of ["/etc/hosts", "/etc/nsswitch.conf", "/etc/resolv.conf", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/ssl/certs", "/etc/pki"]) {
    if (lstatSync(path, { throwIfNoEntry: false })) argumentsList.push("--ro-bind", realpathSync(path), path);
  }
  argumentsList.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp");
  if (!isolatedNestedPath("/usr", runtimeRoot)) argumentsList.push("--ro-bind", runtimeRoot, runtimeRoot);
  const interpreter = isolatedCommandInterpreter(command, environment);
  if (interpreter && !isolatedNestedPath("/usr", interpreter) && !isolatedNestedPath(runtimeRoot, interpreter)) {
    argumentsList.push("--ro-bind", interpreter, interpreter);
  }
  return argumentsList;
}

function isolatedCommandInterpreter(command: string, environment: NodeJS.ProcessEnv): string | undefined {
  const buffer = Buffer.alloc(4_096);
  const descriptor = openSync(command, "r");
  let length: number;
  try { length = readSync(descriptor, buffer, 0, buffer.length, 0); }
  finally { closeSync(descriptor); }
  const prefix = buffer.subarray(0, length).toString("utf8");
  if (!prefix.startsWith("#!")) return undefined;
  const words = prefix.slice(2, prefix.indexOf("\n") === -1 ? undefined : prefix.indexOf("\n")).trim().split(/\s+/);
  const declared = words[0];
  if (!declared || !isAbsolute(declared)) throw new IsolatedHarnessCommandError("Harness shebang 必须使用绝对解释器路径", "process");
  const resolved = isolatedRealFile(declared, "Harness shebang 解释器");
  if (resolved !== "/usr/bin/env") return resolved;
  const program = words.find((word, index) => index > 0 && !word.startsWith("-"));
  if (!program || program.includes("/")) throw new IsolatedHarnessCommandError("Harness env shebang 缺少受控解释器名称", "process");
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = resolve(directory, program);
    if (lstatSync(candidate, { throwIfNoEntry: false })) return isolatedRealFile(candidate, `Harness 解释器 ${program}`);
  }
  throw new IsolatedHarnessCommandError(`Harness 命令解释器不可用：${program}`, "process");
}

function openIsolatedHarnessSeccompDescriptor(): number {
  const directory = mkdtempSync(join(tmpdir(), "maze-harness-seccomp-"));
  const path = join(directory, "network.bpf");
  try {
    writeFileSync(path, createHarnessNetworkSeccompProgram(), { mode: 0o600 });
    const descriptor = openSync(path, "r");
    rmSync(directory, { recursive: true, force: true });
    return descriptor;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function discoverIsolatedNamespaceInit(
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
    await new Promise((resolveWait) => setTimeout(resolveWait, ISOLATED_PROCESS_POLL_MS));
  }
  throw new Error("未发现隔离 namespace init");
}

function isolatedRealPath(path: string, label: string): string {
  try { return realpathSync(resolve(path)); }
  catch { throw new IsolatedHarnessCommandError(`${label}不存在`, "process"); }
}

function isolatedRealFile(path: string, label: string): string {
  const resolved = isolatedRealPath(path, label);
  if (!lstatSync(resolved).isFile()) throw new IsolatedHarnessCommandError(`${label}必须为文件`, "process");
  return resolved;
}

function isolatedRealDirectory(path: string, label: string): string {
  const resolved = isolatedRealPath(path, label);
  if (!lstatSync(resolved).isDirectory()) throw new IsolatedHarnessCommandError(`${label}必须为目录`, "process");
  return resolved;
}

function isolatedNestedPath(parent: string, candidate: string): boolean {
  const local = relative(parent, candidate);
  return local === "" || (!local.startsWith("..") && !isAbsolute(local));
}

export type HarnessEvolutionTool = (typeof HARNESS_EVOLUTION_ALLOWED_TOOLS)[number];
export type HarnessExecutionKind = "fake" | "deterministic-fixture" | "real-provider";
export interface HarnessEvolutionTrustedInput {
  role: "generator" | "solver";
  championRoot: string;
  lineagePlans: readonly { attemptId: string; strategyPlan: string }[];
  trustedResults: readonly {
    attemptId: string;
    generation: number;
    role: "generator" | "solver";
    outcome: "promoted" | "failed" | "tie";
    publicCaseCount: number;
    hiddenCaseCount: number;
    totalCandidateAggregate: Readonly<Record<string, number>>;
    /** 旧协议输入可缺省；存在时仅包含去身份化的隐藏指标汇总。 */
    hiddenCandidateAggregate?: Readonly<Record<string, number>>;
  }[];
  publicTraces: readonly {
    attemptId: string;
    generation: number;
    traceId: string;
    outcome: "success" | "failure" | "tie";
    metrics: Readonly<Record<string, number>>;
    events: readonly (
      | { type: "maze.carved"; from: { x: number; y: number }; to: { x: number; y: number } }
      | { type: "maze.completed"; passageCount: number }
      | { type: "solver.decision"; position: { x: number; y: number }; openDirections: readonly ("north" | "east" | "south" | "west")[]; remainingSteps: number; direction: "north" | "east" | "south" | "west"; kind: "move" | "backtrack" }
    )[];
  }[];
  hiddenAggregate: {
    completedAttemptCount: number;
    metricAvailableAttemptCount: number;
    metricUnavailableAttemptCount: number;
    promotedAttemptCount: number;
    failedAttemptCount: number;
    tieAttemptCount: number;
    evaluatedHiddenCaseCount: number;
    metricTotals: Readonly<Record<string, number>>;
  };
}

/** 以生产协议实际发送的完整可信输入对象计算 UTF-8 JSON 字节数。 */
export function harnessEvolutionTrustedInputBytes(input: HarnessEvolutionTrustedInput): number {
  return Buffer.byteLength(JSON.stringify(input), "utf8");
}

export interface HarnessEvolutionRequest {
  sessionId: string;
  experimentId: string;
  generation: number;
  role: "generator" | "solver";
  attemptId: string;
  modelProfile: ModelProfile;
  home: string;
  workspace: string;
  input: HarnessEvolutionTrustedInput;
  allowedTools: readonly HarnessEvolutionTool[];
  repairAttempt: number;
  diagnostics: readonly string[];
  signal?: AbortSignal;
}

export interface HarnessEvolutionResponse {
  hypothesis: string;
  strategyPlan: string;
  submitted: boolean;
  usage: { tokens: number; cost: number };
  reasoning?: string;
  toolActivity?: string;
  execution: HarnessExecutionIdentity;
}

export interface HarnessExecutionIdentity {
  kind: HarnessExecutionKind;
  protocolVersion: typeof HARNESS_EVOLUTION_PROTOCOL_VERSION;
  sessionId: string;
  harnessVersion: string;
  providerId: string;
  modelId: string;
}

export interface HarnessEvolutionProtocolRequest {
  type: typeof HARNESS_EVOLUTION_REQUEST_TYPE;
  protocolVersion: typeof HARNESS_EVOLUTION_PROTOCOL_VERSION;
  session: {
    id: string;
    home: string;
    workspace: string;
    role: "generator" | "solver";
    roleConstraint: string;
    allowedTools: readonly HarnessEvolutionTool[];
  };
  attempt: {
    experimentId: string;
    generation: number;
    attemptId: string;
    repairAttempt: number;
    diagnostics: readonly string[];
  };
  modelProfile: ModelProfile;
  input: HarnessEvolutionTrustedInput;
}

export interface HarnessEvolutionProtocolResponse {
  type: typeof HARNESS_EVOLUTION_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_EVOLUTION_PROTOCOL_VERSION;
  sessionId: string;
  result: {
    hypothesis: string;
    strategyPlan: string;
    submitted: boolean;
    reasoning?: string;
    toolActivity?: string;
  };
  usage: { tokens: number; cost: number };
}

export interface HarnessEvolutionProtocolErrorResponse {
  type: typeof HARNESS_EVOLUTION_RESPONSE_TYPE;
  protocolVersion: typeof HARNESS_EVOLUTION_PROTOCOL_VERSION;
  sessionId: string;
  error: { kind: "transient-provider" | "provider"; code: string };
  usage: { tokens: number; cost: number };
}

export interface ModelProfileIssue {
  path: string;
  message: string;
}

export class ModelProfileValidationError extends Error {
  constructor(readonly issues: ModelProfileIssue[]) {
    super("模型配置档无效");
    this.name = "ModelProfileValidationError";
  }
}

export class HarnessConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessConfigurationError";
  }
}

export interface HarnessModelCatalog {
  schemaVersion: 1;
  harnessVersion: string;
  credentialRefs: string[];
  providers: HarnessCatalogResponse["providers"];
}

const catalog: HarnessCatalogResponse = {
  credentialRefs: ["dsh-credential://basic", "dsh-credential://reasoning"],
  providers: [
    {
      id: "fake-basic",
      label: "确定性基础提供方",
      models: [{
        id: "compact-v1",
        label: "Compact V1",
        capabilities: {
          reasoningEfforts: [],
          temperature: { minimum: 0, maximum: 2 },
          topP: { minimum: 0, maximum: 1 },
          maxContextTokens: 8_000,
          maxOutputTokens: 2_000,
          maxTotalTokens: 10_000,
          providerOptions: { deterministicSeed: { type: "number", minimum: 0, maximum: 999_999 } },
        },
      }],
    },
    {
      id: "fake-reasoning",
      label: "确定性推理提供方",
      models: [{
        id: "reasoner-v1",
        label: "Reasoner V1",
        capabilities: {
          reasoningEfforts: ["low", "medium", "high"],
          maxContextTokens: 32_000,
          maxOutputTokens: 8_000,
          maxTotalTokens: 40_000,
          providerOptions: { thinkingBudget: { type: "number", minimum: 1_000, maximum: 20_000 } },
        },
      }],
    },
  ],
};

const fakeCredentialRefs = new Set(["dsh-credential://basic", "dsh-credential://reasoning"]);
const credentialReferencePattern = /^dsh-credential:\/\/[a-z0-9][a-z0-9._-]{0,79}$/;
const catalogIdPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const providerOptionNamePattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/;
const catalogIdentityPattern = /^sha256:[0-9a-f]{64}$/;
const obviousSecretPattern = /(?:\bsk-[A-Za-z0-9_-]{8,}\b|\bbearer\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+)/i;

const allowedProfileFields = new Set([
  "providerId",
  "modelId",
  "credentialRef",
  "reasoningEffort",
  "temperature",
  "topP",
  "contextTokens",
  "outputTokens",
  "totalTokenLimit",
  "providerOptions",
]);

function validateNumberRange(
  issues: ModelProfileIssue[],
  path: string,
  value: unknown,
  range: { minimum: number; maximum: number } | undefined,
): void {
  if (value === undefined) return;
  if (!range) {
    issues.push({ path, message: `${path} 不受当前模型支持` });
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < range.minimum || value > range.maximum) {
    issues.push({ path, message: `${path} 必须位于 ${range.minimum} 到 ${range.maximum} 之间` });
  }
}

function validatePositiveInteger(
  issues: ModelProfileIssue[],
  path: string,
  value: unknown,
  maximum: number,
): void {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    issues.push({ path, message: `${path} 必须为 1 到 ${maximum} 之间的整数` });
  }
}

function validateProviderOption(
  issues: ModelProfileIssue[],
  key: string,
  value: ProviderOptionValue,
  capability: ProviderOptionCapability | undefined,
): void {
  const path = `providerOptions.${key}`;
  if (!capability) {
    issues.push({ path, message: `${path} 不受当前模型支持` });
    return;
  }
  if (typeof value !== capability.type) {
    issues.push({ path, message: `${path} 必须为 ${capability.type}` });
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push({ path, message: `${path} 必须为有限数字` });
    return;
  }
  if (typeof value === "number" && (
    (capability.minimum !== undefined && value < capability.minimum)
    || (capability.maximum !== undefined && value > capability.maximum)
  )) {
    issues.push({ path, message: `${path} 超出模型能力范围` });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new HarnessConfigurationError(`${path} 包含未知字段`);
  }
}

function assertNoSecretFieldName(key: string, path: readonly string[]): void {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (path.length === 0 && normalized === "credentialrefs") return;
  if (["maxcontexttokens", "maxoutputtokens", "maxtotaltokens"].includes(normalized)) return;
  const forbidden = obviousSecretPattern.test(key)
    || isSensitiveProviderOptionName(key);
  if (forbidden) throw new HarnessConfigurationError("Harness 导出包含禁止的敏感字段");
}

function assertNoSecretMaterial(value: unknown, path: readonly string[] = []): void {
  if (typeof value === "string" && obviousSecretPattern.test(value)) {
    throw new HarnessConfigurationError("Harness 导出包含疑似真实凭据内容");
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSecretMaterial(entry, path);
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoSecretFieldName(key, path);
      assertNoSecretMaterial(entry, [...path, key]);
    }
  }
}

function validateAgainstCatalog(
  input: ModelProfileInput,
  available: HarnessCatalogResponse,
  credentialRefs: ReadonlySet<string>,
  catalogIdentity: string,
): ModelProfile {
  const issues: ModelProfileIssue[] = [];
  if (!isPlainObject(input)) throw new ModelProfileValidationError([{ path: "modelProfile", message: "模型配置档必须为普通对象" }]);
  for (const key of Object.keys(input)) {
    if (!allowedProfileFields.has(key)) issues.push({ path: key, message: `${key} 不是受支持的模型配置字段` });
  }

  const provider = available.providers.find((candidate) => candidate.id === input.providerId);
  const model = provider?.models.find((candidate) => candidate.id === input.modelId);
  if (!provider) issues.push({ path: "providerId", message: "提供方不存在或未由 Harness 配置" });
  if (provider && !model) issues.push({ path: "modelId", message: "模型不属于所选提供方" });

  if (typeof input.credentialRef !== "string" || !credentialReferencePattern.test(input.credentialRef)) {
    issues.push({ path: "credentialRef", message: "凭据引用必须使用 dsh-credential://<id> 格式" });
  } else if (!credentialRefs.has(input.credentialRef)) {
    issues.push({ path: "credentialRef", message: "凭据引用未在只读 Harness 导出中注册" });
  }

  if (input.providerOptions !== undefined && !isPlainObject(input.providerOptions)) {
    issues.push({ path: "providerOptions", message: "providerOptions 必须为普通对象" });
  }
  if (model) validateCapabilities(input, model, issues);
  if (issues.length > 0) throw new ModelProfileValidationError(issues);

  return {
    ...input,
    providerOptions: input.providerOptions ? { ...input.providerOptions } : undefined,
    providerLabel: provider!.label,
    modelLabel: model!.label,
    catalogIdentity,
    catalogCapabilities: structuredClone(model!.capabilities),
  };
}

export function validateModelProfileSnapshot(profile: ModelProfile): ModelProfile {
  if (!isPlainObject(profile) || typeof profile.providerLabel !== "string" || typeof profile.modelLabel !== "string"
    || typeof profile.catalogIdentity !== "string" || !catalogIdentityPattern.test(profile.catalogIdentity)
    || !isPlainObject(profile.catalogCapabilities)) {
    throw new ModelProfileValidationError([{ path: "modelProfile", message: "模型配置档缺少有效目录快照" }]);
  }
  const { providerLabel, modelLabel, catalogIdentity, catalogCapabilities, ...input } = profile;
  return validateAgainstCatalog(input, {
    credentialRefs: [input.credentialRef],
    providers: [{
      id: input.providerId,
      label: providerLabel,
      models: [{ id: input.modelId, label: modelLabel, capabilities: catalogCapabilities }],
    }],
  }, new Set([input.credentialRef]), catalogIdentity);
}

function validateCapabilities(input: ModelProfileInput, model: HarnessModel, issues: ModelProfileIssue[]): void {
  const capabilities = model.capabilities;
  if (input.reasoningEffort !== undefined && !capabilities.reasoningEfforts.includes(input.reasoningEffort)) {
    issues.push({ path: "reasoningEffort", message: "reasoningEffort 不受当前模型支持" });
  }
  validateNumberRange(issues, "temperature", input.temperature, capabilities.temperature);
  validateNumberRange(issues, "topP", input.topP, capabilities.topP);
  validatePositiveInteger(issues, "contextTokens", input.contextTokens, capabilities.maxContextTokens);
  validatePositiveInteger(issues, "outputTokens", input.outputTokens, capabilities.maxOutputTokens);
  validatePositiveInteger(issues, "totalTokenLimit", input.totalTokenLimit, capabilities.maxTotalTokens);
  if (Number.isFinite(input.totalTokenLimit)
    && Number.isFinite(input.contextTokens)
    && Number.isFinite(input.outputTokens)
    && input.totalTokenLimit < input.contextTokens + input.outputTokens) {
    issues.push({ path: "totalTokenLimit", message: "总令牌上限不能小于上下文与输出预算之和" });
  }
  if (isPlainObject(input.providerOptions)) {
    for (const [key, value] of Object.entries(input.providerOptions)) {
      if (!(["boolean", "number", "string"] as const).includes(typeof value as never)) {
        issues.push({ path: `providerOptions.${key}`, message: `providerOptions.${key} 必须为 boolean、number 或 string` });
      } else {
        validateProviderOption(issues, key, value as ProviderOptionValue, capabilities.providerOptions[key]);
      }
    }
  }
}

export function parseHarnessModelCatalog(raw: unknown, expectedHarnessVersion: string): HarnessModelCatalog {
  assertNoSecretMaterial(raw);
  if (!isPlainObject(raw)) throw new HarnessConfigurationError("Harness 导出必须为 JSON 对象");
  const unknownFields = Object.keys(raw).filter((key) => !["schemaVersion", "harnessVersion", "credentialRefs", "providers"].includes(key));
  if (unknownFields.length > 0) throw new HarnessConfigurationError("Harness 导出包含未知字段");
  if (raw.schemaVersion !== 1) throw new HarnessConfigurationError("不支持的 Harness 导出 schemaVersion");
  if (raw.harnessVersion !== expectedHarnessVersion) {
    throw new HarnessConfigurationError("Harness 版本不匹配安装清单");
  }
  if (!Array.isArray(raw.credentialRefs) || !raw.credentialRefs.every((value) => typeof value === "string" && credentialReferencePattern.test(value))) {
    throw new HarnessConfigurationError("Harness 导出的 credentialRefs 无效");
  }
  if (new Set(raw.credentialRefs).size !== raw.credentialRefs.length) {
    throw new HarnessConfigurationError("Harness 导出的 credentialRefs 包含重复引用");
  }
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new HarnessConfigurationError("Harness 导出未包含可用提供方");
  }
  const ids = new Set<string>();
  for (const provider of raw.providers) {
    if (!isPlainObject(provider) || typeof provider.id !== "string" || !catalogIdPattern.test(provider.id)
      || typeof provider.label !== "string" || !provider.label.trim() || provider.label.length > 120
      || !Array.isArray(provider.models) || provider.models.length === 0) {
      throw new HarnessConfigurationError("Harness 导出的 provider 结构无效");
    }
    rejectUnknownFields(provider, ["id", "label", "models"], "Harness 导出的 provider");
    if (ids.has(provider.id)) throw new HarnessConfigurationError("Harness 导出包含重复 provider");
    ids.add(provider.id);
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (!isPlainObject(model) || typeof model.id !== "string" || !catalogIdPattern.test(model.id)
        || typeof model.label !== "string" || !model.label.trim() || model.label.length > 120
        || !isPlainObject(model.capabilities)) {
        throw new HarnessConfigurationError("Harness 导出的 model 结构无效");
      }
      rejectUnknownFields(model, ["id", "label", "capabilities"], "Harness 导出的 model");
      if (modelIds.has(model.id)) throw new HarnessConfigurationError("Harness 导出包含重复 model");
      modelIds.add(model.id);
      const capabilities = model.capabilities;
      rejectUnknownFields(capabilities, [
        "reasoningEfforts", "temperature", "topP", "maxContextTokens", "maxOutputTokens",
        "maxTotalTokens", "providerOptions",
      ], "Harness 导出的模型能力");
      const validRange = (value: unknown) => value === undefined || (
        isPlainObject(value)
        && typeof value.minimum === "number" && Number.isFinite(value.minimum)
        && typeof value.maximum === "number" && Number.isFinite(value.maximum)
        && value.minimum <= value.maximum
      );
      for (const [rangeName, range] of [["temperature", capabilities.temperature], ["topP", capabilities.topP]] as const) {
        if (isPlainObject(range)) rejectUnknownFields(range, ["minimum", "maximum"], "Harness 导出的数值能力范围");
      }
      if (!Array.isArray(capabilities.reasoningEfforts)
        || !capabilities.reasoningEfforts.every((value) => ["low", "medium", "high"].includes(String(value)))
        || new Set(capabilities.reasoningEfforts).size !== capabilities.reasoningEfforts.length
        || !validRange(capabilities.temperature) || !validRange(capabilities.topP)
        || !Number.isInteger(capabilities.maxContextTokens) || Number(capabilities.maxContextTokens) <= 0
        || !Number.isInteger(capabilities.maxOutputTokens) || Number(capabilities.maxOutputTokens) <= 0
        || !Number.isInteger(capabilities.maxTotalTokens) || Number(capabilities.maxTotalTokens) <= 0
        || Number(capabilities.maxTotalTokens) < Number(capabilities.maxContextTokens) + Number(capabilities.maxOutputTokens)
        || !isPlainObject(capabilities.providerOptions)) {
        throw new HarnessConfigurationError("Harness 导出的模型能力无效");
      }
      for (const [optionName, capability] of Object.entries(capabilities.providerOptions)) {
        if (!providerOptionNamePattern.test(optionName) || !isPlainObject(capability) || !["boolean", "number", "string"].includes(String(capability.type))
          || (capability.type !== "number" && (capability.minimum !== undefined || capability.maximum !== undefined))
          || (capability.minimum !== undefined && (typeof capability.minimum !== "number" || !Number.isFinite(capability.minimum)))
          || (capability.maximum !== undefined && (typeof capability.maximum !== "number" || !Number.isFinite(capability.maximum)))
          || (typeof capability.minimum === "number" && typeof capability.maximum === "number" && capability.minimum > capability.maximum)) {
          throw new HarnessConfigurationError("Harness 导出的 provider option 能力无效");
        }
        rejectUnknownFields(capability, ["type", "minimum", "maximum"], "Harness 导出的 provider option 能力");
      }
    }
  }
  return structuredClone(raw) as unknown as HarnessModelCatalog;
}

export class ExportedHarnessConfigAdapter implements HarnessAdapter {
  private constructor(
    private readonly catalog: HarnessCatalogResponse,
    private readonly credentialRefs: ReadonlySet<string>,
    private readonly catalogIdentity: string,
  ) {}

  static fromFile(exportPath: string, expectedHarnessVersion: string): ExportedHarnessConfigAdapter {
    if (!expectedHarnessVersion) throw new HarnessConfigurationError("必须配置精确的 Harness 版本");
    let contents: string;
    try {
      contents = readFileSync(exportPath, "utf8");
    } catch (error) {
      throw new HarnessConfigurationError(`无法读取 Harness 导出：${error instanceof Error ? error.message : String(error)}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(contents); }
    catch { throw new HarnessConfigurationError("Harness 导出不是有效 JSON"); }
    const parsed = parseHarnessModelCatalog(raw, expectedHarnessVersion);
    const catalogIdentity = `sha256:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
    return new ExportedHarnessConfigAdapter(
      { credentialRefs: structuredClone(parsed.credentialRefs), providers: structuredClone(parsed.providers) },
      new Set(parsed.credentialRefs),
      catalogIdentity,
    );
  }

  listModels(): HarnessCatalogResponse {
    return structuredClone(this.catalog);
  }

  validateModelProfile(input: ModelProfileInput): ModelProfile {
    return validateAgainstCatalog(input, this.catalog, this.credentialRefs, this.catalogIdentity);
  }
}

export class DeterministicFakeHarnessAdapter implements HarnessAdapter {
  listModels(): HarnessCatalogResponse {
    return structuredClone(catalog);
  }

  validateModelProfile(input: ModelProfileInput): ModelProfile {
    return validateAgainstCatalog(input, catalog, fakeCredentialRefs, `sha256:${"0".repeat(64)}`);
  }

  async smokeModel(profile: ModelProfile): Promise<{ providerText?: string }> {
    return { providerText: `fake-smoke:${profile.providerId}/${profile.modelId}` };
  }

  async evolvePlugin(request: HarnessEvolutionRequest): Promise<HarnessEvolutionResponse> {
    const sourcePath = join(request.workspace, "src/index.ts");
    const mutationName = `fakeEvolution${createHash("sha256").update(`${request.role}:${request.attemptId}`).digest("hex").slice(0, 12)}`;
    const source = readFileSync(sourcePath, "utf8");
    if (!source.includes(`export const ${mutationName} =`)) {
      writeFileSync(sourcePath, `${source}\nexport const ${mutationName} = ${JSON.stringify(request.attemptId)};\n`);
    }
    return {
      hypothesis: `${request.role} 第 ${request.generation} 代确定性候选`,
      strategyPlan: `尝试 ${request.attemptId}，保持协议与资源边界。`,
      submitted: true,
      usage: { tokens: 100, cost: 0 },
      reasoning: "确定性假 Harness 已完成候选分析",
      toolActivity: "read,test,submit",
      execution: {
        kind: "fake",
        protocolVersion: HARNESS_EVOLUTION_PROTOCOL_VERSION,
        sessionId: request.sessionId,
        harnessVersion: "fake",
        providerId: request.modelProfile.providerId,
        modelId: request.modelProfile.modelId,
      },
    };
  }
}

export function createHarnessAgentEnvironments(root: string, experimentId: string): HarnessAgentEnvironments {
  const createEnvironment = (role: "generator" | "solver") => ({
    home: join(root, experimentId, role, "home"),
    workspace: join(root, experimentId, role, "workspace"),
  });
  return { generator: createEnvironment("generator"), solver: createEnvironment("solver") };
}
