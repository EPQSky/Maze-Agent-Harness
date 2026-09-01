import type { ExperimentListResponse } from "@maze-arena/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("实验工作台", () => {
  it("首屏读取实验，并允许创建后查看草稿详情", async () => {
    const existing = {
      id: "existing-id",
      name: "已有实验",
      status: "draft" as const,
      createdAt: "2026-09-01T08:00:00.000Z",
    };
    const created = {
      id: "new-id",
      name: "新的实验",
      status: "draft" as const,
      createdAt: "2026-09-01T09:00:00.000Z",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ experiments: [existing] } satisfies ExperimentListResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const experimentList = await screen.findByRole("region", { name: "实验列表" });
    expect(experimentList).toHaveTextContent("已有实验");

    await user.type(screen.getByLabelText("新实验名称"), "新的实验");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "新的实验" })).toBeInTheDocument());
    expect(within(experimentList).getAllByText("草稿")).toHaveLength(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/experiments", expect.objectContaining({ method: "POST" }));
  });
});
