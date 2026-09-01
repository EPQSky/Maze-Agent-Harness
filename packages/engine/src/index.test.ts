import { describe, expect, it } from "vitest";
import {
  GOAL,
  GRID_SIZE,
  MAX_SOLVER_STEPS,
  START,
  createInitialProjection,
  projectMatchEvents,
  runBaselineMatch,
  runMazeMatch,
  validateMaze,
  type Coordinate,
  type SolverPolicy,
} from "./index.js";

describe("Maze Arena Engine", () => {
  it("生成满足固定规则且全连通的 31x31 基线迷宫", () => {
    const match = runBaselineMatch("ticket-03-seed");

    expect({ size: GRID_SIZE, start: START, goal: GOAL, budget: MAX_SOLVER_STEPS }).toEqual({
      size: 31,
      start: { x: 0, y: 0 },
      goal: { x: 30, y: 30 },
      budget: 1_441,
    });
    expect(validateMaze(match.maze)).toEqual({ valid: true, reachableCells: 961 });
    expect(match.maze.passages.length).toBeGreaterThan(960);
    expect(new Set(match.maze.passages.map(({ from, to }) =>
      [from, to].map(({ x, y }) => `${x},${y}`).sort().join("|")
    )).size).toBe(match.maze.passages.length);
    expect(match.score.solved).toBe(true);
    expect(match.score.actions).toBeLessThanOrEqual(MAX_SOLVER_STEPS);
  });

  it("先以随机化 DFS 回溯生成树，再按固定概率开通环路", () => {
    const maze = runBaselineMatch("ticket-03-seed").maze;
    const treePassages = maze.passages.slice(0, GRID_SIZE * GRID_SIZE - 1);
    const visited = new Set<string>([`${START.x},${START.y}`]);
    const stack: Coordinate[] = [{ ...START }];

    for (const { from, to } of treePassages) {
      const fromKey = `${from.x},${from.y}`;
      const toKey = `${to.x},${to.y}`;
      while (stack.length > 0 && `${stack.at(-1)?.x},${stack.at(-1)?.y}` !== fromKey) stack.pop();
      expect(stack.at(-1)).toEqual(from);
      expect(visited.has(toKey)).toBe(false);
      visited.add(toKey);
      stack.push(to);
    }

    expect(visited.size).toBe(GRID_SIZE * GRID_SIZE);
    expect(maze.passages.length).toBeGreaterThan(treePassages.length);
  });

  it("冻结输入重复执行时事件和评分逐字节一致", () => {
    const first = runBaselineMatch("same-seed");
    const second = runBaselineMatch("same-seed");

    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(JSON.stringify(first.score)).toBe(JSON.stringify(second.score));
    expect(first.events.every((event, index) => event.sequence === index + 1)).toBe(true);
    expect(JSON.stringify(first.events)).not.toMatch(/createdAt|timestamp|duration|Date/);
  });

  it("不同种子确定性选择不同拓扑", () => {
    const first = runBaselineMatch("topology-a");
    const second = runBaselineMatch("topology-b");
    const topology = (match: typeof first) => [...match.maze.passages]
      .map(({ from, to }) => [from, to].map(({ x, y }) => `${x},${y}`).sort().join("|"))
      .sort();

    expect(topology(first)).not.toEqual(topology(second));
  });

  it("拒绝重复凿通、错误端点和非连通拓扑", () => {
    const valid = runBaselineMatch("validation-seed").maze;
    expect(validateMaze({ ...valid, passages: [...valid.passages, valid.passages[0]!] }).valid).toBe(false);
    expect(validateMaze({ ...valid, goal: { x: 29, y: 30 } }).reason).toMatch(/起终点/);
    expect(validateMaze({ ...valid, passages: valid.passages.slice(1) }).reason).toMatch(/连通/);
  });

  it("求解策略只接收局部观察，不接收种子或完整拓扑", () => {
    let observedKeys: string[] = [];
    const solver: SolverPolicy = {
      nextAction(observation) {
        observedKeys = Object.keys(observation).sort();
        return { direction: "north", kind: "move" };
      },
    };
    runMazeMatch({ seed: "hidden-seed", solver });

    expect(observedKeys).toEqual([
      "goal", "openDirections", "position", "previousAction", "remainingSteps", "start",
    ]);
  });

  it("非法移动消耗求解步骤并在预算耗尽时失败", () => {
    const illegalSolver: SolverPolicy = { nextAction: () => ({ direction: "north", kind: "move" }) };
    const match = runMazeMatch({ seed: "illegal", solver: illegalSolver });

    expect(match.score).toMatchObject({ solved: false, actions: 1_441, illegalMoves: 1_441 });
    expect(match.events.filter((event) => event.type === "solver.action")).toHaveLength(1_441);
  });

  it("逐批直播投影与完整历史回放得到相同终态", () => {
    const match = runBaselineMatch("projection-seed");
    const midpoint = Math.floor(match.events.length / 2);
    const live = projectMatchEvents(
      projectMatchEvents(createInitialProjection(), match.events.slice(0, midpoint)),
      match.events.slice(midpoint),
    );
    const replay = projectMatchEvents(createInitialProjection(), match.events);

    expect(live).toEqual(replay);
    expect(replay.phase).toBe("completed");
    expect(replay.solver).toEqual(GOAL);
    expect(replay.score).toEqual(match.score);
  });
});
