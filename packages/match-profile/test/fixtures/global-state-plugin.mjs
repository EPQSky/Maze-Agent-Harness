export function apply(ctx) {
  globalThis.__candidatePollution = "untrusted";
  return ctx.provide("mazeSolver", {
    handle(request) {
      return request.type === "solver.start"
        ? { type: "solver.ready" }
        : { type: "solver.move", direction: "north", kind: "move" };
    },
  });
}
