import type {
  Coordinate,
  MatchPluginContext,
  MazeDirection,
  SolverCapability,
  SolverRequest,
  SolverResponse,
} from "@maze-arena/contracts";

export const name = "maze-solver-plugin";

const deltas: Record<MazeDirection, readonly [number, number]> = {
  north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0],
};

function key(value: Coordinate): string { return `${value.x},${value.y}`; }
function move(value: Coordinate, direction: MazeDirection): Coordinate {
  const [dx, dy] = deltas[direction];
  return { x: value.x + dx, y: value.y + dy };
}
function directionBetween(from: Coordinate, to: Coordinate): MazeDirection {
  return (Object.keys(deltas) as MazeDirection[]).find((direction) => key(move(from, direction)) === key(to))
    ?? (() => { throw new Error("回退目标不是相邻单元格"); })();
}

export function createSolverCapability(): SolverCapability {
  const visited = new Set<string>();
  const path: Coordinate[] = [];
  let started = false;
  return {
    handle(request: SolverRequest): SolverResponse {
      if (request.type === "solver.start") {
        if (started) throw new Error("求解器已经初始化");
        started = true;
        path.push({ ...request.start });
        visited.add(key(request.start));
        return { type: "solver.ready" };
      }
      if (!started) throw new Error("求解器尚未初始化");
      const current = { ...request.position };
      visited.add(key(current));
      const knownIndex = path.findIndex((candidate) => key(candidate) === key(current));
      if (knownIndex >= 0) path.splice(knownIndex + 1);
      else path.push(current);
      const direction = (["south", "east", "west", "north"] as MazeDirection[])
        .find((candidate) => request.openDirections.includes(candidate) && !visited.has(key(move(current, candidate))));
      if (direction) return { type: "solver.move", direction, kind: "move" };
      const parent = path.at(-2);
      if (!parent) return { type: "solver.move", direction: request.openDirections[0] ?? "north", kind: "backtrack" };
      path.pop();
      return { type: "solver.move", direction: directionBetween(current, parent), kind: "backtrack" };
    },
  };
}

export function apply(ctx: MatchPluginContext): () => void {
  return ctx.provide("mazeSolver", createSolverCapability());
}
