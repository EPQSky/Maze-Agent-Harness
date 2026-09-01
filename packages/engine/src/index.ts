export const GRID_SIZE = 31;
export const START = { x: 0, y: 0 } as const;
export const GOAL = { x: GRID_SIZE - 1, y: GRID_SIZE - 1 } as const;
export const MAX_SOLVER_STEPS = 1_441;

const LOOP_OPEN_PROBABILITY = 0.05;

export type Direction = "north" | "east" | "south" | "west";
export type SolverActionKind = "move" | "backtrack";
export type MatchPhase = "generation" | "solving" | "completed";

export interface Coordinate {
  x: number;
  y: number;
}

export interface Passage {
  from: Coordinate;
  to: Coordinate;
}

export interface MazeSnapshot {
  size: number;
  start: Coordinate;
  goal: Coordinate;
  passages: Passage[];
}

export interface SolverAction {
  direction: Direction;
  kind: SolverActionKind;
}

export interface SolverActionResult {
  direction: Direction;
  moved: boolean;
}

export interface SolverObservation {
  position: Coordinate;
  start: Coordinate;
  goal: Coordinate;
  openDirections: Direction[];
  remainingSteps: number;
  previousAction: SolverActionResult | null;
}

export interface SolverPolicy {
  nextAction(observation: SolverObservation): SolverAction;
}

export interface MatchScore {
  solved: boolean;
  actions: number;
  illegalMoves: number;
  backtracks: number;
  remainingSteps: number;
}

interface SequencedEvent {
  protocolVersion: 1;
  sequence: number;
}

export type MatchEvent = SequencedEvent & (
  | { type: "match.started"; seed: string; size: number; start: Coordinate; goal: Coordinate; stepBudget: number }
  | { type: "maze.carved"; from: Coordinate; to: Coordinate }
  | { type: "maze.completed"; passageCount: number }
  | { type: "solver.action"; step: number; action: SolverAction; from: Coordinate; to: Coordinate; moved: boolean }
  | { type: "match.completed"; score: MatchScore }
);

type MatchEventInput = MatchEvent extends infer Event
  ? Event extends SequencedEvent ? Omit<Event, keyof SequencedEvent> : never
  : never;

export interface MatchResult {
  maze: MazeSnapshot;
  events: MatchEvent[];
  score: MatchScore;
}

export interface MatchProjection {
  phase: MatchPhase;
  sequence: number;
  size: number;
  start: Coordinate;
  goal: Coordinate;
  passages: Passage[];
  solver: Coordinate;
  actions: number;
  score: MatchScore | null;
}

const directionDelta: Record<Direction, Coordinate> = {
  north: { x: 0, y: -1 },
  east: { x: 1, y: 0 },
  south: { x: 0, y: 1 },
  west: { x: -1, y: 0 },
};

function key({ x, y }: Coordinate): string {
  return `${x},${y}`;
}

function sameCoordinate(left: Coordinate, right: Coordinate): boolean {
  return left.x === right.x && left.y === right.y;
}

function passageKey({ from, to }: Passage): string {
  return [key(from), key(to)].sort().join("|");
}

function move(position: Coordinate, direction: Direction): Coordinate {
  const delta = directionDelta[direction];
  return { x: position.x + delta.x, y: position.y + delta.y };
}

function directionBetween(from: Coordinate, to: Coordinate): Direction {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === -1) return "north";
  if (dx === 1 && dy === 0) return "east";
  if (dx === 0 && dy === 1) return "south";
  if (dx === -1 && dy === 0) return "west";
  throw new Error("坐标不是相邻单元格");
}

function createSeededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function generateBaselineMaze(seed: string): MazeSnapshot {
  const passages: Passage[] = [];
  const random = createSeededRandom(seed);
  const visited = new Set<string>([key(START)]);
  const stack: Coordinate[] = [{ ...START }];

  while (stack.length > 0) {
    const current = stack.at(-1) as Coordinate;
    const unvisitedNeighbors = (Object.keys(directionDelta) as Direction[])
      .map((direction) => move(current, direction))
      .filter(({ x, y }) => x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE)
      .filter((neighbor) => !visited.has(key(neighbor)));

    if (unvisitedNeighbors.length === 0) {
      stack.pop();
      continue;
    }

    const next = unvisitedNeighbors[Math.floor(random() * unvisitedNeighbors.length)] as Coordinate;
    passages.push({ from: { ...current }, to: { ...next } });
    visited.add(key(next));
    stack.push(next);
  }

  const carved = new Set(passages.map(passageKey));
  // 生成树完成后才开环，保证前段事件保留可审计的 DFS 首访顺序。
  for (let y = 0; y < GRID_SIZE; y += 1) {
    for (let x = 0; x < GRID_SIZE; x += 1) {
      const from = { x, y };
      for (const to of [{ x: x + 1, y }, { x, y: y + 1 }]) {
        if (to.x >= GRID_SIZE || to.y >= GRID_SIZE) continue;
        const passage = { from, to };
        if (!carved.has(passageKey(passage)) && random() < LOOP_OPEN_PROBABILITY) {
          passages.push(passage);
          carved.add(passageKey(passage));
        }
      }
    }
  }

  return {
    size: GRID_SIZE,
    start: { ...START },
    goal: { ...GOAL },
    passages,
  };
}

export function validateMaze(maze: MazeSnapshot): { valid: boolean; reachableCells: number; reason?: string } {
  if (maze.size !== GRID_SIZE) return { valid: false, reachableCells: 0, reason: "网格必须为 31x31" };
  if (!sameCoordinate(maze.start, START) || !sameCoordinate(maze.goal, GOAL)) {
    return { valid: false, reachableCells: 0, reason: "起终点不符合冻结规则" };
  }

  const adjacency = new Map<string, Coordinate[]>();
  const seenPassages = new Set<string>();
  for (const passage of maze.passages) {
    const { from, to } = passage;
    const inBounds = [from, to].every(({ x, y }) => x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE);
    const adjacent = Math.abs(from.x - to.x) + Math.abs(from.y - to.y) === 1;
    const canonical = passageKey(passage);
    if (!inBounds || !adjacent || seenPassages.has(canonical)) {
      return { valid: false, reachableCells: 0, reason: "凿通操作必须唯一且连接相邻单元格" };
    }
    seenPassages.add(canonical);
    adjacency.set(key(from), [...(adjacency.get(key(from)) ?? []), to]);
    adjacency.set(key(to), [...(adjacency.get(key(to)) ?? []), from]);
  }

  const visited = new Set<string>([key(START)]);
  const queue: Coordinate[] = [{ ...START }];
  while (queue.length > 0) {
    const current = queue.shift() as Coordinate;
    for (const neighbor of adjacency.get(key(current)) ?? []) {
      if (!visited.has(key(neighbor))) {
        visited.add(key(neighbor));
        queue.push(neighbor);
      }
    }
  }
  if (visited.size !== GRID_SIZE * GRID_SIZE) {
    return { valid: false, reachableCells: visited.size, reason: "所有单元格必须全局连通" };
  }
  return { valid: true, reachableCells: visited.size };
}

export function createBaselineSolver(): SolverPolicy {
  const visited = new Set<string>();
  const path: Coordinate[] = [];
  const priority: Direction[] = ["south", "east", "west", "north"];

  return {
    nextAction(observation) {
      const current = { ...observation.position };
      const currentKey = key(current);
      visited.add(currentKey);
      if (!sameCoordinate(path.at(-1) ?? current, current)) {
        const existing = path.findIndex((coordinate) => sameCoordinate(coordinate, current));
        if (existing >= 0) path.splice(existing + 1);
      }
      if (!sameCoordinate(path.at(-1) ?? { x: -1, y: -1 }, current)) path.push(current);

      const direction = priority.find((candidate) => {
        return observation.openDirections.includes(candidate) && !visited.has(key(move(current, candidate)));
      });
      if (direction) return { direction, kind: "move" };

      const parent = path.at(-2);
      if (!parent) return { direction: observation.openDirections[0] ?? "north", kind: "backtrack" };
      path.pop();
      return { direction: directionBetween(current, parent), kind: "backtrack" };
    },
  };
}

function openDirections(maze: MazeSnapshot, position: Coordinate): Direction[] {
  const directions: Direction[] = [];
  for (const passage of maze.passages) {
    if (sameCoordinate(passage.from, position)) directions.push(directionBetween(passage.from, passage.to));
    if (sameCoordinate(passage.to, position)) directions.push(directionBetween(passage.to, passage.from));
  }
  return directions;
}

export function runMazeMatch(options: { seed: string; solver: SolverPolicy }): MatchResult {
  const maze = generateBaselineMaze(options.seed);
  const validation = validateMaze(maze);
  if (!validation.valid) throw new Error(validation.reason);

  let sequence = 0;
  const event = (value: MatchEventInput): MatchEvent => ({
    ...value,
    protocolVersion: 1,
    sequence: ++sequence,
  } as unknown as MatchEvent);
  const events: MatchEvent[] = [event({
    type: "match.started",
    seed: options.seed,
    size: GRID_SIZE,
    start: { ...START },
    goal: { ...GOAL },
    stepBudget: MAX_SOLVER_STEPS,
  })];
  for (const passage of maze.passages) events.push(event({ type: "maze.carved", ...passage }));
  events.push(event({ type: "maze.completed", passageCount: maze.passages.length }));

  let position: Coordinate = { ...START };
  let previousAction: SolverActionResult | null = null;
  let actions = 0;
  let illegalMoves = 0;
  let backtracks = 0;
  while (!sameCoordinate(position, GOAL) && actions < MAX_SOLVER_STEPS) {
    const action = options.solver.nextAction({
      position: { ...position },
      start: { ...START },
      goal: { ...GOAL },
      openDirections: openDirections(maze, position),
      remainingSteps: MAX_SOLVER_STEPS - actions,
      previousAction,
    });
    const from = { ...position };
    const candidate = move(position, action.direction);
    const moved = openDirections(maze, position).includes(action.direction);
    actions += 1;
    if (moved) position = candidate;
    else illegalMoves += 1;
    if (action.kind === "backtrack") backtracks += 1;
    previousAction = { direction: action.direction, moved };
    events.push(event({
      type: "solver.action",
      step: actions,
      action,
      from,
      to: { ...position },
      moved,
    }));
  }

  const score: MatchScore = {
    solved: sameCoordinate(position, GOAL),
    actions,
    illegalMoves,
    backtracks,
    remainingSteps: MAX_SOLVER_STEPS - actions,
  };
  events.push(event({ type: "match.completed", score }));
  return { maze, events, score };
}

export function runBaselineMatch(seed: string): MatchResult {
  return runMazeMatch({ seed, solver: createBaselineSolver() });
}

export function createInitialProjection(): MatchProjection {
  return {
    phase: "generation",
    sequence: 0,
    size: GRID_SIZE,
    start: { ...START },
    goal: { ...GOAL },
    passages: [],
    solver: { ...START },
    actions: 0,
    score: null,
  };
}

export function projectMatchEvents(initial: MatchProjection, events: readonly MatchEvent[]): MatchProjection {
  const projection: MatchProjection = {
    ...initial,
    passages: [...initial.passages],
    solver: { ...initial.solver },
  };
  for (const event of events) {
    if (event.sequence <= projection.sequence) throw new Error("比赛事件序号必须严格单调");
    projection.sequence = event.sequence;
    if (event.type === "match.started") {
      projection.size = event.size;
      projection.start = { ...event.start };
      projection.goal = { ...event.goal };
      projection.solver = { ...event.start };
    } else if (event.type === "maze.carved") {
      projection.passages.push({ from: { ...event.from }, to: { ...event.to } });
    } else if (event.type === "maze.completed") {
      projection.phase = "solving";
    } else if (event.type === "solver.action") {
      projection.solver = { ...event.to };
      projection.actions = event.step;
    } else if (event.type === "match.completed") {
      projection.phase = "completed";
      projection.score = { ...event.score };
    }
  }
  return projection;
}
