import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Experiment,
  GeneratorResponse,
  MatchEventDelivery,
  MazeDirection,
  SolverResponse,
} from "@maze-arena/contracts";
import type { BaselineValidationAdapter, BaselineValidationStep } from "@maze-arena/control-plane";
import type { HarnessAdapter } from "@maze-arena/dsh-integration";
import {
  evaluateGeneratorPair,
  evaluateSolverPair,
  type FrozenEvaluationContext,
  type GeneratorEvaluationPlugin,
  type SolverEvaluationPlugin,
} from "@maze-arena/evaluation";
import {
  GOAL,
  START,
  createInitialProjection,
  projectMatchEvents,
  type MazeSnapshot,
  type SolverPolicy,
} from "@maze-arena/engine";
import { createGeneratorCapability } from "@maze-arena/generator-plugin";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { validatePluginPackage, type ArenaMatchRunner } from "@maze-arena/match-profile";
import { createSolverCapability } from "@maze-arena/solver-plugin";
import type { MatchRepository } from "./match-repository.js";

interface BaselineAdapterOptions {
  experiment: Experiment;
  harnessAdapter: HarnessAdapter;
  matchRunner: ArenaMatchRunner;
  matches: MatchRepository;
  lineage: PluginLineageRepository;
  pluginRoots: { generator: string; solver: string };
}

export function createRealBaselineValidationAdapter(options: BaselineAdapterOptions): BaselineValidationAdapter {
  let runs: Awaited<ReturnType<ArenaMatchRunner["run"]>>[] = [];
  let persistedMatchId: string | undefined;
  let pairedEvaluationsComplete = false;

  async function ensureRuns(): Promise<typeof runs> {
    if (runs.length > 0) return runs;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt));
      runs.push(await options.matchRunner.run("supervised-baseline-v1"));
    }
    return runs;
  }

  async function runStep(step: BaselineValidationStep) {
    switch (step) {
      case "model-config": {
        if (!options.experiment.modelProfile) throw new Error("模型配置档缺失");
        const { providerLabel: _providerLabel, modelLabel: _modelLabel, ...input } = options.experiment.modelProfile;
        options.harnessAdapter.validateModelProfile(input);
        return passed(step, "模型配置档已按当前 Harness 能力重新验证");
      }
      case "native-plugin-install": {
        const [generator, solver] = await Promise.all([
          validatePluginPackage(options.pluginRoots.generator),
          validatePluginPackage(options.pluginRoots.solver),
        ]);
        await options.lineage.initialize(options.experiment.id, "generator", options.pluginRoots.generator);
        await options.lineage.initialize(options.experiment.id, "solver", options.pluginRoots.solver);
        return passed(step, `Generator ${generator.runtime.files} 个运行文件；Solver ${solver.runtime.files} 个运行文件`);
      }
      case "isolated-match": {
        const [result] = await ensureRuns();
        if (!result?.score.solved || result.events.at(-1)?.type !== "match.completed") throw new Error("隔离比赛未产生成功终态");
        return passed(step, `隔离比赛提交 ${result.events.length} 个权威事件`);
      }
      case "event-replay": {
        const [result] = await ensureRuns();
        const projection = projectMatchEvents(createInitialProjection(), result!.events);
        if (projection.phase !== "completed" || !projection.score) throw new Error("事件流无法重建完成投影");
        return passed(step, `版本 1 事件重放得到 ${projection.actions} 个求解动作`);
      }
      case "determinism": {
        const results = await ensureRuns();
        const canonical = results.map((result) => Buffer.from(JSON.stringify({ events: result.events, score: result.score })).toString("base64"));
        if (!canonical.every((value) => value === canonical[0])) throw new Error("三次跨启动时序运行的完整事件与评分不一致");
        return passed(step, "三次完整事件序列与评分逐字节一致");
      }
      case "maze-legality": {
        const [result] = await ensureRuns();
        const projection = projectMatchEvents(createInitialProjection(), result!.events);
        if (projection.passages.length < 960 || !projection.score?.solved) throw new Error("迷宫未覆盖全部单元格或基线无法求解");
        return passed(step, `迷宫包含 ${projection.passages.length} 条合法通路且基线求解成功`);
      }
      case "persistence": {
        const [result] = await ensureRuns();
        if (!persistedMatchId) {
          const match = options.matches.start(options.experiment.id, "supervised-baseline-v1", result!.events.length);
          options.matches.appendEvents(match.id, result!.events, result!.score);
          persistedMatchId = match.id;
        }
        const restored = [];
        let cursor = 0;
        let page = options.matches.readEvents(persistedMatchId, cursor, 1_024);
        while (page && page.events.length > 0) {
          restored.push(...page.events);
          cursor = page.nextSequence;
          page = options.matches.readEvents(persistedMatchId, cursor, 1_024);
        }
        if (!page || page.match.status !== "completed" || restored.length !== result!.events.length
          || Buffer.from(JSON.stringify(restored)).compare(Buffer.from(JSON.stringify(result!.events))) !== 0) {
          throw new Error("SQLite 未完整恢复基线比赛");
        }
        return passed(step, `SQLite 已恢复比赛 ${persistedMatchId} 的全部事件`);
      }
      case "live-delivery": {
        if (!persistedMatchId) throw new Error("持久化步骤尚未产生比赛");
        const page = options.matches.readEvents(persistedMatchId, 0, 128);
        if (!page) throw new Error("无法读取直播事件页");
        const delivery: MatchEventDelivery = { type: "match.events", page };
        const decoded = JSON.parse(JSON.stringify(delivery)) as MatchEventDelivery;
        if (decoded.type !== "match.events" || decoded.page.events[0]?.sequence !== 1) throw new Error("直播载荷无法按协议往返");
        return passed(step, `直播首批 ${page.events.length} 个事件可按游标续传`);
      }
      case "paired-evaluation": {
        await runBaselinePairEvaluations();
        pairedEvaluationsComplete = true;
        return passed(step, "Generator 与 Solver 基线均完成公开和隐藏配对评测");
      }
      case "promotion-tag": {
        if (!pairedEvaluationsComplete) throw new Error("配对评测尚未完成");
        const scratch = mkdtempSync(join(tmpdir(), "maze-promotion-validation-"));
        const repository = new PluginLineageRepository(join(scratch, "lineages"), join(scratch, "validation.sqlite"));
        try {
          await repository.initialize("validation", "generator", options.pluginRoots.generator);
          const candidate = await repository.commitCandidate({
            experimentId: "validation", role: "generator", sourceRoot: options.pluginRoots.generator,
            attemptId: "baseline-validation", hypothesis: "验证 Promotion Tag 原子流程",
            resultSummary: "基线验收配对评测通过", outcome: "promoted", generation: 1,
          });
          repository.verifyIntegrity("validation", "generator");
          if (candidate.promotionTag !== "promotion/validation/generator/g0001") throw new Error("Promotion Tag 名称不符合冻结规则");
          return passed(step, `已创建并校验 ${candidate.promotionTag}`);
        } finally {
          repository.close();
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    }
  }

  async function runBaselinePairEvaluations(): Promise<void> {
    const cases = [
      { id: "public-1", seed: "baseline-public", visibility: "public" as const },
      { id: "hidden-1", seed: "baseline-hidden", visibility: "hidden" as const },
    ];
    const context: FrozenEvaluationContext = {
      opponentVersion: "baseline", imageDigest: "baseline-image", resourcePolicyDigest: "isolated-profile-v1",
    };
    const generator = baselineGeneratorEvaluationPlugin();
    const solver = baselineSolverEvaluationPlugin();
    const [generatorResult, solverResult] = await Promise.all([
      evaluateGeneratorPair({
        candidate: generator, champion: generator,
        solver: { version: "baseline-solver", solve: (maze) => import("@maze-arena/engine").then(({ runSolverOnMaze }) => runSolverOnMaze({ seed: "paired", maze, solver: baselineSolverPolicy() }).score) },
        cases, context,
      }),
      evaluateSolverPair({
        candidate: solver, champion: solver,
        generator: { version: "baseline-generator", generate: (seed) => generateBaselinePluginMaze(seed) },
        cases, context,
      }),
    ]);
    if (generatorResult.hidden.caseCount !== 1 || solverResult.hidden.caseCount !== 1) throw new Error("配对评测未包含隐藏案例");
  }

  return {
    runStep,
    smokeProvider: async () => {
      if (!options.experiment.modelProfile || !options.harnessAdapter.smokeModel) return { passed: false };
      const response = await options.harnessAdapter.smokeModel(options.experiment.modelProfile);
      return { passed: true, providerText: response.providerText };
    },
  };
}

function passed(step: BaselineValidationStep, diagnostic: string) {
  return { step, passed: true, diagnostics: [diagnostic] };
}

function generateBaselinePluginMaze(seed: string): MazeSnapshot {
  const capability = createGeneratorCapability();
  const passages: MazeSnapshot["passages"] = [];
  let response = synchronousResponse(capability.handle({
    type: "generator.start", seed, rules: { size: 31, start: START, goal: GOAL },
  }), "Generator");
  while (response.type !== "generator.complete") {
    passages.push({ from: { ...response.from }, to: { ...response.to } });
    response = synchronousResponse(capability.handle({ type: "generator.next" }), "Generator");
  }
  return { size: 31, start: { ...START }, goal: { ...GOAL }, passages };
}

function baselineGeneratorEvaluationPlugin(): GeneratorEvaluationPlugin {
  return {
    version: "baseline-generator",
    generate: (seed) => ({ maze: generateBaselinePluginMaze(seed), protocolValid: true, resourceCompliant: true, trace: [] }),
  };
}

function baselineSolverPolicy(): SolverPolicy {
  const capability = createSolverCapability();
  let started = false;
  return {
    nextAction(observation) {
      if (!started) {
        const ready = synchronousResponse(capability.handle({
          type: "solver.start", start: observation.start, goal: observation.goal,
        }), "Solver");
        if (ready.type !== "solver.ready") throw new Error("基线 Solver 初始化失败");
        started = true;
      }
      const response = synchronousResponse(capability.handle({
        type: "solver.next", position: observation.position, start: observation.start, goal: observation.goal,
        openDirections: observation.openDirections as MazeDirection[], remainingSteps: observation.remainingSteps,
        previousAction: observation.previousAction,
      }), "Solver");
      if (response.type !== "solver.move") throw new Error("基线 Solver 动作非法");
      return { direction: response.direction, kind: response.kind };
    },
  };
}

function baselineSolverEvaluationPlugin(): SolverEvaluationPlugin {
  return { version: "baseline-solver", createPolicy: () => baselineSolverPolicy() };
}

function synchronousResponse<T extends GeneratorResponse | SolverResponse>(
  value: T | Promise<T>,
  role: string,
): T {
  if (value instanceof Promise) throw new Error(`${role} 基线能力必须同步响应`);
  return value;
}
