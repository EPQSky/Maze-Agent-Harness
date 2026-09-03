import { describe, expect, it } from "vitest";
import type { GeneratorCapability, MatchPluginContext } from "@maze-arena/contracts";
import { apply } from "./index.js";

describe("Generator 原生插件", () => {
  it("只注册一个能力并可卸载", () => {
    const registrations = new Map<string, unknown>();
    const context: MatchPluginContext = {
      provide(name, capability) {
        if (registrations.has(name)) throw new Error("重复能力");
        registrations.set(name, capability);
        return () => { registrations.delete(name); };
      },
    };
    const dispose = apply(context);
    expect([...registrations.keys()]).toEqual(["mazeGenerator"]);
    const capability = registrations.get("mazeGenerator") as GeneratorCapability;
    expect(capability.handle({
      type: "generator.start",
      seed: "native-generator",
      rules: { size: 31, start: { x: 0, y: 0 }, goal: { x: 30, y: 30 } },
    })).toMatchObject({ type: "generator.carve" });
    dispose();
    expect(registrations.size).toBe(0);
  });
});
