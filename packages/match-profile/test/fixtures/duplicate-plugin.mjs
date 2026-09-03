export function apply(ctx) {
  const capability = { handle() { return { type: "solver.ready" }; } };
  ctx.provide("mazeSolver", capability);
  ctx.provide("mazeSolver", capability);
}
