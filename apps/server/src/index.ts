import { resolve } from "node:path";
import { createArenaServer } from "./app.js";
import { createProductionHarnessAdapter } from "./production-harness.js";

const databasePath = resolve(process.env.ARENA_DATABASE_PATH ?? ".data/maze-arena.sqlite");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const harnessAdapter = createProductionHarnessAdapter(process.env);
const server = createArenaServer({ databasePath, harnessAdapter, logger: true });

try {
  await server.listen({ port, host: "127.0.0.1" });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
