import type { Experiment, ExperimentListResponse, HarnessCatalogResponse } from "@maze-arena/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, toModelProfileInput } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("实验工作台", () => {
  it("派生实验复用冻结配置时不携带仅供展示的提供方与模型标签", () => {
    expect(toModelProfileInput({
      providerId: "custom-basic", modelId: "custom-compact", credentialRef: "dsh-credential://existing",
      contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
      providerLabel: "确定性基础提供方", modelLabel: "Compact V1",
    })).toEqual({
      providerId: "custom-basic", modelId: "custom-compact", credentialRef: "dsh-credential://existing",
      contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
    });
  });

  it("终态实验保留历史 Arena，但不显示运行基线比赛入口", async () => {
    const completed: Experiment = {
      id: "completed-id", name: "已完成实验", status: "completed", createdAt: "2026-09-01T10:00:00.000Z",
      modelProfile: null, costLimit: null,
      harnessEnvironments: {
        generator: { home: "/h/c/g/home", workspace: "/h/c/g/workspace" },
        solver: { home: "/h/c/s/home", workspace: "/h/c/s/workspace" },
      },
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ experiments: [completed] } satisfies ExperimentListResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ providers: [] } satisfies HarnessCatalogResponse)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "MATCH_NOT_FOUND", message: "无历史" } }), { status: 404 })));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "已完成实验" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "运行基线比赛" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "迷宫比赛画布" })).toBeInTheDocument();
  });

  it("首屏读取实验，并允许创建后查看草稿详情", async () => {
    const existing = {
      id: "existing-id",
      name: "已有实验",
      status: "draft" as const,
      createdAt: "2026-09-01T08:00:00.000Z",
      costLimit: null,
      modelProfile: {
        providerId: "custom-basic", modelId: "custom-compact", credentialRef: "dsh-credential://existing",
        contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
        providerLabel: "确定性基础提供方", modelLabel: "Compact V1",
      },
      harnessEnvironments: {
        generator: { home: "/h/e/g/home", workspace: "/h/e/g/workspace" },
        solver: { home: "/h/e/s/home", workspace: "/h/e/s/workspace" },
      },
    };
    const created: Experiment = {
      id: "new-id",
      name: "新的实验",
      status: "draft" as const,
      createdAt: "2026-09-01T09:00:00.000Z",
      costLimit: null,
      modelProfile: {
        providerId: "custom-reasoning", modelId: "custom-reasoner", credentialRef: "dsh-credential://reasoning",
        reasoningEffort: "high", contextTokens: 16_000, outputTokens: 2_000, totalTokenLimit: 20_000,
        providerLabel: "确定性推理提供方", modelLabel: "Reasoner V1",
      },
      harnessEnvironments: {
        generator: { home: "/h/n/g/home", workspace: "/h/n/g/workspace" },
        solver: { home: "/h/n/s/home", workspace: "/h/n/s/workspace" },
      },
    };
    const catalog: HarnessCatalogResponse = { providers: [
      {
        id: "custom-basic", label: "确定性基础提供方", models: [{ id: "custom-compact", label: "Compact V1", capabilities: {
          reasoningEfforts: [], temperature: { minimum: 0, maximum: 2 }, topP: { minimum: 0, maximum: 1 },
          maxContextTokens: 8_000, maxOutputTokens: 2_000, maxTotalTokens: 10_000,
          providerOptions: { deterministicSeed: { type: "number", minimum: 0, maximum: 999_999 } },
        } }],
      },
      {
        id: "custom-reasoning", label: "确定性推理提供方", models: [{ id: "custom-reasoner", label: "Reasoner V1", capabilities: {
          reasoningEfforts: ["low", "medium", "high"], maxContextTokens: 32_000, maxOutputTokens: 8_000,
          maxTotalTokens: 40_000, providerOptions: { thinkingBudget: { type: "number", minimum: 1_000, maximum: 20_000 } },
        } }],
      },
    ] };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      if (url === "/api/experiments" && init?.method === "POST") return new Response(JSON.stringify(created), { status: 201 });
      if (url === "/api/experiments") return new Response(JSON.stringify({ experiments: [existing] } satisfies ExperimentListResponse));
      if (url === "/api/harness/models") return new Response(JSON.stringify(catalog));
      if (url.endsWith("/baseline-validation")) return new Response(JSON.stringify({ experimentId: url, status: "pending", steps: [], operatorConfirmed: false, frozenConfiguration: null, frozenDigest: null, smoke: { attempted: false, passed: null } }));
      if (url.endsWith("/audit-events")) return new Response(JSON.stringify({ events: [], nextId: 0 }));
      return new Response(JSON.stringify({ error: { code: "MATCH_NOT_FOUND", message: "无历史" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const experimentList = await screen.findByRole("region", { name: "实验列表" });
    expect(experimentList).toHaveTextContent("已有实验");
    expect(screen.queryByRole("button", { name: "保存到当前草稿" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("新实验名称"), "新的实验");
    await user.selectOptions(screen.getByLabelText("模型提供方"), "custom-reasoning");
    await user.type(screen.getByLabelText("凭据引用"), "dsh-credential://reasoning");
    await user.type(screen.getByLabelText("成本上限"), "1.25");
    await user.selectOptions(screen.getByLabelText("推理强度"), "high");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "新的实验" })).toBeInTheDocument());
    expect(within(experimentList).getAllByText("草稿")).toHaveLength(2);
    expect(screen.getByText("确定性推理提供方 / Reasoner V1")).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/experiments" && init?.method === "POST");
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({
      costLimit: 1.25,
      modelProfile: { providerId: "custom-reasoning", modelId: "custom-reasoner", credentialRef: "dsh-credential://reasoning", reasoningEffort: "high" },
    });
  });

  it("从仅有自定义 ID 的目录初始化首个模型并直接提交该配置", async () => {
    const catalog: HarnessCatalogResponse = { providers: [{
      id: "vendor-only",
      label: "Vendor Only",
      models: [{
        id: "model-only",
        label: "Model Only",
        capabilities: {
          reasoningEfforts: ["low"],
          maxContextTokens: 12_000,
          maxOutputTokens: 2_000,
          maxTotalTokens: 14_000,
          providerOptions: {},
        },
      }],
    }] };
    const created: Experiment = {
      id: "custom-created",
      name: "自定义目录实验",
      status: "draft",
      createdAt: "2026-09-01T10:00:00.000Z",
      costLimit: null,
      modelProfile: {
        providerId: "vendor-only", modelId: "model-only", credentialRef: "dsh-credential://vendor",
        reasoningEffort: "low", contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
        providerLabel: "Vendor Only", modelLabel: "Model Only",
      },
      harnessEnvironments: {
        generator: { home: "/h/c/g/home", workspace: "/h/c/g/workspace" },
        solver: { home: "/h/c/s/home", workspace: "/h/c/s/workspace" },
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      if (url === "/api/experiments" && init?.method === "POST") return new Response(JSON.stringify(created), { status: 201 });
      if (url === "/api/experiments") return new Response(JSON.stringify({ experiments: [] } satisfies ExperimentListResponse));
      if (url === "/api/harness/models") return new Response(JSON.stringify(catalog));
      if (url.endsWith("/baseline-validation")) return new Response(JSON.stringify({ experimentId: url, status: "pending", steps: [], operatorConfirmed: false, frozenConfiguration: null, frozenDigest: null, smoke: { attempted: false, passed: null } }));
      if (url.endsWith("/audit-events")) return new Response(JSON.stringify({ events: [], nextId: 0 }));
      return new Response(JSON.stringify({ error: { code: "MATCH_NOT_FOUND", message: "无历史" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("option", { name: "Vendor Only" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Model Only" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("新实验名称"), "自定义目录实验");
    await user.type(screen.getByLabelText("凭据引用"), "dsh-credential://vendor");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/experiments" && init?.method === "POST")).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/experiments" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({
      modelProfile: {
        providerId: "vendor-only",
        modelId: "model-only",
        reasoningEffort: "low",
        contextTokens: 4_000,
        outputTokens: 1_000,
        totalTokenLimit: 5_000,
      },
    });
  });
});
