import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createHarnessNetworkSeccompProgram,
  credentialEnvironmentNameFromReference,
  credentialEnvironmentNameIssue,
  DeterministicFakeHarnessAdapter,
  ExportedHarnessConfigAdapter,
  HarnessConfigurationError,
  ModelProfileValidationError,
  createHarnessAgentEnvironments,
  parseHarnessModelCatalog,
  writeBudgetLedgerResponse,
} from "./index.js";

describe("Harness 模型适配层", () => {
  const adapter = new DeterministicFakeHarnessAdapter();

  it.each([
    ["x64", 0xc000003e, 41],
    ["arm64", 0xc00000b7, 198],
  ])("为 %s 生成阻断 AF_UNIX 连接且允许本地 socketpair 的 seccomp 程序", (architecture, auditArchitecture, socketSystemCall) => {
    const program = createHarnessNetworkSeccompProgram(architecture);
    expect(program.length).toBe(11 * 8);
    expect(program.readUInt32LE(12)).toBe(auditArchitecture);
    expect(program.readUInt32LE(6 * 8 + 4)).toBe(socketSystemCall);
    expect(program.readUInt8(6 * 8 + 2)).toBe(0);
    expect(program.readUInt8(6 * 8 + 3)).toBe(3);
    expect(program.readUInt32LE(9 * 8 + 4)).toBe(0x00050061);
    expect(program.readUInt32LE(10 * 8 + 4)).toBe(0x7fff0000);
  });

  it("对未知 CPU 架构关闭失败", () => {
    expect(() => createHarnessNetworkSeccompProgram("unsupported-test-architecture"))
      .toThrowError(/不支持当前 CPU 架构/);
  });

  it("共享策略仅接受闭合的凭据命名形态", () => {
    expect(credentialEnvironmentNameIssue("DEEPSEEK_API_KEY")).toBeUndefined();
    expect(credentialEnvironmentNameIssue("CUSTOM_CRED")).toBeUndefined();
  });

  it.each([
    "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS", "LD_PRELOAD",
    "BASH_ENV", "PATH", "HOME", "ARENA_ATTACK", "DSH_ATTACK", "OPENSSL_MODULES", "UV_THREADPOOL_SIZE",
    "NPM_TOKEN", "NPM_API_KEY", "YARN_ENABLE_SCRIPTS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  ])("共享策略拒绝把非凭据或保留运行名 %s 登记为凭据", (name) => {
    expect(credentialEnvironmentNameIssue(name)).toBeDefined();
    expect(() => credentialEnvironmentNameFromReference(`dsh-credential://${name}`)).toThrow();
  });

  it.each([
    "OPENSSL_MODULES", "UV_THREADPOOL_SIZE", "NPM_TOKEN", "YARN_ENABLE_SCRIPTS", "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
  ])("生产模型目录在适配器构造时拒绝保留凭据引用 %s", (name) => {
    const raw = {
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: [`dsh-credential://${name}`],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
        maxTotalTokens: 9_000, providerOptions: {},
      } }] }],
    };
    expect(() => parseHarnessModelCatalog(raw, "2026.09-preview.1")).toThrow(/credentialRefs 无效/);
  });

  it("暴露能力集合不同的提供方并规范化有效配置", () => {
    const catalog = adapter.listModels();
    expect(catalog.credentialRefs).toEqual(["dsh-credential://BASIC_CRED", "dsh-credential://REASONING_CRED"]);
    expect(catalog.providers.map((provider) => provider.id)).toEqual(["fake-basic", "fake-reasoning"]);
    expect(catalog.providers[0]?.models[0]?.capabilities.reasoningEfforts).toEqual([]);
    expect(catalog.providers[1]?.models[0]?.capabilities.reasoningEfforts).toEqual(["off", "low", "high", "max"]);

    expect(adapter.validateModelProfile({
      providerId: "fake-reasoning",
      modelId: "reasoner-v1",
      credentialRef: "dsh-credential://REASONING_CRED",
      reasoningEffort: "high",
      contextTokens: 16_000,
      outputTokens: 2_000,
      totalTokenLimit: 30_000,
      providerOptions: { thinkingBudget: 8_000 },
    })).toMatchObject({
      providerLabel: "确定性推理提供方",
      modelLabel: "Reasoner V1",
      credentialRef: "dsh-credential://REASONING_CRED",
    });
  });

  it("在调用模型前逐字段拒绝未知、冲突和越界参数", () => {
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://BASIC_CRED",
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
        credentialRef: "dsh-credential://BASIC_CRED",
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
    expect(adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://BASIC_CRED",
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
    }).credentialRef).toBe("dsh-credential://BASIC_CRED");

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
    expect(() => adapter.validateModelProfile({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://vendor-a",
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
      credentialRef: "dsh-credential://BASIC_CRED",
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
      credentialRef: "dsh-credential://BASIC_CRED",
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
      credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
      providers: [{
        id: "production-provider",
        label: "Production Provider",
        models: [{
          id: "production-model",
          label: "Production Model",
          capabilities: {
            reasoningEfforts: ["off", "low", "high", "max"],
            maxContextTokens: 16_000,
            maxOutputTokens: 2_000,
            maxTotalTokens: 18_000,
            providerOptions: {},
          },
        }],
      }],
    }));

    const production = ExportedHarnessConfigAdapter.fromFile(exportPath, "2026.09-preview.1");
    expect(production.listModels().credentialRefs).toEqual(["dsh-credential://PRODUCTION_CRED"]);
    expect(production.listModels().providers.map(({ id }) => id)).toEqual(["production-provider"]);
    expect(() => production.validateModelProfile({
      providerId: "production-provider",
      modelId: "production-model",
      credentialRef: "dsh-credential://MISSING_CRED",
      reasoningEffort: "max",
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
      credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
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
      credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
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
        credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
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
      credentialRefs: ["dsh-credential://PRODUCTION_CRED"],
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

  it.each(["async", "sync"] as const)(
    "FD5 预算响应%s写入失败时只回调一次且不冒出未处理错误",
    async (failureMode) => {
      const unhandledRejections: unknown[] = [];
      const uncaughtExceptions: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
      const onUncaughtException = (error: unknown) => uncaughtExceptions.push(error);
      process.on("unhandledRejection", onUnhandledRejection);
      process.on("uncaughtException", onUncaughtException);
      let failures = 0;
      const stream = new Writable({
        write(_chunk, _encoding, callback) {
          if (failureMode === "sync") throw new Error("ledger closed");
          setImmediate(() => callback(new Error("ledger closed")));
        },
      });
      stream.on("error", () => undefined);
      try {
        writeBudgetLedgerResponse(stream, { ok: true, value: "reservation-1" }, () => { failures += 1; });
        await new Promise<void>((resolveWait) => setImmediate(resolveWait));
        expect(failures).toBe(1);
        expect(unhandledRejections).toEqual([]);
        expect(uncaughtExceptions).toEqual([]);
      } finally {
        stream.destroy();
        process.removeListener("unhandledRejection", onUnhandledRejection);
        process.removeListener("uncaughtException", onUncaughtException);
      }
    },
  );
});
