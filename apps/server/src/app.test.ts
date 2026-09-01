import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainErrorResponse, Experiment, ExperimentListResponse } from "@maze-arena/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createArenaServer } from "./app.js";

const servers: ReturnType<typeof createArenaServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createTestServer(databasePath: string) {
  const server = createArenaServer({ databasePath });
  servers.push(server);
  return server;
}

async function createExperiment(server: ReturnType<typeof createArenaServer>, name: string) {
  const response = await server.inject({
    method: "POST",
    url: "/api/experiments",
    payload: { name },
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
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list.json<ExperimentListResponse>()).toEqual({ experiments: [created] });
    expect(detail.json<Experiment>()).toEqual(created);
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
});
