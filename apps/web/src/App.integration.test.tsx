import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createArenaServer } from "@maze-arena/server/app";
import { DeterministicFakeHarnessAdapter } from "@maze-arena/dsh-integration";
import { runBaselineMatch } from "@maze-arena/engine";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const servers: ReturnType<typeof createArenaServer>[] = [];

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createServer(databasePath: string) {
  const server = createArenaServer({
    databasePath,
    harnessAdapter: new DeterministicFakeHarnessAdapter(),
    matchRunner: { run: async (seed: string) => runBaselineMatch(seed) },
  });
  servers.push(server);
  return server;
}

function useServerAsFetch(server: ReturnType<typeof createArenaServer>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await server.inject({
      method: (init?.method ?? "GET") as "GET" | "POST" | "PUT",
      url: input.toString(),
      headers: init?.headers as Record<string, string> | undefined,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });

    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  });
}

describe("实验工作台端到端持久化", () => {
  it("从 Web 经公共 API 创建实验，并在 Server 重启后从 SQLite 恢复", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-web-api-"));
    const databasePath = join(directory, "arena.sqlite");
    const firstServer = createServer(databasePath);
    useServerAsFetch(firstServer);
    const user = userEvent.setup();

    const firstRender = render(<App />);
    await screen.findByText("尚无实验，请先创建一个草稿。");
    await user.type(screen.getByLabelText("新实验名称"), "贯通链路实验");
    await user.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByRole("heading", { name: "贯通链路实验" })).toBeInTheDocument();
    expect(screen.getByText("确定性基础提供方 / Compact V1")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "实验列表" })).getByText("草稿")).toBeInTheDocument();

    firstRender.unmount();
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restartedServer = createServer(databasePath);
    useServerAsFetch(restartedServer);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "贯通链路实验" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "实验列表" })).getByText("贯通链路实验")).toBeInTheDocument();
  });

  it("迁移旧实验后由 Web 补全配置，再启动并冻结配置", async () => {
    const directory = mkdtempSync(join(tmpdir(), "maze-arena-web-legacy-"));
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
      .run("legacy-web-id", "旧版实验", "draft", "2026-08-31T23:00:00.000Z");
    legacy.close();

    const server = createServer(databasePath);
    useServerAsFetch(server);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "旧版实验" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "尚未配置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启动实验" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存到当前草稿" }));
    expect(await screen.findByText("确定性基础提供方 / Compact V1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "执行验收" }));
    await user.click(await screen.findByRole("button", { name: "确认并冻结" }));
    await user.click(await screen.findByRole("button", { name: "启动进化" }));

    expect(await screen.findByText("generation.snapshot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存到当前草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启动进化" })).not.toBeInTheDocument();

    const detail = await server.inject({ method: "GET", url: "/api/experiments/legacy-web-id" });
    expect(detail.json()).toMatchObject({
      status: "running",
      modelProfile: { providerId: "fake-basic", credentialRef: "dsh-credential://basic" },
    });
  });
});
