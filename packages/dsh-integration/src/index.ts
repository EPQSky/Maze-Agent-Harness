import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

export interface HarnessEvolutionRequest {
  experimentId: string;
  generation: number;
  role: "generator" | "solver";
  attemptId: string;
  modelProfile: ModelProfile;
  workspace: string;
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
    return {
      hypothesis: `${request.role} 第 ${request.generation} 代确定性候选`,
      strategyPlan: `尝试 ${request.attemptId}，保持协议与资源边界。`,
      submitted: true,
      usage: { tokens: 100, cost: 0 },
      reasoning: "确定性假 Harness 已完成候选分析",
      toolActivity: "read,test,submit",
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
