import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  hashHarnessRuntimePayload,
  IsolatedHarnessCommandError,
  runIsolatedHarnessCommand,
  ExportedHarnessConfigAdapter,
  HARNESS_EVOLUTION_ALLOWED_TOOLS,
  HARNESS_EVOLUTION_PROTOCOL_VERSION,
  HARNESS_EVOLUTION_REQUEST_TYPE,
  HARNESS_EVOLUTION_RESPONSE_TYPE,
  HarnessConfigurationError,
  type HarnessAdapter,
  type HarnessEvolutionProtocolRequest,
  type HarnessEvolutionProtocolResponse,
  type HarnessEvolutionRequest,
  type HarnessEvolutionResponse,
  type HarnessExecutionIdentity,
  type HarnessExecutionKind,
} from "@maze-arena/dsh-integration";
import { HarnessInvocationError } from "./harness-invocation-error.js";

const DEFAULT_EVOLUTION_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_HYPOTHESIS_BYTES = 16 * 1024;
const MAX_STRATEGY_PLAN_BYTES = 64 * 1024;
const MAX_REASONING_BYTES = 128 * 1024;
const MAX_TOOL_ACTIVITY_BYTES = 128 * 1024;
const FORBIDDEN_INHERITED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "cache", ".cache", ".next", ".turbo", ".vite", "coverage", ".pnpm-store",
]);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ROLE_CONSTRAINTS = Object.freeze({
  generator: "仅改进当前 Generator Plugin 的允许源码与测试；不得修改求解器、Arena 协议、评测规则、依赖或 Harness 核心。",
  solver: "仅改进当前 Solver Plugin 的允许源码与测试；不得修改生成器、Arena 协议、评测规则、依赖或 Harness 核心。",
});

export function createProductionHarnessAdapter(environment: NodeJS.ProcessEnv): HarnessAdapter {
  const catalogPath = environment.ARENA_MODEL_CATALOG_PATH;
  const harnessVersion = environment.DSH_HARNESS_VERSION;
  const evolutionCommand = environment.DSH_EVOLUTION_COMMAND;
  const smokeCommand = environment.DSH_SMOKE_COMMAND;
  const unshareCommand = environment.DSH_UNSHARE_EXECUTABLE ?? "/usr/bin/unshare";
  const bubblewrapCommand = environment.DSH_BWRAP_EXECUTABLE ?? "/usr/bin/bwrap";
  if (environment.DSH_HARNESS_RUNTIME_ROOT && !environment.DSH_HARNESS_RUNTIME_SHA256) {
    throw new HarnessConfigurationError("生产 Harness runtime root 必须同时声明冻结载荷摘要");
  }
  if (!catalogPath || !harnessVersion || !evolutionCommand || !smokeCommand) {
    throw new HarnessConfigurationError("生产启动必须配置 ARENA_MODEL_CATALOG_PATH、DSH_HARNESS_VERSION、DSH_EVOLUTION_COMMAND 与 DSH_SMOKE_COMMAND");
  }
  const timeoutMs = parseTimeout(environment.DSH_EVOLUTION_TIMEOUT_MS);
  const executionKind = parseExecutionKind(environment.DSH_EVOLUTION_EXECUTION_KIND);
  const resolvedCatalogPath = resolve(catalogPath);
  const currentConfig = () => ExportedHarnessConfigAdapter.fromFile(resolvedCatalogPath, harnessVersion);
  return {
    listModels: () => currentConfig().listModels(),
    validateModelProfile: (input) => currentConfig().validateModelProfile(input),
    smokeModel: (profile) => runSmokeCommand(resolve(unshareCommand), resolve(bubblewrapCommand), resolve(smokeCommand), profile, timeoutMs, environment),
    evolvePlugin: (request) => runEvolutionCommand(
      resolve(unshareCommand), resolve(bubblewrapCommand), resolve(evolutionCommand), request, timeoutMs, harnessVersion, executionKind, environment,
    ),
  };
}

async function runEvolutionCommand(
  unshareCommand: string,
  bubblewrapCommand: string,
  command: string,
  request: HarnessEvolutionRequest,
  timeoutMs: number,
  harnessVersion: string,
  executionKind: HarnessExecutionKind,
  environment: NodeJS.ProcessEnv,
): Promise<HarnessEvolutionResponse> {
  assertEvolutionSessionRequest(request);
  const sessionId = request.sessionId;
  const protocolRequest: HarnessEvolutionProtocolRequest = {
    type: HARNESS_EVOLUTION_REQUEST_TYPE,
    protocolVersion: HARNESS_EVOLUTION_PROTOCOL_VERSION,
    session: {
      id: sessionId,
      home: resolve(request.home),
      workspace: resolve(request.workspace),
      role: request.role,
      roleConstraint: ROLE_CONSTRAINTS[request.role],
      allowedTools: HARNESS_EVOLUTION_ALLOWED_TOOLS,
    },
    attempt: {
      experimentId: request.experimentId,
      generation: request.generation,
      attemptId: request.attemptId,
      repairAttempt: request.repairAttempt,
      diagnostics: [...request.diagnostics],
    },
    modelProfile: structuredClone(request.modelProfile),
    input: structuredClone(request.input),
  };
  const execution: HarnessExecutionIdentity = {
    kind: executionKind,
    protocolVersion: HARNESS_EVOLUTION_PROTOCOL_VERSION,
    sessionId,
    harnessVersion,
    providerId: request.modelProfile.providerId,
    modelId: request.modelProfile.modelId,
  };
  try {
    const value = await runJsonCommand(unshareCommand, bubblewrapCommand, command, "evolve", protocolRequest, timeoutMs, request.signal, {
      cwd: request.workspace,
      sessionHome: request.home,
      globalHarnessHome: environment.DSH_HOME,
      harnessRuntimeRoot: environment.DSH_HARNESS_RUNTIME_ROOT,
      expectedRuntimePayloadSha256: environment.DSH_HARNESS_RUNTIME_SHA256,
      environment,
      sessionId,
    });
    const response = parseEvolutionResponse(value, sessionId, request.modelProfile.totalTokenLimit);
    return { ...response.result, usage: response.usage, execution };
  } catch (error) {
    throw withExecutionIdentity(error, execution);
  }
}

async function runSmokeCommand(
  unshareCommand: string,
  bubblewrapCommand: string,
  command: string,
  modelProfile: Parameters<NonNullable<HarnessAdapter["smokeModel"]>>[0],
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<{ providerText?: string }> {
  const value = await runJsonCommand(unshareCommand, bubblewrapCommand, command, "smoke", { modelProfile }, timeoutMs, undefined, {
    globalHarnessHome: environment.DSH_HOME,
    harnessRuntimeRoot: environment.DSH_HARNESS_RUNTIME_ROOT,
    expectedRuntimePayloadSha256: environment.DSH_HARNESS_RUNTIME_SHA256,
    environment,
  });
  if (!isPlainObject(value) || !Object.keys(value).every((key) => key === "providerText")
    || (value.providerText !== undefined && typeof value.providerText !== "string")) {
    throw new Error("DSH 冒烟进程响应字段非法");
  }
  return value as { providerText?: string };
}

async function runJsonCommand(
  unshareCommand: string,
  bubblewrapCommand: string,
  command: string,
  operation: "evolve" | "smoke",
  request: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  options: {
    cwd?: string;
    sessionHome?: string;
    globalHarnessHome?: string;
    harnessRuntimeRoot?: string;
    expectedRuntimePayloadSha256?: string;
    environment: NodeJS.ProcessEnv;
    sessionId?: string;
  } = { environment: process.env },
): Promise<unknown> {
  const serializedRequest = JSON.stringify(request);
  if (Buffer.byteLength(serializedRequest, "utf8") > MAX_REQUEST_BYTES) {
    throw new HarnessInvocationError(`DSH ${operation === "evolve" ? "自治" : "冒烟"}请求超过 1 MiB 限制`, "protocol");
  }
  const resolvedCommand = realpathSync(resolve(command));
  const runtimeRoot = options.harnessRuntimeRoot
    ? realpathSync(resolve(options.harnessRuntimeRoot))
    : realpathSync(dirname(resolvedCommand));
  const expectedRuntimePayloadSha256 = options.expectedRuntimePayloadSha256
    ?? hashHarnessRuntimePayload(runtimeRoot);
  const label = operation === "evolve" ? "自治" : "冒烟";
  let stdout: string;
  try {
    const result = await runIsolatedHarnessCommand({
      command: resolvedCommand,
      args: [],
      runtimeRoot,
      expectedRuntimePayloadSha256,
      environment: childEnvironment(options.environment, operation, options.sessionHome, options.globalHarnessHome, options.sessionId),
      timeoutMs,
      outputLimitBytes: MAX_PROCESS_OUTPUT_BYTES,
      stdin: serializedRequest,
      cwd: options.cwd,
      writablePaths: [options.sessionHome, options.cwd].filter((path): path is string => Boolean(path)),
      readOnlyPaths: options.globalHarnessHome ? [options.globalHarnessHome] : [],
      unshareCommand,
      bubblewrapCommand,
      signal,
    });
    stdout = result.stdout;
  } catch (error) {
    if (!(error instanceof IsolatedHarnessCommandError)) throw error;
    const kind = error.kind === "output" ? "protocol" : error.kind === "exit" ? "process" : error.kind;
    throw new HarnessInvocationError(`DSH ${label}进程${isolatedFailureDescription(error)}`, kind);
  }
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new HarnessInvocationError(`DSH ${label}进程未返回合法 JSON`, "protocol"); }
  return value;
}

function isolatedFailureDescription(error: IsolatedHarnessCommandError): string {
  if (error.kind === "cancelled") return "已取消";
  if (error.kind === "timeout") return "超过超时限制";
  if (error.kind === "output") return `失败：${error.message}`;
  if (error.kind === "exit") return `失败（退出码 ${error.exitCode ?? "未知"}）`;
  return `无法在隔离边界内执行：${error.message}`;
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  operation: "evolve" | "smoke",
  sessionHome?: string,
  globalHarnessHome?: string,
  sessionId?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = source[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.DSH_HARNESS_PROTOCOL = String(HARNESS_EVOLUTION_PROTOCOL_VERSION);
  environment.DSH_HARNESS_OPERATION = operation;
  environment.DSH_HARNESS_TOOL_POLICY = "locked";
  environment.DSH_HARNESS_ALLOWED_TOOLS = HARNESS_EVOLUTION_ALLOWED_TOOLS.join(",");
  if (globalHarnessHome) environment.DSH_GLOBAL_HOME = resolve(globalHarnessHome);
  if (sessionHome) {
    environment.DSH_HOME = resolve(sessionHome);
    environment.HOME = resolve(sessionHome);
    environment.TMPDIR = resolve(sessionHome);
  } else if (globalHarnessHome) {
    environment.DSH_HOME = resolve(globalHarnessHome);
  }
  if (sessionId) environment.DSH_HARNESS_SESSION_ID = sessionId;
  return environment;
}

function assertEvolutionSessionRequest(request: HarnessEvolutionRequest): void {
  if (!request.experimentId || !request.attemptId || !Number.isSafeInteger(request.generation) || request.generation < 1
    || !Number.isSafeInteger(request.repairAttempt) || request.repairAttempt < 0
    || !SESSION_ID_PATTERN.test(request.sessionId)) {
    throw new Error("DSH 自治会话坐标非法");
  }
  const home = resolve(request.home);
  const workspace = resolve(request.workspace);
  if (home === workspace || isNestedPath(home, workspace) || isNestedPath(workspace, home)) {
    throw new Error("DSH 自治会话 home 与工作区必须相互独立");
  }
  assertDirectory(home, "Harness home");
  assertDirectory(workspace, "候选工作区");
  if (request.repairAttempt === 0) {
    if (readdirSync(home).length > 0) throw new Error("新的 DSH 自治会话必须使用空 Harness home");
    assertNoInheritedState(workspace);
  }
  if (request.input.role !== request.role || resolve(request.input.championRoot) !== workspace) {
    throw new Error("DSH 自治输入角色或冠军工作区与会话边界不一致");
  }
  if (request.allowedTools.length !== HARNESS_EVOLUTION_ALLOWED_TOOLS.length
    || request.allowedTools.some((tool, index) => tool !== HARNESS_EVOLUTION_ALLOWED_TOOLS[index])) {
    throw new Error("DSH 自治会话工具白名单与冻结策略不一致");
  }
}

function isNestedPath(parent: string, candidate: string): boolean {
  const local = relative(parent, candidate);
  return Boolean(local) && !local.startsWith("..") && !isAbsolute(local);
}

function assertDirectory(path: string, label: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error(`${label} 不存在`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 必须为真实目录`);
}

function assertNoInheritedState(current: string, root = current, canonicalRoot = realpathSync(root)): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (FORBIDDEN_INHERITED_DIRECTORIES.has(entry.name)) {
      throw new Error(`候选工作区继承了禁止目录：${entry.name}`);
    }
    if (entry.isSymbolicLink()) throw new Error("候选工作区不得包含符号链接");
    const path = join(current, entry.name);
    const local = relative(canonicalRoot, realpathSync(path));
    if (local === ".." || local.startsWith("../") || isAbsolute(local)) throw new Error("候选工作区路径越界");
    if (entry.isDirectory()) assertNoInheritedState(path, root, canonicalRoot);
    else if (!entry.isFile()) throw new Error("候选工作区不得包含特殊文件");
  }
}

function parseEvolutionResponse(
  value: unknown,
  sessionId: string,
  tokenLimit: number,
): HarnessEvolutionProtocolResponse {
  if (!isPlainObject(value)) throw protocolError();
  const response = value as Record<string, unknown>;
  if (response.type !== HARNESS_EVOLUTION_RESPONSE_TYPE
    || response.protocolVersion !== HARNESS_EVOLUTION_PROTOCOL_VERSION
    || response.sessionId !== sessionId
    || !isPlainObject(response.usage)) {
    throw protocolError();
  }
  const usage = response.usage as Record<string, unknown>;
  const parsedUsage = parseUsage(usage, tokenLimit);
  if (exactFields(response, ["type", "protocolVersion", "sessionId", "error", "usage"])) {
    if (!isPlainObject(response.error)) throw protocolError(parsedUsage);
    const error = response.error as Record<string, unknown>;
    if (!exactFields(error, ["kind", "code"])
      || !["transient-provider", "provider"].includes(String(error.kind))
      || typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) throw protocolError(parsedUsage);
    throw new HarnessInvocationError(
      `DSH 自治调用失败（${error.kind === "transient-provider" ? "瞬态提供方故障" : "提供方故障"}：${error.code}）`,
      error.kind as "transient-provider" | "provider",
      parsedUsage,
    );
  }
  if (!exactFields(response, ["type", "protocolVersion", "sessionId", "result", "usage"])
    || !isPlainObject(response.result)) throw protocolError(parsedUsage);
  const result = response.result as Record<string, unknown>;
  if (!exactOptionalFields(result, ["hypothesis", "strategyPlan", "submitted"], ["reasoning", "toolActivity"])
    || typeof result.hypothesis !== "string" || typeof result.strategyPlan !== "string"
    || typeof result.submitted !== "boolean"
    || !boundedString(result.hypothesis, MAX_HYPOTHESIS_BYTES)
    || !boundedString(result.strategyPlan, MAX_STRATEGY_PLAN_BYTES)
    || (result.reasoning !== undefined && (typeof result.reasoning !== "string" || !boundedString(result.reasoning, MAX_REASONING_BYTES)))
    || (result.toolActivity !== undefined && (typeof result.toolActivity !== "string" || !boundedString(result.toolActivity, MAX_TOOL_ACTIVITY_BYTES)))) {
    throw protocolError(parsedUsage);
  }
  return value as unknown as HarnessEvolutionProtocolResponse;
}

function parseUsage(usage: Record<string, unknown>, tokenLimit: number): { tokens: number; cost: number } {
  if (!exactFields(usage, ["tokens", "cost"])
    || !Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0 || Number(usage.tokens) > tokenLimit
    || typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || Number(usage.cost) < 0) throw protocolError();
  return { tokens: Number(usage.tokens), cost: Number(usage.cost) };
}

function protocolError(usage?: { tokens: number; cost: number }): HarnessInvocationError {
  return new HarnessInvocationError("DSH 自治进程响应字段非法", "protocol", usage);
}

function withExecutionIdentity(error: unknown, execution: HarnessExecutionIdentity): HarnessInvocationError {
  if (error instanceof HarnessInvocationError) {
    return new HarnessInvocationError(error.message, error.kind, error.usage, execution);
  }
  return new HarnessInvocationError(
    error instanceof Error ? error.message : "DSH 自治调用失败",
    "process",
    undefined,
    execution,
  );
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function exactOptionalFields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => required.includes(field) || optional.includes(field));
}

function boundedString(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseExecutionKind(value: string | undefined): HarnessExecutionKind {
  if (value === undefined || value === "real-provider") return "real-provider";
  if (value === "deterministic-fixture") return value;
  throw new HarnessConfigurationError("DSH_EVOLUTION_EXECUTION_KIND 只允许 real-provider 或 deterministic-fixture");
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_EVOLUTION_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new HarnessConfigurationError("DSH_EVOLUTION_TIMEOUT_MS 必须为 1000 到 600000 之间的整数毫秒数");
  }
  return parsed;
}
