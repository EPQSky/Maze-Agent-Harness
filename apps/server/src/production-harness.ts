import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  credentialEnvironmentNameFromReference,
  hashHarnessRuntimePayload,
  IsolatedHarnessCommandError,
  runIsolatedHarnessCommand,
  ExportedHarnessConfigAdapter,
  HARNESS_EVOLUTION_ALLOWED_TOOLS,
  HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS,
  HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES,
  HARNESS_EVOLUTION_MAX_LINEAGE_PLANS,
  HARNESS_EVOLUTION_MAX_PUBLIC_TRACES,
  HARNESS_EVOLUTION_MAX_REQUEST_BYTES,
  HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES,
  HARNESS_EVOLUTION_MAX_TRACE_EVENTS,
  HARNESS_EVOLUTION_MAX_TRACE_METRICS,
  HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS,
  HARNESS_EVOLUTION_PROTOCOL_VERSION,
  HARNESS_EVOLUTION_REQUEST_TYPE,
  HARNESS_EVOLUTION_RESPONSE_TYPE,
  harnessEvolutionTrustedInputBytes,
  HarnessConfigurationError,
  type HarnessAdapter,
  type HarnessEvolutionProtocolRequest,
  type HarnessEvolutionProtocolResponse,
  type HarnessEvolutionRequest,
  type HarnessEvolutionResponse,
  type HarnessExecutionIdentity,
  type HarnessExecutionKind,
} from "@maze-arena/dsh-integration";
import {
  HarnessInvocationError,
  type HarnessFailureFacts,
  type HarnessDiagnosticSummary,
  type HarnessLocalFailureSummary,
} from "./harness-invocation-error.js";

const DEFAULT_EVOLUTION_ACTIVITY_TIMEOUT_MS = 120_000;
// 与 SDK adapter 的 smoke 回合预算保持一致，覆盖官方 readiness prompt 的内部回合。
const SMOKE_MAX_MODEL_CALLS = 2;
const MAX_EVOLUTION_TOTAL_TIMEOUT_MS = 30 * 60_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_HYPOTHESIS_BYTES = 16 * 1024;
const MAX_RESPONSE_STRATEGY_PLAN_BYTES = 64 * 1024;
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
  const modelReleaseSha256 = environment.ARENA_MODEL_RELEASE_SHA256;
  if (environment.DSH_HARNESS_RUNTIME_ROOT && !environment.DSH_HARNESS_RUNTIME_SHA256) {
    throw new HarnessConfigurationError("生产 Harness runtime root 必须同时声明冻结载荷摘要");
  }
  if (!catalogPath || !harnessVersion || !evolutionCommand || !smokeCommand || !modelReleaseSha256) {
    throw new HarnessConfigurationError("生产启动必须配置 ARENA_MODEL_CATALOG_PATH、DSH_HARNESS_VERSION、DSH_EVOLUTION_COMMAND 与 DSH_SMOKE_COMMAND");
  }
  const timeoutMs = parseTimeout(environment.DSH_EVOLUTION_TIMEOUT_MS);
  const executionKind = parseExecutionKind(environment.DSH_EVOLUTION_EXECUTION_KIND);
  const resolvedCatalogPath = resolve(catalogPath);
  const currentConfig = () => {
    assertFrozenModelRelease(environment, resolvedCatalogPath, modelReleaseSha256);
    return ExportedHarnessConfigAdapter.fromFile(resolvedCatalogPath, harnessVersion);
  };
  return {
    listModels: () => currentConfig().listModels(),
    validateModelProfile: (input) => currentConfig().validateModelProfile(input),
    smokeModel: (profile) => {
      assertFrozenModelRelease(environment, resolvedCatalogPath, modelReleaseSha256);
      return runSmokeCommand(
        resolve(unshareCommand),
        resolve(bubblewrapCommand),
        resolve(smokeCommand),
        profile,
        timeoutMs,
        executionKind,
        environment,
      );
    },
    evolvePlugin: (request) => runEvolutionCommand(
        resolve(unshareCommand), resolve(bubblewrapCommand), resolve(evolutionCommand), request, timeoutMs, harnessVersion, executionKind, environment,
        () => assertFrozenModelRelease(environment, resolvedCatalogPath, modelReleaseSha256),
      ),
  };
}

interface SmokeSessionCleanupOperations {
  chmodSync(path: string, mode: number): void;
  lstatSync(path: string): Stats;
  readdirSync(path: string): string[];
  rmSync(path: string, options: { recursive: true; force: true }): void;
}

interface SmokeSessionLifecycleOperations extends SmokeSessionCleanupOperations {
  mkdtempSync(prefix: string): string;
}

const smokeSessionCleanupOperations: SmokeSessionCleanupOperations = {
  chmodSync,
  lstatSync,
  readdirSync: (path) => readdirSync(path),
  rmSync,
};

const smokeSessionLifecycleOperations: SmokeSessionLifecycleOperations = {
  ...smokeSessionCleanupOperations,
  mkdtempSync,
};

export function cleanupSmokeSessionHome(
  sessionHome: string,
  overrides: Partial<SmokeSessionCleanupOperations> = {},
): void {
  const operations = { ...smokeSessionCleanupOperations, ...overrides };
  const cleanupErrors: unknown[] = [];
  const restoreAccess = (path: string): void => {
    let stat: Stats;
    try { stat = operations.lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      cleanupErrors.push(error);
      return;
    }
    if (stat.isSymbolicLink()) return;
    try { operations.chmodSync(path, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600)); }
    catch (error) { cleanupErrors.push(error); }
    if (!stat.isDirectory()) return;
    let entries: string[];
    try { entries = operations.readdirSync(path); }
    catch (error) {
      cleanupErrors.push(error);
      return;
    }
    for (const entry of entries) restoreAccess(join(path, entry));
  };
  const stillExists = (): boolean => {
    try {
      operations.lstatSync(sessionHome);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      cleanupErrors.push(error);
      return true;
    }
  };

  restoreAccess(sessionHome);
  try { operations.rmSync(sessionHome, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  if (stillExists()) {
    // 首次权限恢复或删除失败后仍做一次完整收敛，避免可恢复错误留下私有会话目录。
    restoreAccess(sessionHome);
    try { operations.rmSync(sessionHome, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (stillExists()) cleanupErrors.push(new Error("DSH 冒烟 Session home 清理后仍然存在"));
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "DSH 冒烟 Session home 清理失败");
}

export async function withSmokeSessionHome<T>(
  operation: (sessionHome: string) => Promise<T>,
  overrides: Partial<SmokeSessionLifecycleOperations> = {},
): Promise<T> {
  const operations = { ...smokeSessionLifecycleOperations, ...overrides };
  const sessionHome = operations.mkdtempSync(join(tmpdir(), "maze-dsh-smoke-"));
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    operations.chmodSync(sessionHome, 0o700);
    result = await operation(sessionHome);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    cleanupSmokeSessionHome(sessionHome, operations);
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError([operationError, cleanupError], "DSH 冒烟失败且 Session home 清理失败");
    }
    throw cleanupError;
  }
  if (operationFailed) throw operationError;
  return result as T;
}

function assertFrozenModelRelease(environment: NodeJS.ProcessEnv, catalogPath: string, expectedSha256: string): void {
  const exportPath = environment.DSH_MODEL_EXPORT_PATH;
  const settingsPath = environment.DSH_MODEL_SETTINGS_PATH;
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !exportPath || !settingsPath) {
    throw new HarnessConfigurationError("生产模型发布缺少聚合摘要或三文件路径");
  }
  const resolved = [catalogPath, resolve(exportPath), resolve(settingsPath)];
  const root = dirname(catalogPath);
  if (resolved.some((path) => dirname(path) !== root)
    || resolved.map((path) => basename(path)).join("\n") !== "catalog.json\nmodel-export.json\nsettings.yaml") {
    throw new HarnessConfigurationError("生产模型发布三文件必须来自同一实例快照");
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o500) {
    throw new HarnessConfigurationError("生产模型发布实例目录权限已漂移");
  }
  const contents = resolved.map((path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) {
      throw new HarnessConfigurationError("生产模型发布实例文件权限已漂移");
    }
    return readFileSync(path);
  });
  const actual = createHash("sha256").update(contents[0]!).update("\0").update(contents[1]!)
    .update("\0").update(contents[2]!).digest("hex");
  if (actual !== expectedSha256) throw new HarnessConfigurationError("生产模型发布实例摘要已漂移");
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
  assertCurrentModelRelease: () => void,
): Promise<HarnessEvolutionResponse> {
  const execution: HarnessExecutionIdentity = {
    kind: executionKind,
    protocolVersion: HARNESS_EVOLUTION_PROTOCOL_VERSION,
    sessionId: request.sessionId,
    harnessVersion,
    providerId: request.modelProfile.providerId,
    modelId: request.modelProfile.modelId,
  };
  // 每次 invocation 使用一次性路径与 nonce，retry 不得复用旧诊断文件。
  const diagnosticNonce = randomUUID();
  const diagnosticPath = join(resolve(request.home), `.maze-arena-dsh-diagnostic-${diagnosticNonce}.json`);
  rmSync(diagnosticPath, { force: true });
  try {
    assertCurrentModelRelease();
    assertEvolutionSessionRequest(request);
    if (executionKind === "real-provider" && !request.budgetLedger) {
      throw new HarnessInvocationError("真实 Provider 缺少 SQLite 父角色预算账本", "process", undefined, execution,
        "PARENT_BUDGET_LEDGER_MISSING");
    }
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
      ...(request.budget ? { budget: { ...request.budget, maxModelCalls: request.budget.maxModelCalls ?? 8 } } : {}),
      input: structuredClone(request.input),
    };
    const totalTimeoutMs = executionKind === "real-provider"
      ? evolutionTotalTimeout(timeoutMs, request.budget?.maxModelCalls ?? 8) : timeoutMs;
    const value = await runJsonCommand(unshareCommand, bubblewrapCommand, command, "evolve", protocolRequest, totalTimeoutMs, request.signal, {
      cwd: request.workspace,
      sessionHome: request.home,
      globalHarnessHome: environment.DSH_HOME,
      harnessRuntimeRoot: environment.DSH_HARNESS_RUNTIME_ROOT,
      expectedRuntimePayloadSha256: environment.DSH_HARNESS_RUNTIME_SHA256,
      environment,
      sessionId,
      credentialName: credentialEnvironmentName(request.modelProfile.credentialRef),
      budgetLedger: request.budgetLedger,
      diagnosticPath,
      diagnosticNonce,
    });
    const response = parseEvolutionResponse(
      value,
      sessionId,
      request.budget?.maxTokens ?? request.modelProfile.totalTokenLimit,
      request.budget?.maxCost,
      diagnosticNonce,
    );
    return {
      ...response.result,
      usage: response.usage,
      execution: response.costPolicyId ? { ...execution, costPolicyId: response.costPolicyId } : execution,
    };
  } catch (error) {
    // session home 可被隔离子进程写入，文件摘要不是可信审计来源；只接受 adapter 响应内的摘要。
    const diagnostic = error instanceof HarnessInvocationError ? error.diagnostic : undefined;
    throw withExecutionIdentity(error, execution, diagnostic);
  } finally {
    rmSync(diagnosticPath, { force: true });
  }
}

async function runSmokeCommand(
  unshareCommand: string,
  bubblewrapCommand: string,
  command: string,
  modelProfile: Parameters<NonNullable<HarnessAdapter["smokeModel"]>>[0],
  timeoutMs: number,
  executionKind: HarnessExecutionKind,
  environment: NodeJS.ProcessEnv,
): Promise<{ providerText?: string; usage: { tokens: number; cost: number; modelCalls: number } }> {
  const totalTimeoutMs = executionKind === "real-provider"
    ? evolutionTotalTimeout(timeoutMs, SMOKE_MAX_MODEL_CALLS) : timeoutMs;
  let diagnosticNonce = "";
  const value = await withSmokeSessionHome(async (sessionHome) => {
    diagnosticNonce = randomUUID();
    const diagnosticPath = join(sessionHome, `.maze-arena-dsh-diagnostic-${diagnosticNonce}.json`);
    return runJsonCommand(unshareCommand, bubblewrapCommand, command, "smoke", { modelProfile },
      totalTimeoutMs, undefined, {
        sessionHome,
        globalHarnessHome: environment.DSH_HOME,
        harnessRuntimeRoot: environment.DSH_HARNESS_RUNTIME_ROOT,
        expectedRuntimePayloadSha256: environment.DSH_HARNESS_RUNTIME_SHA256,
        environment,
        credentialName: credentialEnvironmentName(modelProfile.credentialRef),
        diagnosticPath,
        diagnosticNonce,
      });
  });
  if (!isPlainObject(value) || value.type !== "maze-arena.harness-smoke.response" || value.protocolVersion !== 1
    || !isPlainObject(value.usage)) {
    throw new Error("DSH 冒烟进程响应字段非法");
  }
  const usage = parseUsage(value.usage as Record<string, unknown>, modelProfile.totalTokenLimit);
  const smokeDiagnostic = parseDiagnosticSummary(value.diagnostic, { diagnosticNonce });
  if (Object.hasOwn(value, "diagnostic") && smokeDiagnostic === undefined) {
    throw new HarnessInvocationError("DSH 冒烟进程诊断摘要非法", "protocol", usage, undefined, "DIAGNOSTIC_INVALID");
  }
  if (exactFields(value, ["type", "protocolVersion", "error", "usage"])
    || exactFields(value, ["type", "protocolVersion", "error", "usage", "diagnostic"])) {
    const responseFailureFacts = isPlainObject(value.error) ? parseFailureFacts(value.error.failureFacts) : undefined;
    if (!isPlainObject(value.error) || !exactOptionalFields(value.error, ["kind", "code"], ["failureFacts"])
      || !["transient-provider", "provider", "protocol", "process"].includes(String(value.error.kind))
      || typeof value.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code)
      || (Object.hasOwn(value.error, "failureFacts") && responseFailureFacts === undefined)) {
      throw new HarnessInvocationError("DSH 冒烟进程响应字段非法", "protocol", usage);
    }
    throw new HarnessInvocationError(
      `DSH 冒烟调用失败（${failureKindLabel(String(value.error.kind))}：${value.error.code}）`,
      value.error.kind as "transient-provider" | "provider" | "protocol" | "process",
      usage,
      undefined,
      value.error.code,
      undefined,
      false,
      smokeDiagnostic,
      responseFailureFacts,
    );
  }
  if (!exactOptionalFields(value, ["type", "protocolVersion", "result", "usage"], ["costPolicyId"])
    || !isPlainObject(value.result) || !Object.keys(value.result).every((key) => key === "providerText")
    || (value.result.providerText !== undefined && typeof value.result.providerText !== "string")) {
    throw new HarnessInvocationError("DSH 冒烟进程响应字段非法", "protocol", usage);
  }
  return { ...(value.result as { providerText?: string }), usage };
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
    credentialName?: string;
    budgetLedger?: HarnessEvolutionRequest["budgetLedger"];
    diagnosticPath?: string;
    diagnosticNonce?: string;
  } = { environment: process.env },
): Promise<unknown> {
  const serializedRequest = JSON.stringify(request);
  if (Buffer.byteLength(serializedRequest, "utf8") >= HARNESS_EVOLUTION_MAX_REQUEST_BYTES) {
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
    const modelExportPath = options.environment.DSH_MODEL_EXPORT_PATH
      ?? (options.globalHarnessHome ? join(options.globalHarnessHome, "model-export.json") : undefined);
    const modelSettingsPath = options.environment.DSH_MODEL_SETTINGS_PATH;
    const credentialDocument = credentialCapabilityDocument(options.environment, options.credentialName);
    const result = await runIsolatedHarnessCommand({
      command: resolvedCommand,
      args: [operation],
      runtimeRoot,
      expectedRuntimePayloadSha256,
      environment: childEnvironment(
        options.environment,
        operation,
        options.sessionHome,
        options.globalHarnessHome,
        options.sessionId,
        credentialDocument !== undefined,
        options.budgetLedger !== undefined,
        options.diagnosticPath,
        options.diagnosticNonce,
      ),
      timeoutMs,
      outputLimitBytes: MAX_PROCESS_OUTPUT_BYTES,
      stdin: serializedRequest,
      cwd: options.cwd,
      writablePaths: [options.sessionHome, options.cwd].filter((path): path is string => Boolean(path)),
      readOnlyPaths: [modelExportPath, modelSettingsPath].filter((path): path is string => Boolean(path && existsSync(path))),
      privateReadOnlyContents: credentialDocument,
      privateDuplexHandler: options.budgetLedger ? budgetLedgerHandler(options.budgetLedger) : undefined,
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
  catch {
    throw new HarnessInvocationError(`DSH ${label}进程未返回合法 JSON`, "protocol", undefined, undefined,
      "PROCESS_RESPONSE_JSON_INVALID");
  }
  return value;
}

function budgetLedgerHandler(ledger: NonNullable<HarnessEvolutionRequest["budgetLedger"]>): (request: unknown) => unknown {
  return (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("预算事务请求非法");
    const value = request as Record<string, unknown>;
    if (value.operation === "reserve-provider" && Object.keys(value).sort().join(",") === "cost,operation,tokens"
      && Number.isSafeInteger(value.tokens) && Number(value.tokens) > 0
      && typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost > 0) {
      return ledger.reserveProviderAttempt({ tokens: Number(value.tokens), cost: value.cost });
    }
    if (value.operation === "settle-provider" && Object.keys(value).sort().join(",") === "cost,operation,reservationId,tokens"
      && typeof value.reservationId === "string" && value.reservationId.length > 0
      && Number.isSafeInteger(value.tokens) && Number(value.tokens) >= 0
      && typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0) {
      ledger.settleProviderAttempt(value.reservationId, { tokens: Number(value.tokens), cost: value.cost });
      return true;
    }
    if (value.operation === "reserve-tool" && Object.keys(value).length === 1) {
      return ledger.reserveTopLevelToolCall();
    }
    throw new Error("预算事务请求非法");
  };
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
  hasCredentialCapability = false,
  hasBudgetLedgerCapability = false,
  diagnosticPath?: string,
  diagnosticNonce?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "DSH_MODEL_EXPORT_PATH", "DSH_MODEL_SETTINGS_PATH"]) {
    const value = source[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.DSH_HARNESS_PROTOCOL = String(HARNESS_EVOLUTION_PROTOCOL_VERSION);
  environment.DSH_HARNESS_OPERATION = operation;
  environment.DSH_HARNESS_TOOL_POLICY = "locked";
  environment.DSH_HARNESS_ALLOWED_TOOLS = HARNESS_EVOLUTION_ALLOWED_TOOLS.join(",");
  if (hasCredentialCapability) environment.DSH_CREDENTIAL_FD = "4";
  if (hasBudgetLedgerCapability) environment.DSH_BUDGET_LEDGER_FD = "5";
  if (!environment.DSH_MODEL_EXPORT_PATH && globalHarnessHome && existsSync(join(globalHarnessHome, "model-export.json"))) {
    environment.DSH_MODEL_EXPORT_PATH = join(globalHarnessHome, "model-export.json");
  }
  if (sessionHome) {
    environment.DSH_HOME = resolve(sessionHome);
    environment.HOME = resolve(sessionHome);
    environment.TMPDIR = resolve(sessionHome);
  } else if (globalHarnessHome) {
    environment.DSH_HOME = resolve(globalHarnessHome);
  }
  if (sessionId) environment.DSH_HARNESS_SESSION_ID = sessionId;
  if (diagnosticPath) environment.DSH_DIAGNOSTIC_PATH = resolve(diagnosticPath);
  if (diagnosticNonce) environment.DSH_DIAGNOSTIC_NONCE = diagnosticNonce;
  return environment;
}

function credentialEnvironmentName(reference: string): string {
  try { return credentialEnvironmentNameFromReference(reference); }
  catch (error) {
    throw new HarnessInvocationError(error instanceof Error ? error.message : "DSH 凭据引用格式无效", "protocol");
  }
}

function credentialCapabilityDocument(environment: NodeJS.ProcessEnv, name?: string): string | undefined {
  if (!name) return undefined;
  const value = environment[name];
  if (!value) return undefined;
  const document = `version: 1\nrefs:\n  ${name}: ${JSON.stringify(value)}\nrecords: {}\n`;
  if (Buffer.byteLength(document, "utf8") > 64 * 1024) {
    throw new HarnessInvocationError(`DSH 凭据 ${name} 超过 64 KiB 限制`, "provider");
  }
  return document;
}

function assertEvolutionSessionRequest(request: HarnessEvolutionRequest): void {
  if (!request.experimentId || !request.attemptId || !Number.isSafeInteger(request.generation) || request.generation < 1
    || !Number.isSafeInteger(request.repairAttempt) || request.repairAttempt < 0
    || !SESSION_ID_PATTERN.test(request.sessionId)) {
    throw new Error("DSH 自治会话坐标非法");
  }
  if (request.budget && (!Number.isSafeInteger(request.budget.maxTokens) || request.budget.maxTokens < 1
    || !Number.isFinite(request.budget.maxCost) || request.budget.maxCost <= 0
    || (request.budget.maxModelCalls !== undefined
      && (!Number.isSafeInteger(request.budget.maxModelCalls) || request.budget.maxModelCalls < 1 || request.budget.maxModelCalls > 8)))) {
    throw new HarnessInvocationError("DSH 自治调用聚合剩余预算非法", "protocol");
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
  assertTrustedFeedback(request.input, request.generation, request.role);
  if (request.allowedTools.length !== HARNESS_EVOLUTION_ALLOWED_TOOLS.length
    || request.allowedTools.some((tool, index) => tool !== HARNESS_EVOLUTION_ALLOWED_TOOLS[index])) {
    throw new Error("DSH 自治会话工具白名单与冻结策略不一致");
  }
}

function assertTrustedFeedback(
  input: HarnessEvolutionRequest["input"],
  currentGeneration: number,
  role: HarnessEvolutionRequest["role"],
): void {
  if (!exactFields(input as unknown as Record<string, unknown>, [
    "role", "championRoot", "lineagePlans", "trustedResults", "publicTraces", "hiddenAggregate",
  ]) || harnessEvolutionTrustedInputBytes(input) > HARNESS_EVOLUTION_MAX_FEEDBACK_BYTES
    || !Array.isArray(input.lineagePlans) || input.lineagePlans.length > HARNESS_EVOLUTION_MAX_LINEAGE_PLANS
    || !Array.isArray(input.trustedResults)
    || input.trustedResults.length > HARNESS_EVOLUTION_MAX_TRUSTED_RESULTS
    || !Array.isArray(input.publicTraces) || input.publicTraces.length > HARNESS_EVOLUTION_MAX_PUBLIC_TRACES
    || !isPlainObject(input.hiddenAggregate)) feedbackError();
  for (const plan of input.lineagePlans) {
    if (!isPlainObject(plan) || !exactFields(plan, ["attemptId", "strategyPlan"])
      || !feedbackId(plan.attemptId) || typeof plan.strategyPlan !== "string"
      || !boundedString(plan.strategyPlan, HARNESS_EVOLUTION_MAX_STRATEGY_PLAN_BYTES)) feedbackError();
  }
  const resultsByAttempt = new Map<string, number>();
  const completedResults: Array<Record<string, unknown>> = [];
  let previousResultGeneration = 0;
  for (const result of input.trustedResults) {
    if (!isPlainObject(result) || !exactOptionalFields(result,
      ["attemptId", "generation", "role", "outcome", "publicCaseCount", "hiddenCaseCount", "totalCandidateAggregate"],
      ["hiddenCandidateAggregate"])
      || !feedbackId(result.attemptId) || !positiveInteger(result.generation)
      || Number(result.generation) >= currentGeneration
      || result.role !== role
      || result.attemptId !== feedbackAttemptId(Number(result.generation), role)
      || !["promoted", "failed", "tie"].includes(String(result.outcome))
      || !nonNegativeInteger(result.publicCaseCount) || !nonNegativeInteger(result.hiddenCaseCount)
      || !numericRecord(result.totalCandidateAggregate, HARNESS_EVOLUTION_MAX_AGGREGATE_METRICS)
      || Number(result.generation) <= previousResultGeneration
      || (Object.hasOwn(result, "hiddenCandidateAggregate")
        && (Number(result.hiddenCaseCount) === 0 || !hiddenMetricRecord(result.hiddenCandidateAggregate, role)))
      || resultsByAttempt.has(String(result.attemptId))) feedbackError();
    previousResultGeneration = Number(result.generation);
    resultsByAttempt.set(String(result.attemptId), Number(result.generation));
    if (Number(result.hiddenCaseCount) > 0) completedResults.push(result);
  }
  for (const plan of input.lineagePlans) if (!resultsByAttempt.has(plan.attemptId)) feedbackError();
  const traceIdentities = new Set<string>();
  for (const trace of input.publicTraces) {
    const traceIdentity = isPlainObject(trace) ? `${String(trace.attemptId)}\0${String(trace.traceId)}` : "";
    if (!isPlainObject(trace) || !exactFields(trace, ["attemptId", "generation", "traceId", "outcome", "metrics", "events"])
      || !feedbackId(trace.attemptId) || !positiveInteger(trace.generation) || !feedbackId(trace.traceId)
      || resultsByAttempt.get(String(trace.attemptId)) !== Number(trace.generation)
      || !["success", "failure", "tie"].includes(String(trace.outcome))
      || !numericRecord(trace.metrics, HARNESS_EVOLUTION_MAX_TRACE_METRICS)
      || !Array.isArray(trace.events) || trace.events.length > HARNESS_EVOLUTION_MAX_TRACE_EVENTS
      || traceIdentities.has(traceIdentity)) feedbackError();
    traceIdentities.add(traceIdentity);
    trace.events.forEach(assertPublicFeedbackEvent);
  }
  const hidden = input.hiddenAggregate as unknown as Record<string, unknown>;
  const completedAttemptCount = Number(hidden.completedAttemptCount);
  const metricAvailableAttemptCount = Number(hidden.metricAvailableAttemptCount);
  const metricUnavailableAttemptCount = Number(hidden.metricUnavailableAttemptCount);
  const promotedAttemptCount = Number(hidden.promotedAttemptCount);
  const failedAttemptCount = Number(hidden.failedAttemptCount);
  const tieAttemptCount = Number(hidden.tieAttemptCount);
  const expectedMetricTotals: Record<string, number> = {};
  let expectedHiddenCaseCount = 0;
  let expectedMetricAvailableCount = 0;
  for (const result of completedResults) {
    expectedHiddenCaseCount = safeFeedbackCountSum(expectedHiddenCaseCount, Number(result.hiddenCaseCount));
    if (!Object.hasOwn(result, "hiddenCandidateAggregate")) continue;
    expectedMetricAvailableCount += 1;
    for (const [metric, value] of Object.entries(result.hiddenCandidateAggregate as Record<string, number>)) {
      expectedMetricTotals[metric] = finiteFeedbackMetricSum(expectedMetricTotals[metric] ?? 0, value);
    }
  }
  const expectedPromotedCount = completedResults.filter(({ outcome }) => outcome === "promoted").length;
  const expectedFailedCount = completedResults.filter(({ outcome }) => outcome === "failed").length;
  const expectedTieCount = completedResults.filter(({ outcome }) => outcome === "tie").length;
  if (!exactFields(hidden, ["completedAttemptCount", "metricAvailableAttemptCount", "metricUnavailableAttemptCount", "promotedAttemptCount", "failedAttemptCount", "tieAttemptCount", "evaluatedHiddenCaseCount", "metricTotals"])
    || !nonNegativeInteger(hidden.completedAttemptCount) || !nonNegativeInteger(hidden.metricAvailableAttemptCount)
    || !nonNegativeInteger(hidden.metricUnavailableAttemptCount)
    || metricAvailableAttemptCount + metricUnavailableAttemptCount !== completedAttemptCount
    || !nonNegativeInteger(hidden.promotedAttemptCount)
    || !nonNegativeInteger(hidden.failedAttemptCount) || !nonNegativeInteger(hidden.tieAttemptCount)
    || promotedAttemptCount + failedAttemptCount + tieAttemptCount !== completedAttemptCount
    || !nonNegativeInteger(hidden.evaluatedHiddenCaseCount) || !hiddenMetricRecord(hidden.metricTotals, role)
    || completedAttemptCount !== completedResults.length
    || metricAvailableAttemptCount !== expectedMetricAvailableCount
    || metricUnavailableAttemptCount !== completedResults.length - expectedMetricAvailableCount
    || promotedAttemptCount !== expectedPromotedCount || failedAttemptCount !== expectedFailedCount
    || tieAttemptCount !== expectedTieCount || Number(hidden.evaluatedHiddenCaseCount) !== expectedHiddenCaseCount
    || !sameNumericRecord(hidden.metricTotals as Record<string, number>, expectedMetricTotals)) feedbackError();
}

function safeFeedbackCountSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) feedbackError();
  return total;
}

function finiteFeedbackMetricSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) feedbackError();
  return total;
}

function sameNumericRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length
    && leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

function assertPublicFeedbackEvent(value: unknown): void {
  if (!isPlainObject(value)) feedbackError();
  if (value.type === "maze.carved" && exactFields(value, ["type", "from", "to"])
    && coordinate(value.from) && coordinate(value.to)) return;
  if (value.type === "maze.completed" && exactFields(value, ["type", "passageCount"])
    && nonNegativeInteger(value.passageCount)) return;
  if (value.type === "solver.decision"
    && exactFields(value, ["type", "position", "openDirections", "remainingSteps", "direction", "kind"])
    && coordinate(value.position) && Array.isArray(value.openDirections)
    && value.openDirections.every(direction) && nonNegativeInteger(value.remainingSteps)
    && direction(value.direction) && ["move", "backtrack"].includes(String(value.kind))) return;
  feedbackError();
}

function numericRecord(value: unknown, maximumEntries: number): boolean {
  return isPlainObject(value) && Object.keys(value).length <= maximumEntries && Object.entries(value).every(([key, metric]) =>
    /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(key) && typeof metric === "number" && Number.isFinite(metric));
}
function hiddenMetricRecord(value: unknown, role: HarnessEvolutionRequest["role"]): boolean {
  if (!isPlainObject(value)) return false;
  const allowed = role === "generator"
    ? new Set(["gateFailures", "failedCases", "extraActions", "structuralNovelty"])
    : new Set(["solvedCases", "extraActions", "illegalActions"]);
  return Object.entries(value).every(([key, metric]) =>
    allowed.has(key) && Number.isSafeInteger(metric) && Number(metric) >= 0);
}
function coordinate(value: unknown): boolean {
  return isPlainObject(value) && exactFields(value, ["x", "y"])
    && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);
}
function direction(value: unknown): boolean { return ["north", "east", "south", "west"].includes(String(value)); }
function feedbackId(value: unknown): boolean { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value); }
function feedbackAttemptId(generation: number, role: HarnessEvolutionRequest["role"]): string {
  return `g${String(generation).padStart(4, "0")}-${role}`;
}
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0; }
function feedbackError(): never { throw new Error("DSH 自治反馈协议字段非法"); }

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
  costLimit?: number,
  diagnosticNonce?: string,
): HarnessEvolutionProtocolResponse {
  if (!isPlainObject(value)) throw protocolError("RESPONSE_INVALID");
  const response = value as Record<string, unknown>;
  if (response.type !== HARNESS_EVOLUTION_RESPONSE_TYPE
    || response.protocolVersion !== HARNESS_EVOLUTION_PROTOCOL_VERSION
    || response.sessionId !== sessionId) {
    throw protocolError("RESPONSE_IDENTITY_INVALID");
  }
  const diagnostic = parseDiagnosticSummary(response.diagnostic, { sessionId, diagnosticNonce });
  if (Object.hasOwn(response, "diagnostic") && diagnostic === undefined) {
    throw protocolError("DIAGNOSTIC_INVALID");
  }
  if (exactFields(response, ["type", "protocolVersion", "sessionId", "error", "usage", "modelCalls"])
    || exactFields(response, ["type", "protocolVersion", "sessionId", "error", "usage", "modelCalls", "diagnostic"])) {
    const attemptedModelCalls = parseModelCalls(response.modelCalls);
    const parsedUsage = response.usage === null
      ? undefined
      : isPlainObject(response.usage)
        ? parseUsage(response.usage, tokenLimit, costLimit)
        : undefined;
    if (response.usage !== null && parsedUsage === undefined) {
      throw protocolError("ERROR_SCHEMA_INVALID", undefined, attemptedModelCalls);
    }
    if (parsedUsage && parsedUsage.modelCalls !== attemptedModelCalls) {
      throw protocolError("ERROR_SCHEMA_INVALID", parsedUsage, attemptedModelCalls);
    }
    if (!isPlainObject(response.error)) {
      throw protocolError("ERROR_SCHEMA_INVALID", parsedUsage, attemptedModelCalls);
    }
    const error = response.error as Record<string, unknown>;
    const responseFailureFacts = parseFailureFacts(error.failureFacts);
    if (!exactOptionalFields(error, ["kind", "code"], ["failureFacts"])
      || !["transient-provider", "provider", "protocol", "process"].includes(String(error.kind))
      || typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      || (Object.hasOwn(error, "failureFacts") && responseFailureFacts === undefined)) {
      throw protocolError("ERROR_SCHEMA_INVALID", parsedUsage, attemptedModelCalls);
    }
    throw new HarnessInvocationError(
      `DSH 自治调用失败（${failureKindLabel(String(error.kind))}：${error.code}）`,
      error.kind as "transient-provider" | "provider" | "protocol" | "process",
      parsedUsage,
      undefined,
      error.code,
      attemptedModelCalls,
      false,
      diagnostic,
      diagnostic?.failureFacts ?? responseFailureFacts,
    );
  }
  if (!isPlainObject(response.usage)) throw protocolError("RESULT_ENVELOPE_INVALID");
  const parsedUsage = parseUsage(response.usage, tokenLimit, costLimit);
  if (!exactOptionalFields(response, ["type", "protocolVersion", "sessionId", "result", "usage"], ["costPolicyId"])
    || !isPlainObject(response.result)) throw protocolError("RESULT_ENVELOPE_INVALID", parsedUsage);
  if (response.costPolicyId !== undefined
    && (typeof response.costPolicyId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(response.costPolicyId))) {
    throw protocolError("COST_POLICY_INVALID", parsedUsage);
  }
  const result = response.result as Record<string, unknown>;
  if (!exactOptionalFields(result, ["hypothesis", "strategyPlan", "submitted"], ["reasoning", "toolActivity"])
    || typeof result.hypothesis !== "string" || typeof result.strategyPlan !== "string"
    || typeof result.submitted !== "boolean"
    || !boundedString(result.hypothesis, MAX_HYPOTHESIS_BYTES)
    || !boundedString(result.strategyPlan, MAX_RESPONSE_STRATEGY_PLAN_BYTES)
    || (result.reasoning !== undefined && (typeof result.reasoning !== "string" || !boundedString(result.reasoning, MAX_REASONING_BYTES)))
    || (result.toolActivity !== undefined && (typeof result.toolActivity !== "string" || !boundedString(result.toolActivity, MAX_TOOL_ACTIVITY_BYTES)))) {
    throw protocolError("RESULT_SCHEMA_INVALID", parsedUsage);
  }
  return value as unknown as HarnessEvolutionProtocolResponse;
}

function failureKindLabel(kind: string): string {
  if (kind === "transient-provider") return "瞬态提供方故障";
  if (kind === "provider") return "提供方故障";
  if (kind === "protocol") return "协议故障";
  return "进程故障";
}

function parseUsage(usage: Record<string, unknown>, tokenLimit: number, costLimit?: number): { tokens: number; cost: number; modelCalls: number } {
  if (!exactFields(usage, ["tokens", "cost", "modelCalls"])
    || !Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0
    || typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || Number(usage.cost) < 0
    || !Number.isSafeInteger(usage.modelCalls) || Number(usage.modelCalls) < 0 || Number(usage.modelCalls) > 8) {
    throw protocolError("USAGE_INVALID");
  }
  const parsed = { tokens: Number(usage.tokens), cost: Number(usage.cost), modelCalls: Number(usage.modelCalls) };
  if (parsed.tokens > tokenLimit || (costLimit !== undefined && parsed.cost > costLimit)) {
    throw protocolError("USAGE_LIMIT_EXCEEDED", parsed);
  }
  return parsed;
}

function parseModelCalls(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8) {
    throw protocolError("ERROR_SCHEMA_INVALID");
  }
  return Number(value);
}

function protocolError(
  code: string,
  usage?: { tokens: number; cost: number; modelCalls: number },
  attemptedModelCalls?: number,
): HarnessInvocationError {
  return new HarnessInvocationError("DSH 自治进程响应字段非法", "protocol", usage, undefined, code, attemptedModelCalls);
}

function parseFailureFacts(value: unknown): HarnessFailureFacts | undefined {
  if (!isPlainObject(value)) return undefined;
  const facts: HarnessFailureFacts = {};
  if (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599) {
    facts.status = Number(value.status);
  }
  if (typeof value.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)) {
    facts.requestId = value.requestId;
  }
  if (typeof value.messageFingerprint === "string" && /^[0-9a-f]{16}$/.test(value.messageFingerprint)) {
    facts.messageFingerprint = value.messageFingerprint;
  }
  if ((typeof value.wireCode === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/.test(value.wireCode))
    || Number.isSafeInteger(value.wireCode)) {
    facts.wireCode = value.wireCode as number | string;
  }
  if (["null", "string", "number", "boolean", "object", "array"].includes(String(value.dataType))) {
    facts.dataType = value.dataType as HarnessFailureFacts["dataType"];
  }
  if ((typeof value.dataCode === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/.test(value.dataCode))
    || Number.isSafeInteger(value.dataCode)) {
    facts.dataCode = value.dataCode as number | string;
  }
  if (typeof value.dataRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.dataRequestId)) {
    facts.dataRequestId = value.dataRequestId;
  }
  if (Number.isInteger(value.dataStatus) && Number(value.dataStatus) >= 100 && Number(value.dataStatus) <= 599) {
    facts.dataStatus = Number(value.dataStatus);
  }
  if (typeof value.dataFingerprint === "string" && /^[0-9a-f]{16}$/.test(value.dataFingerprint)) {
    facts.dataFingerprint = value.dataFingerprint;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function parseDiagnosticSummary(
  value: unknown,
  expected: { sessionId?: string; diagnosticNonce?: string } = {},
): HarnessDiagnosticSummary | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (expected.sessionId !== undefined && value.sessionId !== expected.sessionId) return undefined;
  if (expected.diagnosticNonce !== undefined && value.diagnosticNonce !== expected.diagnosticNonce) return undefined;

  const eventCounts: Record<string, number> = {};
  const turnEnds: Array<{
    turn: number | null;
    kind: string | null;
    errorCode: string | null;
    failureFacts?: HarnessFailureFacts;
  }> = [];
  const toolNames = new Set<string>();
  let requestContext: HarnessDiagnosticSummary["requestContext"];
  const events = Array.isArray(value.events) ? value.events.slice(0, 256) : [];
  const boundedCode = (candidate: unknown): string | null => (
    typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : null
  );
  const boundedName = (candidate: unknown): string | undefined => (
    typeof candidate === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(candidate) ? candidate : undefined
  );
  const boundedLocalFailure = (candidate: unknown): HarnessLocalFailureSummary | undefined => {
    if (!isPlainObject(candidate)) return undefined;
    const code = boundedCode(candidate.code);
    if (code === null) return undefined;
    const value: HarnessLocalFailureSummary = { code };
    if (Object.hasOwn(candidate, "stage")) {
      if (typeof candidate.stage !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(candidate.stage)) return undefined;
      value.stage = candidate.stage;
    }
    if (Object.hasOwn(candidate, "errorType")) {
      if (typeof candidate.errorType !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(candidate.errorType)) return undefined;
      value.errorType = candidate.errorType;
    }
    if (Object.hasOwn(candidate, "messageFingerprint")) {
      if (typeof candidate.messageFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(candidate.messageFingerprint)) return undefined;
      value.messageFingerprint = candidate.messageFingerprint;
    }
    if (Object.hasOwn(candidate, "stackFingerprint")) {
      if (typeof candidate.stackFingerprint !== "string" || !/^[0-9a-f]{16}$/.test(candidate.stackFingerprint)) return undefined;
      value.stackFingerprint = candidate.stackFingerprint;
    }
    return value;
  };
  const boundedFailureFacts = (candidate: unknown): HarnessFailureFacts | undefined => {
    if (!isPlainObject(candidate)) return undefined;
    const facts: HarnessFailureFacts = {};
    if (Number.isInteger(candidate.status) && Number(candidate.status) >= 100 && Number(candidate.status) <= 599) {
      facts.status = Number(candidate.status);
    }
    if (typeof candidate.requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate.requestId)) {
      facts.requestId = candidate.requestId;
    }
    if (typeof candidate.messageFingerprint === "string" && /^[0-9a-f]{16}$/.test(candidate.messageFingerprint)) {
      facts.messageFingerprint = candidate.messageFingerprint;
    }
    if ((typeof candidate.wireCode === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/.test(candidate.wireCode))
      || Number.isSafeInteger(candidate.wireCode)) {
      facts.wireCode = candidate.wireCode as number | string;
    }
    if (["null", "string", "number", "boolean", "object", "array"].includes(String(candidate.dataType))) {
      facts.dataType = candidate.dataType as HarnessFailureFacts["dataType"];
    }
    if ((typeof candidate.dataCode === "string" && /^[A-Z][A-Z0-9_.:-]{0,63}$/.test(candidate.dataCode))
      || Number.isSafeInteger(candidate.dataCode)) {
      facts.dataCode = candidate.dataCode as number | string;
    }
    if (typeof candidate.dataRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate.dataRequestId)) {
      facts.dataRequestId = candidate.dataRequestId;
    }
    if (Number.isInteger(candidate.dataStatus) && Number(candidate.dataStatus) >= 100 && Number(candidate.dataStatus) <= 599) {
      facts.dataStatus = Number(candidate.dataStatus);
    }
    if (typeof candidate.dataFingerprint === "string" && /^[0-9a-f]{16}$/.test(candidate.dataFingerprint)) {
      facts.dataFingerprint = candidate.dataFingerprint;
    }
    return Object.keys(facts).length > 0 ? facts : undefined;
  };

  for (const event of events) {
    if (!isPlainObject(event) || typeof event.type !== "string") continue;
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    const data = isPlainObject(event.data) ? event.data : undefined;
    if (event.type === "request/context" && data) {
      const provider = typeof data.provider === "string" ? data.provider : undefined;
      const model = typeof data.model === "string" ? data.model : undefined;
      const contextWindow = Number.isSafeInteger(data.contextWindow) ? Number(data.contextWindow) : null;
      if (provider && model) requestContext = { provider, model, contextWindow };
    }
    if (event.type === "tool/call" && data) {
      const name = boundedName(data.name)
        ?? boundedName(data.toolName)
        ?? (isPlainObject(data.tool) ? boundedName(data.tool.name) : undefined);
      if (name) toolNames.add(name);
    }
    if (event.type === "turn/end" && data && turnEnds.length < 32) {
      const reason = isPlainObject(data.reason) ? data.reason : undefined;
      const reasonError = reason && isPlainObject(reason.error) ? reason.error : undefined;
      turnEnds.push({
        turn: Number.isSafeInteger(data.turn) ? Number(data.turn) : null,
        kind: typeof reason?.kind === "string" ? reason.kind : null,
        errorCode: boundedCode(reasonError?.code),
        ...(reasonError ? (() => {
          const facts = boundedFailureFacts(reasonError.failureFacts);
          return facts ? { failureFacts: facts } : {};
        })() : {}),
      });
    }
  }

  const finalization = isPlainObject(value.finalization) ? value.finalization : undefined;
  const localFailureSummary = finalization && isPlainObject(finalization.localFailure)
    ? boundedLocalFailure(finalization.localFailure) : undefined;
  const localFailure = localFailureSummary?.code ?? null;
  const cleanupError = finalization && isPlainObject(finalization.cleanupError)
    ? boundedCode(finalization.cleanupError.code) : null;
  const errorCode = isPlainObject(value.error) ? boundedCode(value.error.code) : null;
  const failureFacts = isPlainObject(value.error) ? boundedFailureFacts(value.error.failureFacts) : undefined;
  const modelCalls = Number.isSafeInteger(value.modelCalls) && Number(value.modelCalls) >= 0
    ? Number(value.modelCalls) : 0;
  const stderrBytes = Number.isSafeInteger(value.stderrBytes) && Number(value.stderrBytes) >= 0
    ? Number(value.stderrBytes)
    : typeof value.stderr === "string" ? Buffer.byteLength(value.stderr, "utf8") : 0;
  return {
    modelCalls,
    eventCounts,
    turnEnds,
    toolNames: [...toolNames].sort(),
    ...(requestContext ? { requestContext } : {}),
    errorCode,
    ...(failureFacts ? { failureFacts } : {}),
    localFailureCode: localFailure,
    ...(localFailureSummary ? { localFailure: localFailureSummary } : {}),
    cleanupErrorCode: cleanupError,
    stderrBytes,
  };
}

function withExecutionIdentity(
  error: unknown,
  execution: HarnessExecutionIdentity,
  diagnostic?: HarnessDiagnosticSummary,
): HarnessInvocationError {
  if (error instanceof HarnessInvocationError) {
    return new HarnessInvocationError(error.message, error.kind, error.usage, execution, error.code,
      error.attemptedModelCalls, error.usageLedgerBacked, diagnostic ?? error.diagnostic, error.failureFacts);
  }
  return new HarnessInvocationError(
    error instanceof Error ? error.message : "DSH 自治调用失败",
    "process",
    undefined,
    execution,
    undefined,
    undefined,
    false,
    diagnostic,
    undefined,
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
  if (value === undefined) return DEFAULT_EVOLUTION_ACTIVITY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new HarnessConfigurationError("DSH_EVOLUTION_TIMEOUT_MS 必须为 1000 到 600000 之间的整数毫秒数");
  }
  return parsed;
}

function evolutionTotalTimeout(activityTimeoutMs: number, maxModelCalls: number): number {
  const calls = Number.isSafeInteger(maxModelCalls) && maxModelCalls > 0 ? maxModelCalls : 1;
  return Math.min(MAX_EVOLUTION_TOTAL_TIMEOUT_MS,
    Math.max(activityTimeoutMs * (calls + 1), 180_000 * calls + 30_000));
}
