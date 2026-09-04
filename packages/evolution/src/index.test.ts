import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginLineageRepository } from "@maze-arena/lineage";
import { describe, expect, it, vi } from "vitest";
import { assertNoPrivateEvolutionData, runEvolutionAttempt, type EvolutionHarnessSession } from "./index.js";

const championRoot = resolve(import.meta.dirname, "../../generator-plugin");

function fakeLineage() {
  const commitCandidate = vi.fn(async (input: { outcome: string; generation?: number }) => ({
    commit: "a".repeat(40), role: "generator" as const, outcome: input.outcome as "failed",
    promotionTag: input.outcome === "promoted" ? `promotion/exp/generator/g${String(input.generation).padStart(4, "0")}` : undefined,
  }));
  return { commitCandidate, lineage: { commitCandidate } as unknown as PluginLineageRepository };
}

function baseOptions(session: EvolutionHarnessSession, lineage: PluginLineageRepository) {
  return {
    experimentId: "exp", generation: 2, attemptId: "attempt-1", role: "generator" as const,
    championRoot, isolatedRoot: mkdtempSync(join(tmpdir(), "maze-evolution-")), lineage,
    input: { lineagePlans: [], trustedResults: [], publicTraces: [], hiddenAggregate: {
      completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
      promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
      evaluatedHiddenCaseCount: 0, metricTotals: {},
    } },
    createSession: () => session,
  };
}

describe("自主进化闭环", () => {
  it("新会话只获得限定工具和类型化数据，修复后隐藏评测恰好一次并晋级", async () => {
    const requests: unknown[] = [];
    const session: EvolutionHarnessSession = {
      run: (request) => { requests.push(request); return { hypothesis: "减少回溯", strategyPlan: "尝试新的启发式", submitted: true }; },
      close: vi.fn(),
    };
    const { lineage, commitCandidate } = fakeLineage();
    let publicCalls = 0;
    const beginRepairAttempt = vi.fn();
    const hiddenEvaluate = vi.fn(async () => ({ promote: true, resultSummary: "隐藏评测胜出" }));
    const options = baseOptions(session, lineage);
    const result = await runEvolutionAttempt({
      ...options,
      beginRepairAttempt,
      publicGate: async () => ({ passed: ++publicCalls >= 3, diagnostics: ["公开门禁失败"] }),
      hiddenEvaluate,
    });
    expect(result).toMatchObject({ status: "evaluated", repairs: 2, hiddenEvaluationCount: 1, promoted: true });
    expect(hiddenEvaluate).toHaveBeenCalledTimes(1);
    expect(beginRepairAttempt.mock.calls).toEqual([[0], [1], [2]]);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      allowedTools: ["read", "edit", "search", "shell", "test", "public-check", "submit"],
      input: { role: "generator", hiddenAggregate: { completedAttemptCount: 0 } },
    });
    expect(JSON.stringify(requests)).not.toContain("network");
    expect(JSON.stringify(requests)).not.toContain("subagent");
    expect(commitCandidate).toHaveBeenCalledWith(expect.objectContaining({ outcome: "promoted", generation: 2 }));
    const workspace = (requests[0] as { workspace: string }).workspace;
    expect(readFileSync(join(workspace, "lineage/attempt-1.md"), "utf8")).toBe("尝试新的启发式");
  });

  it("每次候选尝试从源码创建空 home，并剔除 Git、依赖、产物和缓存目录", async () => {
    const isolatedSource = mkdtempSync(join(tmpdir(), "maze-evolution-source-"));
    writeFileSync(join(isolatedSource, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    mkdirSync(join(isolatedSource, "src"));
    writeFileSync(join(isolatedSource, "src/index.ts"), "export const baseline = true;\n");
    for (const directory of [".git", "node_modules", "dist", ".cache", ".turbo", "coverage"]) {
      mkdirSync(join(isolatedSource, directory), { recursive: true });
      writeFileSync(join(isolatedSource, directory, "inherited"), "forbidden");
    }
    const { lineage } = fakeLineage();
    const session: EvolutionHarnessSession = {
      run: async (request) => {
        expect(request.home).not.toBe(request.workspace);
        expect(existsSync(request.home)).toBe(true);
        expect(readFileSync(join(request.workspace, "src/index.ts"), "utf8")).toContain("baseline");
        for (const directory of [".git", "node_modules", "dist", ".cache", ".turbo", "coverage"]) {
          expect(existsSync(join(request.workspace, directory))).toBe(false);
        }
        return { hypothesis: "隔离候选", strategyPlan: "保持工作区净化", submitted: false };
      },
      close: () => undefined,
    };

    await expect(runEvolutionAttempt({
      ...baseOptions(session, lineage),
      championRoot: isolatedSource,
      publicGate: vi.fn(),
      hiddenEvaluate: vi.fn(),
    })).resolves.toMatchObject({ status: "invalid-candidate" });
  });

  it("三次修复仍失败时保留失败候选且不运行隐藏评测", async () => {
    const session: EvolutionHarnessSession = {
      run: async () => ({ hypothesis: "无效尝试", strategyPlan: "记录失败", submitted: true }), close: () => undefined,
    };
    const { lineage, commitCandidate } = fakeLineage();
    const hiddenEvaluate = vi.fn();
    const result = await runEvolutionAttempt({
      ...baseOptions(session, lineage), publicGate: async () => ({ passed: false, diagnostics: ["仍失败"] }), hiddenEvaluate,
    });
    expect(result).toMatchObject({ status: "public-gate-failed", repairs: 3, hiddenEvaluationCount: 0, promoted: false });
    expect(hiddenEvaluate).not.toHaveBeenCalled();
    expect(commitCandidate).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("模型成功响应但未提交候选时记为进化失败", async () => {
    const session: EvolutionHarnessSession = {
      run: async () => ({ hypothesis: "只有分析", strategyPlan: "无提交", submitted: false }), close: () => undefined,
    };
    const { lineage, commitCandidate } = fakeLineage();
    const result = await runEvolutionAttempt({
      ...baseOptions(session, lineage), publicGate: vi.fn(), hiddenEvaluate: vi.fn(),
    });
    expect(result.status).toBe("invalid-candidate");
    expect(commitCandidate).not.toHaveBeenCalled();
  });

  it.each(["relative-link", "absolute-link", "fifo"] as const)("Harness 返回后在公开门禁前拒绝工作区异常文件：%s", async (kind) => {
    const { lineage, commitCandidate } = fakeLineage();
    const publicGate = vi.fn();
    const session: EvolutionHarnessSession = {
      run: async (request) => {
        const unsafePath = join(request.workspace, "unsafe-entry");
        if (kind === "relative-link") symlinkSync("src/index.ts", unsafePath);
        else if (kind === "absolute-link") symlinkSync("/etc/passwd", unsafePath);
        else {
          const { spawnSync } = await import("node:child_process");
          expect(spawnSync("mkfifo", [unsafePath]).status).toBe(0);
        }
        return { hypothesis: "链接绕过", strategyPlan: "不应进入门禁", submitted: true };
      },
      close: () => undefined,
    };
    await expect(runEvolutionAttempt({
      ...baseOptions(session, lineage), publicGate, hiddenEvaluate: vi.fn(),
    })).rejects.toThrow(kind === "fifo" ? /不支持的文件类型/ : /符号链接/);
    expect(publicGate).not.toHaveBeenCalled();
    expect(commitCandidate).not.toHaveBeenCalled();
  });

  it("求解器输入拒绝生成种子、完整拓扑、最短路径和对手控制文本", () => {
    for (const field of ["generationSeed", "mazeTopology", "shortestPath", "opponentSource", "opponentStderr", "prompt", "reasoning", "toolCalls"]) {
      expect(() => assertNoPrivateEvolutionData({ role: "solver", [field]: "secret" })).toThrow(/禁止字段/);
    }
    expect(() => assertNoPrivateEvolutionData({
      role: "solver", publicTraces: [{ events: [{ type: "solver.decision", direction: "east" }] }],
    })).not.toThrow();
  });

  it("私有字段在创建 Harness 会话前关闭失败", async () => {
    const createSession = vi.fn();
    const { lineage } = fakeLineage();
    const options = baseOptions({ run: vi.fn(), close: vi.fn() }, lineage);
    await expect(runEvolutionAttempt({
      ...options,
      input: { ...options.input, opponentSource: "恶意对手文本" } as never,
      createSession,
      publicGate: vi.fn(),
      hiddenEvaluate: vi.fn(),
    })).rejects.toThrow(/进化输入包含禁止字段/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("Solver 候选不能修改依赖、比赛配置档或协议", async () => {
    const { lineage, commitCandidate } = fakeLineage();
    const session: EvolutionHarnessSession = {
      run: async (request) => {
        const packagePath = join(request.workspace, "package.json");
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        packageJson.dependencies = { injected: "1.0.0" };
        const { writeFileSync } = await import("node:fs");
        writeFileSync(packagePath, JSON.stringify(packageJson));
        return { hypothesis: "越界候选", strategyPlan: "不应保存", submitted: true };
      }, close: () => undefined,
    };
    const options = baseOptions(session, lineage);
    await expect(runEvolutionAttempt({
      ...options, role: "solver", publicGate: vi.fn(), hiddenEvaluate: vi.fn(),
    })).rejects.toThrow(/不得修改依赖集合/);
    expect(commitCandidate).not.toHaveBeenCalled();
  });

  it("Solver 使用独立会话和局部类型化输入完成一次晋级", async () => {
    const environments: Array<{ home: string; workspace: string }> = [];
    const { lineage, commitCandidate } = fakeLineage();
    const session: EvolutionHarnessSession = {
      run: async (request) => {
        expect(request.input.role).toBe("solver");
        expect(request.input.publicTraces[0]?.events[0]).toEqual({
          type: "solver.decision", position: { x: 0, y: 0 }, openDirections: ["east"],
          remainingSteps: 10, direction: "east", kind: "move",
        });
        return { hypothesis: "局部记忆优化", strategyPlan: "只依据局部观察", submitted: true };
      }, close: () => undefined,
    };
    const options = baseOptions(session, lineage);
    const result = await runEvolutionAttempt({
      ...options,
      role: "solver",
      input: {
        ...options.input,
        publicTraces: [{
          attemptId: "attempt-0", generation: 1, traceId: "public-trace-1", outcome: "success",
          metrics: { solved: 1, actions: 1, illegalActions: 0 },
          events: [{ type: "solver.decision", position: { x: 0, y: 0 }, openDirections: ["east"], remainingSteps: 10, direction: "east", kind: "move" }],
        }],
      },
      createSession: (environment) => { environments.push(environment); return session; },
      publicGate: async () => ({ passed: true, diagnostics: [] }),
      hiddenEvaluate: async () => ({ promote: true, resultSummary: "Solver 晋级" }),
    });
    expect(environments).toHaveLength(1);
    expect(environments[0]!.home).not.toBe(environments[0]!.workspace);
    expect(result).toMatchObject({ promoted: true, hiddenEvaluationCount: 1 });
    expect(commitCandidate).toHaveBeenCalledWith(expect.objectContaining({ role: "solver", outcome: "promoted" }));
  });
});
