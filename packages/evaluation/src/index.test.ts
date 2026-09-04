import { createBaselineSolver, generateBaselineMaze, type MatchScore, type MazeSnapshot, type SolverPolicy } from "@maze-arena/engine";
import { describe, expect, it } from "vitest";
import {
  evaluateGeneratorPair,
  evaluateAsyncSolverPair,
  evaluateSolverPair,
  shortestPathLength,
  topologyHash,
  type EvaluationCase,
  type FrozenEvaluationContext,
  type GeneratorEvaluationPlugin,
} from "./index.js";

const context: FrozenEvaluationContext = {
  opponentVersion: "solver-frozen-1",
  imageDigest: "sha256:image",
  resourcePolicyDigest: "sha256:resources",
};
const cases: EvaluationCase[] = [
  { id: "public-b", seed: "b", visibility: "public" },
  { id: "hidden-a", seed: "h", visibility: "hidden" },
  { id: "public-a", seed: "a", visibility: "public" },
];

function generator(
  version: string,
  mazeForSeed: (seed: string) => MazeSnapshot = (seed) => generateBaselineMaze(seed),
  options: { protocolValid?: boolean; resourceCompliant?: boolean; cpuUsec?: number } = {},
): GeneratorEvaluationPlugin {
  return {
    version,
    generate: (seed) => ({
      maze: mazeForSeed(seed),
      protocolValid: options.protocolValid ?? true,
      resourceCompliant: options.resourceCompliant ?? true,
      trace: [{ seed, version }],
      telemetry: { cpuUsec: options.cpuUsec ?? 1, wallClockMs: options.cpuUsec ?? 1 },
    }),
  };
}

function solver(scores: Map<string, Partial<MatchScore>> = new Map()) {
  return {
    version: "solver-frozen-1",
    solve(maze: MazeSnapshot): MatchScore {
      const shortest = shortestPathLength(maze);
      const override = scores.get(topologyHash(maze)) ?? {};
      const actions = override.actions ?? shortest;
      return {
        solved: override.solved ?? true,
        actions,
        illegalMoves: override.illegalMoves ?? 0,
        backtracks: override.backtracks ?? 0,
        remainingSteps: 1_441 - actions,
      };
    },
  };
}

describe("生成器配对评测", () => {
  it("双方使用相同排序案例和冻结上下文，隐藏结果只暴露聚合", async () => {
    const observed: string[] = [];
    const candidate = generator("candidate");
    const original = candidate.generate.bind(candidate);
    candidate.generate = async (seed, frozen) => {
      observed.push(`candidate:${seed}:${JSON.stringify(frozen)}`);
      return original(seed, frozen);
    };
    const champion = generator("champion");
    const result = await evaluateGeneratorPair({ candidate, champion, solver: solver(), cases, context });

    expect(observed.map((entry) => entry.split(":")[1])).toEqual(["h", "a", "b"]);
    expect(observed.every((entry) => entry.endsWith(JSON.stringify(context)))).toBe(true);
    expect(result.publicCases.map(({ caseId }) => caseId)).toEqual(["public-a", "public-b"]);
    expect(result.hidden).toEqual({
      caseCount: 1,
      candidate: expect.any(Object),
      champion: expect.any(Object),
    });
    expect(JSON.stringify(result.hidden)).not.toContain("trace");
  });

  it.each([
    ["协议", { protocolValid: false }, "protocol"],
    ["资源", { resourceCompliant: false }, "resource"],
  ] as const)("%s硬门禁失败计为生成失败", async (_label, options, gate) => {
    const result = await evaluateGeneratorPair({
      candidate: generator("candidate", undefined, options),
      champion: generator("champion"), solver: solver(), cases: [cases[0]!], context,
    });
    expect(result.publicCases[0]?.candidate).toMatchObject({ failed: true, gateFailure: gate });
    expect(result.promote).toBe(false);
  });

  it("非法迷宫在调用冻结求解器前关闭失败", async () => {
    let solverCalls = 0;
    const frozenSolver = solver();
    const solve = frozenSolver.solve.bind(frozenSolver);
    frozenSolver.solve = (maze) => { solverCalls += 1; return solve(maze); };
    const result = await evaluateGeneratorPair({
      candidate: generator("candidate", () => ({ ...generateBaselineMaze("x"), passages: [] })),
      champion: generator("champion"), solver: frozenSolver, cases: [cases[0]!], context,
    });
    expect(result.publicCases[0]?.candidate.gateFailure).toBe("maze");
    expect(solverCalls).toBe(1);
  });

  it("优先选择更多求解失败，其次更多额外动作", async () => {
    const candidateMaze = generateBaselineMaze("candidate-maze");
    const championMaze = generateBaselineMaze("champion-maze");
    const scores = new Map<string, Partial<MatchScore>>([
      [topologyHash(candidateMaze), { solved: false, actions: 1_441 }],
      [topologyHash(championMaze), { solved: true, actions: shortestPathLength(championMaze) + 2 }],
    ]);
    const moreFailures = await evaluateGeneratorPair({
      candidate: generator("candidate", () => candidateMaze), champion: generator("champion", () => championMaze),
      solver: solver(scores), cases: [cases[0]!], context,
    });
    expect(moreFailures.promote).toBe(true);

    scores.set(topologyHash(candidateMaze), { solved: true, actions: shortestPathLength(candidateMaze) + 12 });
    const harder = await evaluateGeneratorPair({
      candidate: generator("candidate", () => candidateMaze), champion: generator("champion", () => championMaze),
      solver: solver(scores), cases: [cases[0]!], context,
    });
    expect(harder.total.candidate.extraActions).toBe(12);
    expect(harder.promote).toBe(true);
  });

  it("额外动作相同时以不同规范拓扑数量比较结构新颖度", async () => {
    const candidate = generator("candidate", (seed) => generateBaselineMaze(`candidate-${seed}`));
    const championMaze = generateBaselineMaze("champion-fixed");
    const result = await evaluateGeneratorPair({
      candidate, champion: generator("champion", () => championMaze), solver: solver(), cases, context,
    });
    expect(result.total.candidate.structuralNovelty).toBe(3);
    expect(result.total.champion.structuralNovelty).toBe(1);
    expect(result.promote).toBe(true);
  });

  it("完全平局不晋级，CPU 与墙钟遥测变化不改变结论", async () => {
    const first = await evaluateGeneratorPair({
      candidate: generator("candidate", undefined, { cpuUsec: 1 }),
      champion: generator("champion", undefined, { cpuUsec: 999_999 }), solver: solver(), cases, context,
    });
    const second = await evaluateGeneratorPair({
      candidate: generator("candidate", undefined, { cpuUsec: 999_999 }),
      champion: generator("champion", undefined, { cpuUsec: 1 }), solver: solver(), cases, context,
    });
    expect(first.promote).toBe(false);
    expect(second.promote).toBe(false);
    expect(first.total).toEqual(second.total);
  });

  it("公开首要指标退化时即使隐藏总分更优也不晋级", async () => {
    const publicCandidateMaze = generateBaselineMaze("public-candidate");
    const publicChampionMaze = generateBaselineMaze("public-champion");
    const hiddenCandidateMaze = generateBaselineMaze("hidden-candidate");
    const hiddenChampionMaze = generateBaselineMaze("hidden-champion");
    const candidate = generator("candidate", (seed) => seed === "public" ? publicCandidateMaze : hiddenCandidateMaze);
    const champion = generator("champion", (seed) => seed === "public" ? publicChampionMaze : hiddenChampionMaze);
    const scores = new Map<string, Partial<MatchScore>>([
      [topologyHash(publicCandidateMaze), { solved: true }],
      [topologyHash(publicChampionMaze), { solved: false, actions: 1_441 }],
      [topologyHash(hiddenCandidateMaze), { solved: false, actions: 1_441 }],
      [topologyHash(hiddenChampionMaze), { solved: true }],
    ]);
    const result = await evaluateGeneratorPair({
      candidate, champion, solver: solver(scores),
      cases: [
        { id: "01-public", seed: "public", visibility: "public" },
        { id: "02-hidden", seed: "hidden", visibility: "hidden" },
      ], context,
    });
    expect(result.publicPrimaryRegressed).toBe(true);
    expect(result.promote).toBe(false);
  });
});

describe("求解器配对评测", () => {
  it("异步隔离 Solver 仍共享每案例唯一冻结迷宫并沿用平局不晋级", async () => {
    const generated: string[] = [];
    const solveInputs = { candidate: [] as string[], champion: [] as string[] };
    const asyncSolver = (version: keyof typeof solveInputs) => ({
      version,
      async solve(seed: string, maze: MazeSnapshot) {
        solveInputs[version].push(`${seed}:${topologyHash(maze)}`);
        return { score: { solved: true, extraActions: 0, illegalActions: 0 }, trace: [] };
      },
    });
    const result = await evaluateAsyncSolverPair({
      candidate: asyncSolver("candidate"), champion: asyncSolver("champion"),
      generator: { version: "generator-frozen-1", generate(seed) { generated.push(seed); return generateBaselineMaze(seed); } },
      cases,
      context,
    });
    expect(generated).toEqual(["h", "a", "b"]);
    expect(solveInputs.candidate).toEqual(solveInputs.champion);
    expect(result.publicCases.map(({ caseId }) => caseId)).toEqual(["public-a", "public-b"]);
    expect(result.promote).toBe(false);
  });

  function solverPlugin(version: string, createPolicy: () => SolverPolicy, cpuUsec = 1) {
    return { version, createPolicy, telemetry: { cpuUsec, wallClockMs: cpuUsec } };
  }
  const frozenGenerator = {
    version: "generator-frozen-1",
    generate: (seed: string) => generateBaselineMaze(seed),
  };

  it("冻结生成器每个案例只生成一次，双方共享同一快照", async () => {
    const generated: string[] = [];
    const generator = {
      version: "generator-frozen-1",
      generate(seed: string) { generated.push(seed); return generateBaselineMaze(seed); },
    };
    const result = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver),
      champion: solverPlugin("champion", createBaselineSolver), generator, cases, context,
    });
    expect(generated).toEqual(["h", "a", "b"]);
    expect(result.promote).toBe(false);
  });

  it("Solver 轨迹只包含局部观察且不含种子、拓扑或可信最短路径", async () => {
    const result = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver),
      champion: solverPlugin("champion", createBaselineSolver), generator: frozenGenerator, cases: [cases[0]!], context,
    });
    const observation = result.publicCases[0]!.candidate.trace[0]!.observation as unknown as Record<string, unknown>;
    expect(Object.keys(observation).sort()).toEqual([
      "goal", "openDirections", "position", "previousAction", "remainingSteps", "start",
    ]);
    expect(JSON.stringify(observation)).not.toContain(cases[0]!.seed);
    expect(observation).not.toHaveProperty("maze");
    expect(observation).not.toHaveProperty("shortestPath");
  });

  it("优先更多成功案例，并覆盖预算耗尽", async () => {
    const result = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver),
      champion: solverPlugin("champion", () => ({ nextAction: () => ({ direction: "north", kind: "move" }) })),
      generator: frozenGenerator, cases: [cases[0]!], context,
    });
    expect(result.total).toMatchObject({ candidate: { solvedCases: 1 }, champion: { solvedCases: 0 } });
    expect(result.promote).toBe(true);
  });

  it("成功数相同时优先更少额外动作，再优先更少非法动作", async () => {
    const oneWrongMove = () => {
      const delegate = createBaselineSolver();
      let first = true;
      return {
        nextAction(observation: Parameters<SolverPolicy["nextAction"]>[0]) {
          if (first) { first = false; return { direction: "north" as const, kind: "move" as const }; }
          return delegate.nextAction(observation);
        },
      };
    };
    const result = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver),
      champion: solverPlugin("champion", oneWrongMove), generator: frozenGenerator, cases: [cases[0]!], context,
    });
    expect(result.total.candidate.solvedCases).toBe(result.total.champion.solvedCases);
    expect(result.total.candidate.extraActions).toBeLessThan(result.total.champion.extraActions);
    expect(result.total.candidate.illegalActions).toBeLessThan(result.total.champion.illegalActions);
    expect(result.promote).toBe(true);
  });

  it("错误移动和非法领域动作由 Arena 计数，自报字段不能影响评分", async () => {
    const invalid = solverPlugin("candidate", () => ({
      nextAction: () => ({ direction: "teleport", kind: "move", solved: true, actions: 0 } as never),
    }));
    const result = await evaluateSolverPair({
      candidate: invalid, champion: solverPlugin("champion", createBaselineSolver),
      generator: frozenGenerator, cases: [cases[0]!], context,
    });
    expect(result.total.candidate).toMatchObject({ illegalActions: 1_441 });
    expect(result.promote).toBe(false);
  });

  it("CPU 与墙钟遥测不影响评分，完全平局不晋级", async () => {
    const first = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver, 1), champion: solverPlugin("champion", createBaselineSolver, 999),
      generator: frozenGenerator, cases, context,
    });
    const second = await evaluateSolverPair({
      candidate: solverPlugin("candidate", createBaselineSolver, 999), champion: solverPlugin("champion", createBaselineSolver, 1),
      generator: frozenGenerator, cases, context,
    });
    expect(first.total).toEqual(second.total);
    expect(first.promote).toBe(false);
    expect(second.promote).toBe(false);
  });

  it("公开成功案例数退化时不因隐藏评测翻盘", async () => {
    const candidate = solverPlugin("candidate", () => ({ nextAction: () => ({ direction: "north", kind: "move" }) }));
    const result = await evaluateSolverPair({
      candidate,
      champion: solverPlugin("champion", createBaselineSolver),
      generator: frozenGenerator,
      cases: [{ id: "public", seed: "public", visibility: "public" }], context,
    });
    expect(result.publicPrimaryRegressed).toBe(true);
    expect(result.promote).toBe(false);
  });
});
