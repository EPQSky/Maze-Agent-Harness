import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createHarnessNetworkSeccompProgram,
  DeterministicFakeHarnessAdapter,
  ExportedHarnessConfigAdapter,
  HarnessConfigurationError,
  ModelProfileValidationError,
  createHarnessAgentEnvironments,
  parseHarnessModelCatalog,
} from "./index.js";

describe("Harness 模型适配层", () => {
  const adapter = new DeterministicFakeHarnessAdapter();

  it.each([
    ["x64", 0xc000003e, 41, 53],
    ["arm64", 0xc00000b7, 198, 199],
  ])("为 %s 生成阻断 AF_UNIX 的 seccomp 程序", (architecture, auditArchitecture, socketSystemCall, socketPairSystemCall) => {
    const program = createHarnessNetworkSeccompProgram(architecture);
    expect(program.length).toBe(14 * 8);
    expect(program.readUInt32LE(12)).toBe(auditArchitecture);
    expect(program.readUInt32LE(6 * 8 + 4)).toBe(socketSystemCall);
    expect(program.readUInt32LE(7 * 8 + 4)).toBe(socketPairSystemCall);
    expect(program.readUInt32LE(12 * 8 + 4)).toBe(0x00050061);
    expect(program.readUInt32LE(13 * 8 + 4)).toBe(0x7fff0000);
  });

  it("对未知 CPU 架构关闭失败", () => {
    expect(() => createHarnessNetworkSeccompProgram("unsupported-test-architecture"))
      .toThrowError(/不支持当前 CPU 架构/);
  });

  it("暴露能力集合不同的提供方并规范化有效配置", () => {
    const catalog = adapter.listModels();
    expect(catalog.credentialRefs).toEqual(["dsh-credential://basic", "dsh-credential://reasoning"]);
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["fake-basic", "fake-reasoning"]);
    expect(catalog.providers[0]?.models[0]?.capabilities.reasoningEfforts).toEqual([]);
    expect(catalog.providers[1]?.models[0]?.capabilities.reasoningEfforts).toEqual(["low", "medium", "high"]);

    expect(adapter.validateModelProfile({
      providerId: "fake-reasoning",
      modelId: "reasoner-v1",
      credentialRef: "dsh-credential://reasoning",
      reasoningEffort: "high",
      contextTokens: 16_000,
      outputTokens: 2_000,
      totalTokenLimit: 30_000,
      providerOptions: { thinkingBudget: 8_000 },
    })).toMatchObject({
      providerLabel: "确定性推理提供方",
      modelLabel: "Reasoner V1",
      credentialRef: "dsh-credential://reasoning",
    });
  });

  it("在调用模型前逐字段拒绝未知、冲突和越界参数", () => {
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      reasoningEffort: "high",
      temperature: 3,
      contextTokens: 9_000,
      outputTokens: 3_000,
      totalTokenLimit: 2_000,
      providerOptions: { thinkingBudget: 10 },
      apiKey: "sk-plaintext",
    } as never)).toThrowError(ModelProfileValidationError);

    try {
      adapter.validateModelProfile({
        providerId: "fake-basic",
        modelId: "compact-v1",
        credentialRef: "dsh-credential://basic",
        reasoningEffort: "high",
        temperature: 3,
        contextTokens: 9_000,
        outputTokens: 3_000,
        totalTokenLimit: 2_000,
        providerOptions: { thinkingBudget: 10 },
        apiKey: "sk-plaintext",
      } as never);
    } catch (error) {
      expect((error as ModelProfileValidationError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "apiKey" }),
        expect.objectContaining({ path: "reasoningEffort" }),
        expect.objectContaining({ path: "temperature" }),
        expect.objectContaining({ path: "contextTokens" }),
        expect.objectContaining({ path: "providerOptions.thinkingBudget" }),
        expect.objectContaining({ path: "totalTokenLimit" }),
      ]));
    }
  });

  it("只接受凭据引用并为生成器与求解器分配隔离目录", () => {
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "sk-plaintext-secret",
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
    })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ path: "credentialRef" })],
    }));

    const environments = createHarnessAgentEnvironments("/arena/harness", "experiment-1");
    expect(environments.generator.home).not.toBe(environments.solver.home);
    expect(environments.generator.workspace).not.toBe(environments.solver.workspace);
    expect(environments).toEqual({
      generator: {
        home: "/arena/harness/experiment-1/generator/home",
        workspace: "/arena/harness/experiment-1/generator/workspace",
      },
      solver: {
        home: "/arena/harness/experiment-1/solver/home",
        workspace: "/arena/harness/experiment-1/solver/workspace",
      },
    });
  });

  it.each([null, 7, "option", [], new Date()])("严格拒绝非普通 providerOptions: %o", (providerOptions) => {
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
      providerOptions,
    } as never)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ path: "providerOptions" })]),
    }));
  });

  it.each([Number.NaN, { nested: true }])("严格拒绝非法 provider option 值: %o", (deterministicSeed) => {
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
      providerOptions: { deterministicSeed },
    } as never)).toThrowError(expect.objectContaining({
      issues: expect.arrayContaining([expect.objectContaining({ path: "providerOptions.deterministicSeed" })]),
    }));
  });

  it("生产适配器从精确版本导出读取目录并校验凭据注册表", () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-harness-export-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production-main"],
      providers: [{
        id: "production-provider",
        label: "Production Provider",
        models: [{
          id: "production-model",
          label: "Production Model",
          capabilities: {
            reasoningEfforts: ["medium"],
            maxContextTokens: 16_000,
            maxOutputTokens: 2_000,
            maxTotalTokens: 18_000,
            providerOptions: {},
          },
        }],
      }],
    }));

    const production = ExportedHarnessConfigAdapter.fromFile(exportPath, "2026.09-preview.1");
    expect(production.listModels().credentialRefs).toEqual(["dsh-credential://production-main"]);
    expect(production.listModels().providers.map(({ id }) => id)).toEqual(["production-provider"]);
    expect(() => production.validateModelProfile({
      providerId: "production-provider",
      modelId: "production-model",
      credentialRef: "dsh-credential://missing",
      reasoningEffort: "medium",
      contextTokens: 8_000,
      outputTokens: 1_000,
      totalTokenLimit: 9_000,
    })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({ path: "credentialRef" })],
    }));
  });

  it("生产适配器在配置缺失或版本不符时关闭失败，绝不回退到 fake catalog", () => {
    expect(() => ExportedHarnessConfigAdapter.fromFile("/missing/harness-export.json", "2026.09-preview.1"))
      .toThrowError(HarnessConfigurationError);

    const directory = mkdtempSync(join(tmpdir(), "maze-harness-version-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.08-preview.9",
      credentialRefs: [],
      providers: [],
    }));
    expect(() => ExportedHarnessConfigAdapter.fromFile(exportPath, "2026.09-preview.1"))
      .toThrowError(/Harness 版本不匹配/);
  });

  it.each([
    ["provider", (value: any) => { value.providers[0].unknownProvider = true; }],
    ["model", (value: any) => { value.providers[0].models[0].unknownModel = true; }],
    ["capabilities", (value: any) => { value.providers[0].models[0].capabilities.unknownCapability = true; }],
    ["range", (value: any) => { value.providers[0].models[0].capabilities.temperature.unknownRange = true; }],
    ["option capability", (value: any) => { value.providers[0].models[0].capabilities.providerOptions.seed.unknownOption = true; }],
  ])("生产导出在 %s 层出现未知字段时关闭失败", (_layer, mutate) => {
    const value = {
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{
        id: "provider", label: "Provider", models: [{
          id: "model", label: "Model", capabilities: {
            reasoningEfforts: [],
            temperature: { minimum: 0, maximum: 1 },
            maxContextTokens: 8_000,
            maxOutputTokens: 1_000,
            maxTotalTokens: 9_000,
            providerOptions: { seed: { type: "number", minimum: 0, maximum: 100 } },
          },
        }],
      }],
    };
    mutate(value);
    const directory = mkdtempSync(join(tmpdir(), "maze-harness-unknown-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify(value));

    expect(() => ExportedHarnessConfigAdapter.fromFile(exportPath, "2026.09-preview.1"))
      .toThrowError(/未知字段/);
  });

  it.each([
    ["provider label", (value: any, secret: string) => { value.providers[0].label = `Vendor ${secret}`; }],
    ["model label", (value: any, secret: string) => { value.providers[0].models[0].label = secret; }],
    ["provider option name", (value: any, secret: string) => { value.providers[0].models[0].capabilities.providerOptions[secret] = { type: "string" }; }],
  ])("拒绝 %s 中的疑似秘密且诊断不回显原文", (_position, mutate) => {
    const secret = "sk-live-parser-secret-123456";
    const value = {
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
        maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    };
    mutate(value, secret);

    expect(() => parseHarnessModelCatalog(value, "2026.09-preview.1")).toThrowError(expect.not.objectContaining({ message: expect.stringContaining(secret) }));
    try { parseHarnessModelCatalog(value, "2026.09-preview.1"); }
    catch (error) {
      expect(["Harness 导出包含疑似真实凭据内容", "Harness 导出包含禁止的敏感字段"])
        .toContain((error as Error).message);
    }
  });

  it.each([
    "apiKey", "api_key", "ACCESS-TOKEN", "oauthToken", "OAUTH_TOKEN", "sessionToken", "accessTokenValue", "bearerToken",
    "authorization", "authHeader", "auth-header", "privateKey", "PRIVATE_key", "clientKey", "signingKey", "clientSecret", "password",
    "credential", "token",
  ])(
    "providerOptions 禁止敏感字段名 %s 且诊断不回显原键",
    (field) => {
      const value = {
        schemaVersion: 1,
        harnessVersion: "2026.09-preview.1",
        credentialRefs: ["dsh-credential://production"],
        providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
          reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
          maxTotalTokens: 9_000, providerOptions: { [field]: { type: "string" } },
        } }] }],
      };

      try {
        parseHarnessModelCatalog(value, "2026.09-preview.1");
        throw new Error("预期 parser 拒绝敏感字段名");
      } catch (error) {
        expect((error as Error).message).toBe("Harness 导出包含禁止的敏感字段");
        expect((error as Error).message).not.toContain(field);
      }
    },
  );

  it.each(["tokenBudget", "maxTokens", "maxContextTokens", "maxOutputTokens", "maxTotalTokens"])(
    "允许非认证 token 能力字段 %s",
    (field) => {
    const parsed = parseHarnessModelCatalog({
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
        maxTotalTokens: 9_000, providerOptions: { [field]: { type: "number", minimum: 1, maximum: 10 } },
      } }] }],
    }, "2026.09-preview.1");

    expect(parsed.providers[0]?.models[0]?.capabilities.providerOptions[field]).toEqual({
      type: "number",
      minimum: 1,
      maximum: 10,
    });
    },
  );
});
