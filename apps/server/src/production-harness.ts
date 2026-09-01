import { resolve } from "node:path";
import {
  ExportedHarnessConfigAdapter,
  HarnessConfigurationError,
  type HarnessAdapter,
} from "@maze-arena/dsh-integration";

export function createProductionHarnessAdapter(environment: NodeJS.ProcessEnv): HarnessAdapter {
  const exportPath = environment.DSH_HARNESS_EXPORT_PATH;
  const harnessVersion = environment.DSH_HARNESS_VERSION;
  if (!exportPath || !harnessVersion) {
    throw new HarnessConfigurationError("生产启动必须配置 DSH_HARNESS_EXPORT_PATH 与 DSH_HARNESS_VERSION");
  }
  return ExportedHarnessConfigAdapter.fromFile(resolve(exportPath), harnessVersion);
}
