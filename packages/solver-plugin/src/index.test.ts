import { describe, expect, it } from "vitest";
import type { MatchPluginContext, SolverCapability } from "@maze-arena/contracts";
import { apply } from "./index.js";

describe("Solver 原生插件", () => {
  it("只注册一个能力、只消费局部观察并可卸载", () => {
    const registrations = new Map<string, unknown>();
    const context: MatchPluginContext = {
      provide(name, capability) {
        registrations.set(name, capability);
        return () => { registrations.delete(name); };
      },
    };
    const dispose = apply(context);
    expect([...registrations.keys()]).toEqual(["mazeSolver"]);
    const capability = registrations.get("mazeSolver") as SolverCapability;
    capability.handle({ type: "solver.start", start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } });
    expect(capability.handle({
      type: "solver.next", position: { x: 0, y: 0 }, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 },
      openDirections: ["east"], remainingSteps: 1_441, previousAction: null,
    })).toEqual({ type: "solver.move", direction: "east", kind: "move" });
    dispose();
    expect(registrations.size).toBe(0);
  });
});
