import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArenaServer } from "@maze-arena/server/app";
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
  const server = createArenaServer({ databasePath });
  servers.push(server);
  return server;
}

function useServerAsFetch(server: ReturnType<typeof createArenaServer>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await server.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
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
});
