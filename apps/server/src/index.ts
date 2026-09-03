import { resolve } from "node:path";
import { createArenaServer } from "./app.js";
import { createProductionHarnessAdapter } from "./production-harness.js";
import { DockerMatchProfileCommandFactory, HarnessMatchProfileInstaller, NativePluginMatchRunner } from "@maze-arena/match-profile";

const databasePath = resolve(process.env.ARENA_DATABASE_PATH ?? ".data/maze-arena.sqlite");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const harnessAdapter = createProductionHarnessAdapter(process.env);
const matchImage = process.env.ARENA_MATCH_IMAGE;
const trustedRoot = process.env.ARENA_MATCH_TRUSTED_ROOT;
const protocolBundle = process.env.ARENA_MATCH_PROTOCOL_PACKAGE;
const generatorPlugin = process.env.ARENA_GENERATOR_PLUGIN_PACKAGE;
const solverPlugin = process.env.ARENA_SOLVER_PLUGIN_PACKAGE;
const dshExecutable = process.env.DSH_EXECUTABLE ?? "dsh";
const harnessVersion = process.env.DSH_HARNESS_VERSION;
if (!matchImage || !trustedRoot || !protocolBundle || !generatorPlugin || !solverPlugin || !harnessVersion) {
  throw new Error("生产启动必须配置摘要锁定的 Match Profile 镜像、隔离 Harness home 与三个 bundle 包路径");
}
await new HarnessMatchProfileInstaller({
  executable: dshExecutable,
  expectedVersion: harnessVersion,
  home: trustedRoot,
  protocolBundle,
  roleBundles: { generator: generatorPlugin, solver: solverPlugin },
}).prepare();
const matchRunner = new NativePluginMatchRunner(new DockerMatchProfileCommandFactory(matchImage, trustedRoot));
const server = createArenaServer({ databasePath, harnessAdapter, matchRunner, logger: true });

try {
  await server.listen({ port, host: "127.0.0.1" });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
