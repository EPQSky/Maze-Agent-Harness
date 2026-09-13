import type {
  Coordinate,
  GeneratorCapability,
  GeneratorRequest,
  GeneratorResponse,
  MatchPluginContext,
} from "@maze-arena/contracts";

export const name = "maze-generator-plugin";

function coordinateKey(value: Coordinate): string {
  return `${value.x},${value.y}`;
}

function passageKey(from: Coordinate, to: Coordinate): string {
  return [coordinateKey(from), coordinateKey(to)].sort().join("|");
}

function randomFor(seed: string): () => number {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function buildPassages(seed: string, size: number): Array<{ from: Coordinate; to: Coordinate }> {
  const random = randomFor(seed);
  const passages: Array<{ from: Coordinate; to: Coordinate }> = [];
  const visited = new Set(["0,0"]);
  const stack: Coordinate[] = [{ x: 0, y: 0 }];
  const deltas = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

  while (stack.length > 0) {
    const current = stack.at(-1) as Coordinate;
    const candidates = deltas
      .map(([dx, dy]) => ({ x: current.x + dx, y: current.y + dy }))
      .filter(({ x, y }) => x >= 0 && y >= 0 && x < size && y < size)
      .filter((candidate) => !visited.has(coordinateKey(candidate)));
    if (candidates.length === 0) {
      stack.pop();
      continue;
    }
    const next = candidates[Math.floor(random() * candidates.length)] as Coordinate;
    passages.push({ from: { ...current }, to: { ...next } });
    visited.add(coordinateKey(next));
    stack.push(next);
  }

  const carved = new Set(passages.map(({ from, to }) => passageKey(from, to)));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (const to of [{ x: x + 1, y }, { x, y: y + 1 }]) {
        if (to.x >= size || to.y >= size) continue;
        const from = { x, y };
        const key = passageKey(from, to);
        // 5% 概率打通额外环路，保证迷宫仍存在唯一主干结构但非完美树。
        if (!carved.has(key) && random() < 0.05) {
          passages.push({ from, to });
          carved.add(key);
        }
      }
    }
  }
  return passages;
}

export function createGeneratorCapability(): GeneratorCapability {
  let pending: Array<{ from: Coordinate; to: Coordinate }> | undefined;
  return {
    handle(request: GeneratorRequest): GeneratorResponse {
      if (request.type === "generator.start") {
        if (pending) throw new Error("生成器已经初始化");
        pending = buildPassages(request.seed, request.rules.size);
      } else if (!pending) {
        throw new Error("生成器尚未初始化");
      }
      const passage = pending.shift();
      return passage ? { type: "generator.carve", ...passage } : { type: "generator.complete" };
    },
  };
}

export function apply(ctx: MatchPluginContext): () => void {
  // 单一可逆注册使 Harness 卸载时不会遗留跨比赛全局状态。
  return ctx.provide("mazeGenerator", createGeneratorCapability());
}
