import { pathToFileURL } from "node:url";
import type { GeneratorCapability, MatchEvent, SolverCapability } from "@maze-arena/contracts";
import {
  GOAL, GRID_SIZE, MAX_SOLVER_STEPS, START, validateMaze,
  type MatchResult, type MatchScore, type MazeSnapshot,
} from "@maze-arena/engine";

type UnsequencedEvent = MatchEvent extends infer Event
  ? Event extends MatchEvent ? Omit<Event, "protocolVersion" | "sequence"> : never
  : never;

export async function runVersionedPluginMatch(input: {
  seed: string;
  generatorRoot: string;
  solverRoot: string;
  onEvents?: (events: readonly MatchEvent[]) => Promise<void> | void;
}): Promise<MatchResult> {
  const generatorModule = await import(`${pathToFileURL(`${input.generatorRoot}/dist/index.js`).href}?v=${Date.now()}`) as {
    createGeneratorCapability(): GeneratorCapability;
  };
  const solverModule = await import(`${pathToFileURL(`${input.solverRoot}/dist/index.js`).href}?v=${Date.now()}`) as {
    createSolverCapability(): SolverCapability;
  };
  const generator = generatorModule.createGeneratorCapability();
  const solver = solverModule.createSolverCapability();
  const events: MatchEvent[] = [];
  const passages: MazeSnapshot["passages"] = [];
  let sequence = 0;
  const emit = async (event: UnsequencedEvent) => {
    const sequenced = { ...event, protocolVersion: 1 as const, sequence: ++sequence } as MatchEvent;
    events.push(sequenced);
    await input.onEvents?.([sequenced]);
  };
  await emit({ type: "match.started", seed: input.seed, size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, stepBudget: MAX_SOLVER_STEPS });
  let generated = await generator.handle({ type: "generator.start", seed: input.seed, rules: { size: GRID_SIZE, start: START, goal: GOAL } });
  while (generated.type !== "generator.complete") {
    passages.push({ from: { ...generated.from }, to: { ...generated.to } });
    await emit({ type: "maze.carved", from: { ...generated.from }, to: { ...generated.to } });
    generated = await generator.handle({ type: "generator.next" });
  }
  const maze: MazeSnapshot = { size: GRID_SIZE, start: { ...START }, goal: { ...GOAL }, passages };
  const validation = validateMaze(maze);
  if (!validation.valid) throw new Error(validation.reason ?? "版本化 Generator 产生非法迷宫");
  await emit({ type: "maze.completed", passageCount: passages.length });
  const ready = await solver.handle({ type: "solver.start", start: START, goal: GOAL });
  if (ready.type !== "solver.ready") throw new Error("版本化 Solver 初始化失败");
  const passageKeys = new Set(passages.map(({ from, to }) => passageKey(from, to)));
  let position: { x: number; y: number } = { ...START };
  let previousAction: { direction: "north" | "east" | "south" | "west"; moved: boolean } | null = null;
  let actions = 0;
  let illegalMoves = 0;
  let backtracks = 0;
  while (!same(position, GOAL) && actions < MAX_SOLVER_STEPS) {
    const openDirections = (["north", "east", "south", "west"] as const)
      .filter((direction) => passageKeys.has(passageKey(position, moved(position, direction))));
    const response = await solver.handle({ type: "solver.next", position: { ...position }, start: START, goal: GOAL,
      openDirections: [...openDirections], remainingSteps: MAX_SOLVER_STEPS - actions, previousAction });
    if (response.type !== "solver.move") throw new Error("版本化 Solver 动作响应非法");
    const from = { ...position };
    const candidate = moved(position, response.direction);
    const didMove = openDirections.includes(response.direction);
    actions += 1;
    if (didMove) position = candidate;
    else illegalMoves += 1;
    if (response.kind === "backtrack") backtracks += 1;
    previousAction = { direction: response.direction, moved: didMove };
    await emit({ type: "solver.action", step: actions, action: { direction: response.direction, kind: response.kind },
      from, to: { ...position }, moved: didMove });
  }
  const score: MatchScore = { solved: same(position, GOAL), actions, illegalMoves, backtracks, remainingSteps: MAX_SOLVER_STEPS - actions };
  await emit({ type: "match.completed", score });
  return { maze, events, score };
}

function key(value: { x: number; y: number }): string { return `${value.x},${value.y}`; }
function passageKey(left: { x: number; y: number }, right: { x: number; y: number }): string {
  return [key(left), key(right)].sort().join("|");
}
function same(left: { x: number; y: number }, right: { x: number; y: number }): boolean {
  return left.x === right.x && left.y === right.y;
}
function moved(position: { x: number; y: number }, direction: "north" | "east" | "south" | "west") {
  const [dx, dy] = direction === "north" ? [0, -1] : direction === "east" ? [1, 0] : direction === "south" ? [0, 1] : [-1, 0];
  return { x: position.x + dx, y: position.y + dy };
}
