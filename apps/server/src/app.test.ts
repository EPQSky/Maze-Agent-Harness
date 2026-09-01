import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateExperimentRequest,
  DomainErrorResponse,
  Experiment,
  ExperimentListResponse,
} from "@maze-arena/contracts";
import {
  DeterministicFakeHarnessAdapter,
  ModelProfileValidationError,
} from "@maze-arena/dsh-integration";
import { afterEach, describe, expect, it } from "vitest";
import { createArenaServer } from "./app.js";
import { createProductionHarnessAdapter } from "./production-harness.js";

const servers: ReturnType<typeof createArenaServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createTestServer(databasePath: string) {
  const server = createArenaServer({ databasePath, harnessAdapter: new DeterministicFakeHarnessAdapter() });
  servers.push(server);
  return server;
}

async function createExperiment(server: ReturnType<typeof createArenaServer>, name: string) {
  const payload: CreateExperimentRequest = {
    name,
    modelProfile: {
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      temperature: 0.4,
      topP: 0.9,
      contextTokens: 4_000,
      outputTokens: 1_000,
      totalTokenLimit: 5_000,
      providerOptions: { deterministicSeed: 42 },
    },
  };
  const response = await server.inject({
    method: "POST",
    url: "/api/experiments",
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json<Experiment>();
}

describe("实验工作台 API", () => {
  it("创建草稿并通过列表和详情读取公共实验字段", async () => {
    const server = createTestServer(":memory:");

    const created = await createExperiment(server, "生成器基线实验");
    const list = await server.inject({ method: "GET", url: "/api/experiments" });
    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });

    expect(created).toMatchObject({ name: "生成器基线实验", status: "draft" });
    expect(created.modelProfile).toMatchObject({
      providerId: "fake-basic",
      modelId: "compact-v1",
      credentialRef: "dsh-credential://basic",
      providerLabel: "确定性基础提供方",
    });
    expect(created.harnessEnvironments.generator.home).not.toBe(created.harnessEnvironments.solver.home);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list.json<ExperimentListResponse>()).toEqual({ experiments: [created] });
    expect(detail.json<Experiment>()).toEqual(created);
  });

  it("暴露 Harness 模型能力，并在保存前返回逐字段配置错误", async () => {
    const server = createTestServer(":memory:");
    const catalog = await server.inject({ method: "GET", url: "/api/harness/models" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({ providers: [
      { id: "fake-basic", models: [{ id: "compact-v1", capabilities: { reasoningEfforts: [] } }] },
      { id: "fake-reasoning", models: [{ id: "reasoner-v1", capabilities: { reasoningEfforts: ["low", "medium", "high"] } }] },
    ] });

    const response = await server.inject({
      method: "POST",
      url: "/api/experiments",
      payload: {
        name: "无效配置",
        modelProfile: {
          providerId: "fake-basic",
          modelId: "compact-v1",
          credentialRef: "dsh-credential://basic",
          reasoningEffort: "high",
          contextTokens: 20_000,
          outputTokens: 1_000,
          totalTokenLimit: 21_000,
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "MODEL_PROFILE_INVALID",
        message: "模型配置档无效",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "reasoningEffort" }),
          expect.objectContaining({ path: "contextTokens" }),
        ]),
      },
    });
  });

  it("草稿可替换模型配置，启动后拒绝修改并保持原配置", async () => {
    const server = createTestServer(":memory:");
    const created = await createExperiment(server, "冻结配置实验");
    const replacement = {
      providerId: "fake-reasoning",
      modelId: "reasoner-v1",
      credentialRef: "dsh-credential://reasoning",
      reasoningEffort: "medium" as const,
      contextTokens: 16_000,
      outputTokens: 2_000,
      totalTokenLimit: 20_000,
      providerOptions: { thinkingBudget: 4_000 },
    };
    const updated = await server.inject({
      method: "PUT",
      url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: replacement },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<Experiment>().modelProfile).toMatchObject(replacement);

    await server.inject({ method: "POST", url: `/api/experiments/${created.id}/start` });
    const rejected = await server.inject({
      method: "PUT",
      url: `/api/experiments/${created.id}/model-profile`,
      payload: { modelProfile: { ...replacement, reasoningEffort: "high" } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<DomainErrorResponse>()).toEqual({
      error: { code: "MODEL_PROFILE_FROZEN", message: "实验启动后模型配置档已冻结；修改配置必须创建新实验" },
    });

    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });
    expect(detail.json<Experiment>().modelProfile?.reasoningEffort).toBe("medium");
  });

  it("Harness 能力在草稿期变化时，启动前重新验证并关闭失败", async () => {
    const delegate = new DeterministicFakeHarnessAdapter();
    let enabled = true;
    const server = createArenaServer({
      databasePath: ":memory:",
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => {
          if (!enabled) {
            throw new ModelProfileValidationError([{ path: "providerId", message: "提供方已停用" }]);
          }
          return delegate.validateModelProfile(input);
        },
      },
    });
    servers.push(server);
    const created = await createExperiment(server, "能力漂移实验");
    enabled = false;

    const response = await server.inject({ method: "POST", url: `/api/experiments/${created.id}/start` });

    expect(response.statusCode).toBe(400);
    expect(response.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "MODEL_PROFILE_INVALID",
        message: "模型配置档无效",
        issues: [{ path: "providerId", message: "提供方已停用" }],
      },
    });
    const detail = await server.inject({ method: "GET", url: `/api/experiments/${created.id}` });
    expect(detail.json<Experiment>().status).toBe("draft");
  });

  it("服务关闭并重新打开后仍能从 SQLite 恢复实验", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-"));
    const databasePath = join(directory, "arena.sqlite");
    const firstServer = createTestServer(databasePath);
    const created = await createExperiment(firstServer, "重启恢复实验");
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restartedServer = createTestServer(databasePath);
    const response = await restartedServer.inject({ method: "GET", url: "/api/experiments" });

    expect(response.json<ExperimentListResponse>()).toEqual({ experiments: [created] });
  });

  it("从 Ticket 01 schema 事务迁移且重启后保留旧实验", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-migration-"));
    const databasePath = join(directory, "arena.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed', 'failed', 'cancelled')),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX one_running_experiment ON experiments ((status = 'running')) WHERE status = 'running';`);
    legacy.prepare("INSERT INTO experiments (id, name, status, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy-id", "Ticket 01 实验", "draft", "2026-09-01T00:00:00.000Z");
    legacy.close();

    const firstServer = createTestServer(databasePath);
    const migrated = await firstServer.inject({ method: "GET", url: "/api/experiments/legacy-id" });
    expect(migrated.json<Experiment>()).toMatchObject({
      id: "legacy-id",
      name: "Ticket 01 实验",
      modelProfile: null,
      harnessEnvironments: {
        generator: { home: expect.stringContaining("legacy-id/generator/home") },
        solver: { home: expect.stringContaining("legacy-id/solver/home") },
      },
    });
    const blocked = await firstServer.inject({ method: "POST", url: "/api/experiments/legacy-id/start" });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<DomainErrorResponse>().error.issues).toContainEqual(expect.objectContaining({ path: "modelProfile" }));
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restarted = createTestServer(databasePath);
    const restored = await restarted.inject({ method: "GET", url: "/api/experiments/legacy-id" });
    expect(restored.json<Experiment>()).toMatchObject({ id: "legacy-id", name: "Ticket 01 实验", modelProfile: null });
  });

  it("冻结事务阻止另一连接在复验与启动之间替换配置", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-freeze-"));
    const databasePath = join(directory, "arena.sqlite");
    const delegate = new DeterministicFakeHarnessAdapter();
    let attack = false;
    let targetId = "";
    let competingWriteError = "";
    const server = createArenaServer({
      databasePath,
      harnessAdapter: {
        listModels: () => delegate.listModels(),
        validateModelProfile: (input) => {
          const validated = delegate.validateModelProfile(input);
          if (attack) {
            const competitor = new DatabaseSync(databasePath);
            competitor.exec("PRAGMA busy_timeout = 1");
            try {
              competitor.prepare("UPDATE experiments SET model_profile_json = ? WHERE id = ?")
                .run(JSON.stringify({ ...validated, providerId: "tampered" }), targetId);
            } catch (error) {
              competingWriteError = error instanceof Error ? error.message : String(error);
            } finally {
              competitor.close();
            }
          }
          return validated;
        },
      },
    });
    servers.push(server);
    const createdResponse = await server.inject({
      method: "POST",
      url: "/api/experiments",
      payload: {
        name: "原子冻结",
        modelProfile: {
          providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
          contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
        },
      },
    });
    const created = createdResponse.json<Experiment>();
    targetId = created.id;
    attack = true;

    const started = await server.inject({ method: "POST", url: `/api/experiments/${created.id}/start` });
    expect(started.statusCode).toBe(200);
    expect(competingWriteError).toMatch(/locked|busy/i);
    expect(started.json<Experiment>()).toMatchObject({
      status: "running",
      modelProfile: { providerId: "fake-basic" },
    });
  });

  it("生产入口只读取版本化 Harness 导出且不会暴露 fake catalog", () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-production-harness-"));
    const exportPath = join(directory, "models.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "2026.09-preview.1",
      credentialRefs: ["dsh-credential://production"],
      providers: [{
        id: "configured-provider", label: "Configured", models: [{
          id: "configured-model", label: "Configured Model", capabilities: {
            reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
            maxTotalTokens: 9_000, providerOptions: {},
          },
        }],
      }],
    }));

    const production = createProductionHarnessAdapter({
      DSH_HARNESS_EXPORT_PATH: exportPath,
      DSH_HARNESS_VERSION: "2026.09-preview.1",
    });
    expect(production.listModels().providers.map(({ id }) => id)).toEqual(["configured-provider"]);
    expect(() => createProductionHarnessAdapter({})).toThrow(/必须配置/);
  });

  it("已有运行实验时拒绝启动第二个实验并返回领域错误", async () => {
    const server = createTestServer(":memory:");
    const first = await createExperiment(server, "实验一");
    const second = await createExperiment(server, "实验二");

    const responses = await Promise.all([
      server.inject({ method: "POST", url: `/api/experiments/${first.id}/start` }),
      server.inject({ method: "POST", url: `/api/experiments/${second.id}/start` }),
    ]);
    const accepted = responses.find((response) => response.statusCode === 200);
    const rejected = responses.find((response) => response.statusCode === 409);

    expect(accepted?.json<Experiment>()).toMatchObject({ status: "running" });
    expect(rejected?.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "ACTIVE_EXPERIMENT_EXISTS",
        message: "当前 Arena 已有运行中的实验",
      },
    });
  });

  it("重复启动同一实验返回稳定的非法状态转换错误", async () => {
    const server = createTestServer(":memory:");
    const experiment = await createExperiment(server, "重复启动实验");
    const first = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/start` });
    const repeated = await server.inject({ method: "POST", url: `/api/experiments/${experiment.id}/start` });

    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json<DomainErrorResponse>()).toEqual({
      error: {
        code: "INVALID_EXPERIMENT_STATE",
        message: "实验当前状态 running 不允许启动",
      },
    });
  });
});
