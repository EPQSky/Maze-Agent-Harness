import { expect, test, type Page } from "@playwright/test";

const experiment = {
  id: "e2e-experiment", name: "长期自治实验", status: "paused", createdAt: "2026-09-02T12:00:00.000Z",
  costLimit: 1,
  modelProfile: { providerId: "fake-basic", modelId: "compact-v1", credentialRef: "dsh-credential://basic",
    contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000, providerLabel: "Fake", modelLabel: "Compact" },
  harnessEnvironments: { generator: { home: "/g/home", workspace: "/g/work" }, solver: { home: "/s/home", workspace: "/s/work" } },
};
const runtime = {
  experimentId: experiment.id, state: "paused", phase: "paused", generation: 1, stagnationCount: 0,
  champions: { generator: "a".repeat(40), solver: "b".repeat(40) }, pauseRequested: false,
  usage: { tokens: 200, cost: 0 }, budget: { tokenLimit: 5_000, costLimit: null },
  evaluationSuiteId: "suite-1", sealGroupId: "group-1", sealed: true, evolutionPermitted: true,
  compatibilityFingerprint: "maze-arena-v1",
  generations: [{ generation: 1, status: "completed", stagnationCount: 0, exhibitionMatchId: "match-exhibition",
    generator: { candidateCommit: "c".repeat(40), championBefore: "a".repeat(40), championAfter: "c".repeat(40), outcome: "promoted", promotionTag: "promotion/e2e/generator/g0001", publicProgress: 2, hiddenProgress: 1, aggregate: { primary: 2 } },
    solver: { candidateCommit: "d".repeat(40), championBefore: "b".repeat(40), championAfter: "b".repeat(40), outcome: "tie", promotionTag: null, publicProgress: 2, hiddenProgress: 1, aggregate: { primary: 1 } } }],
};
const match = { id: "match-exhibition", experimentId: experiment.id, seed: "public-e2e", protocolVersion: 1,
  status: "completed", committedEventCount: 3, totalEventCount: 3,
  score: { solved: true, actions: 0, illegalMoves: 0, backtracks: 0, remainingSteps: 1441 },
  observation: { id: "match-exhibition", generation: 1, role: "exhibition", opponent: "aaaa / bbbb",
    evaluationType: "exhibition", result: "completed", replayable: true } };
const events = [
  { protocolVersion: 1, sequence: 1, type: "match.started", seed: "public-e2e", size: 31, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 }, stepBudget: 1441 },
  { protocolVersion: 1, sequence: 2, type: "maze.carved", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
  { protocolVersion: 1, sequence: 3, type: "match.completed", score: match.score },
];

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/experiments" ? { experiments: [experiment] }
      : path === "/api/harness/models" ? { credentialRefs: [], providers: [] }
      : path.endsWith("/baseline-validation") ? { experimentId: experiment.id, status: "ready", steps: [], operatorConfirmed: true, frozenConfiguration: {}, frozenDigest: "digest", smoke: { attempted: false, passed: null } }
      : path.endsWith("/runtime") ? runtime
      : path.endsWith("/audit-events") ? { events: [{ id: 1, experimentId: experiment.id, type: "harness.activity", occurredAt: "2026-09-02T12:00:01.000Z", details: { role: "generator", executionKind: "real-provider", protocolVersion: 1, outcome: "succeeded", usageTokens: 64, usageCost: 0 } }], nextId: 1 }
      : path.endsWith("/lineages") ? { generator: [{ commit: runtime.champions.generator, subject: "baseline: generator", tags: ["baseline/e2e/generator"] }], solver: [{ commit: runtime.champions.solver, subject: "baseline: solver", tags: ["baseline/e2e/solver"] }] }
      : path.endsWith("/matches/latest") ? match
      : path.endsWith("/matches") ? { matches: [match] }
      : path.endsWith("/events") ? { match, events, nextSequence: 3 }
      : path === `/api/matches/${match.id}` ? match
      : { error: { code: "MATCH_NOT_FOUND", message: "not found" } };
    await route.fulfill({ status: "error" in body ? 404 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("工作台导航、筛选、播放和画布布局可用", async ({ page }, testInfo) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "长期自治实验" })).toBeVisible();
    await expect(page.getByRole("img", { name: "迷宫比赛画布" })).toBeVisible();
    await expect.poll(() => page.getByLabel("事件位置").getAttribute("max")).toBe("3");
    await page.getByLabel("跳到开头").click();
    await page.getByLabel("单步前进").click();
    await expect(page.getByLabel("事件位置")).toHaveValue("1");
    await page.getByLabel("播放速度").selectOption("8");
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect(page.getByLabel("事件位置")).toHaveValue("3");
    await page.getByLabel("跳到结尾").click();
    await expect(page.getByText("已解决")).toBeVisible();

    await page.getByRole("tab", { name: "Matches" }).click();
    await page.getByLabel("角色筛选").selectOption("generator");
    await expect(page.getByText("match-exhibition")).toHaveCount(0);
    await page.getByLabel("角色筛选").selectOption("exhibition");
    await expect(page.getByText("match-exhibition")).toBeVisible();
    await page.getByRole("tab", { name: "Lineages" }).click();
    await expect(page.getByText("baseline: generator baseline/e2e/generator", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Audit" }).click();
    await expect(page.getByText(/实际提供方返回/)).toBeVisible();

    const canvasPixels = await page.getByRole("img", { name: "迷宫比赛画布" }).evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] !== 8 || data[index + 1] !== 16 || data[index + 2] !== 21) colored += 1;
      }
      return colored;
    });
    expect(canvasPixels).toBeGreaterThan(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const overlaps = await page.evaluate(() => {
      const selectors = [".topbar", ".experiment-panel", ".detail-panel", ".workbench-tabs", ".workbench-view", ".maze-canvas", ".arena-sidebar"];
      const nodes = selectors.map((selector) => ({ selector, node: document.querySelector(selector) as HTMLElement | null }))
        .filter((entry): entry is { selector: string; node: HTMLElement } => Boolean(entry.node) && entry.node.offsetParent !== null);
      const allowedContainment = (left: Element, right: Element) => left.contains(right) || right.contains(left);
      const failures: string[] = [];
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
          const left = nodes[leftIndex]!;
          const right = nodes[rightIndex]!;
          if (allowedContainment(left.node, right.node)) continue;
          const a = left.node.getBoundingClientRect();
          const b = right.node.getBoundingClientRect();
          const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (width > 1 && height > 1) failures.push(`${left.selector}/${right.selector}`);
        }
      }
      return failures;
    });
    expect(overlaps, `${testInfo.project.name} 关键区域发生重叠`).toEqual([]);
});

test("直播 WebSocket 失败后从权威 HTTP 事件记录补齐", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__wsAttempts", { value: 0, writable: true });
    class FailingWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = FailingWebSocket.OPEN;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        super();
        (window as typeof window & { __wsAttempts: number }).__wsAttempts += 1;
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
      send() {}
      close() {}
    }
    Object.defineProperty(window, "WebSocket", { value: FailingWebSocket });
  });
  const runningMatch = { ...match, status: "running", committedEventCount: 0, totalEventCount: 3, score: null };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/experiments" ? { experiments: [experiment] }
      : path === "/api/harness/models" ? { credentialRefs: [], providers: [] }
      : path.endsWith("/baseline-validation") ? { experimentId: experiment.id, status: "ready", steps: [], operatorConfirmed: true, frozenConfiguration: {}, frozenDigest: "digest", smoke: { attempted: false, passed: null } }
      : path.endsWith("/runtime") ? runtime
      : path.endsWith("/audit-events") ? { events: [], nextId: 0 }
      : path.endsWith("/lineages") ? { generator: [], solver: [] }
      : path.endsWith("/matches/latest") ? runningMatch
      : path.endsWith("/matches") ? { matches: [runningMatch] }
      : path.endsWith("/events") ? { match, events, nextSequence: 3 }
      : path === `/api/matches/${match.id}` ? runningMatch
      : { error: { code: "MATCH_NOT_FOUND", message: "not found" } };
    await route.fulfill({ status: "error" in body ? 404 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __wsAttempts: number }).__wsAttempts)).toBeGreaterThan(0);
  await expect.poll(() => page.getByLabel("事件位置").getAttribute("max")).toBe("3");
  await page.getByLabel("跳到结尾").click();
  await expect(page.getByText("已解决")).toBeVisible();
});
