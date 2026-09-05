import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ModelProfile } from "@maze-arena/contracts";
import { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import { hashHarnessRuntimePayload } from "@maze-arena/dsh-integration";
import { DockerPairedEvaluationRunner, HarnessMatchProfileInstaller, MATCH_PROFILE_POLICY_DIGEST } from "@maze-arena/match-profile";
import { PluginLineageRepository } from "@maze-arena/lineage";
import { describe, expect, it } from "vitest";
import { AuditRepository } from "./audit-repository.js";
import { AutonomousExperimentRunner, type AutonomousEvolutionAdapter } from "./autonomous-runner.js";
import { ExperimentRepository } from "./experiment-repository.js";
import { createLocalEvolutionAdapter } from "./local-evolution-adapter.js";
import { createProductionHarnessAdapter } from "./production-harness.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const matchProfileRoot = join(workspaceRoot, "packages/match-profile");
const fakeDsh = join(matchProfileRoot, "test/fixtures/fake-dsh/dsh.mjs");
const fakeDocker = join(matchProfileRoot, "test/fixtures/fake-paired-docker.mjs");
const image = `maze-match@sha256:${"a".repeat(64)}`;

async function waitFor(
  runtime: ExperimentRuntimeRepository,
  experimentId: string,
  predicate: (snapshot: NonNullable<ReturnType<ExperimentRuntimeRepository["get"]>>) => boolean,
) {
  for (let attempt = 0; attempt < 18_000; attempt += 1) {
    const snapshot = runtime.get(experimentId);
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`等待自治代次状态超时：${JSON.stringify(runtime.get(experimentId))}`);
}

describe("确定性一代累积自进化", () => {
  it("真实 Docker 配对评测在崩溃恢复后幂等闭合两代并继承新冠军", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-one-generation-"));
    const databasePath = join(root, "arena.sqlite");
    const catalogPath = join(root, "models.json");
    const harnessHome = join(root, "match-home");
    const globalHome = join(root, "global-home");
    const dockerLog = join(root, "docker.jsonl");
    mkdirSync(globalHome);
    writeFileSync(join(globalHome, "readonly.txt"), "locked");
    writeFileSync(catalogPath, JSON.stringify({
      schemaVersion: 1, harnessVersion: "2026.09-preview.1", credentialRefs: ["dsh-credential://production"],
      providers: [{ id: "provider", label: "Provider", models: [{ id: "model", label: "Model", capabilities: {
        reasoningEfforts: [], maxContextTokens: 8_000, maxOutputTokens: 1_000,
        maxTotalTokens: 20_000, providerOptions: {},
      } }] }],
    }));
    const installer = new HarnessMatchProfileInstaller({
      executable: fakeDsh, runtimeRoot: dirname(fakeDsh),
      runtimePayloadSha256: hashHarnessRuntimePayload(dirname(fakeDsh)),
      expectedVersion: "2026.09-preview.1", home: harnessHome,
      protocolBundle: matchProfileRoot,
      roleBundles: {
        generator: join(workspaceRoot, "packages/generator-plugin"),
        solver: join(workspaceRoot, "packages/solver-plugin"),
      },
    });
    await installer.prepare();
    const commandPath = resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/deterministic-evolution-harness.mjs");
    chmodSync(commandPath, 0o755);
    const harness = createProductionHarnessAdapter({
      ARENA_MODEL_CATALOG_PATH: catalogPath, DSH_HARNESS_VERSION: "2026.09-preview.1",
      DSH_EVOLUTION_COMMAND: commandPath, DSH_SMOKE_COMMAND: "/bin/false",
      DSH_EVOLUTION_EXECUTION_KIND: "deterministic-fixture", DSH_HOME: globalHome,
    });
    const profile: ModelProfile = harness.validateModelProfile({
      providerId: "provider", modelId: "model", credentialRef: "dsh-credential://production",
      contextTokens: 4_000, outputTokens: 1_000, totalTokenLimit: 5_000,
    });
    const experiments = new ExperimentRepository(databasePath, join(root, "harness"));
    const experiment = experiments.create("一代闭环", profile);
    const runtime = new ExperimentRuntimeRepository(databasePath);
    const lineage = new PluginLineageRepository(join(root, "lineages"), databasePath);
    const audits = new AuditRepository(databasePath);
    const baselines = {
      generator: await lineage.initialize(experiment.id, "generator", join(workspaceRoot, "packages/generator-plugin")),
      solver: await lineage.initialize(experiment.id, "solver", join(workspaceRoot, "packages/solver-plugin")),
    };
    runtime.registerReady({
      experimentId: experiment.id, champions: baselines, tokenLimit: profile.totalTokenLimit,
      compatibilityFingerprint: "one-generation-v1",
    });
    runtime.start(experiment.id);
    experiments.setStatus(experiment.id, "running");
    const pairedRunner = new DockerPairedEvaluationRunner(image, harnessHome, fakeDocker, {
      MAZE_FAKE_DOCKER_LOG: dockerLog, MAZE_FAKE_DSH: fakeDsh,
    }, false);
    const evaluationFailures: string[] = [];
    const evaluationInputs: Array<{
      role: "generator" | "solver"; candidateCommit: string; championCommit: string; opponentCommit: string;
    }> = [];
    const createAdapter = (
      currentExperiments: ExperimentRepository,
      currentRuntime: ExperimentRuntimeRepository,
      currentLineage: PluginLineageRepository,
      currentAudits: AuditRepository,
    ) => createLocalEvolutionAdapter({
      harness, experiments: currentExperiments, runtime: currentRuntime, lineage: currentLineage, audits: currentAudits,
      pluginRoots: {
        generator: join(workspaceRoot, "packages/generator-plugin"),
        solver: join(workspaceRoot, "packages/solver-plugin"),
      },
      candidateTestRunner: { run: () => undefined },
      pairedEvaluationRunner: {
        evaluate: async (input) => {
          evaluationInputs.push({
            role: input.role, candidateCommit: input.candidate.commit,
            championCommit: input.champion.commit, opponentCommit: input.opponent.commit,
          });
          try { return await pairedRunner.evaluate(input); }
          catch (error) {
            evaluationFailures.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      },
      matchImageDigest: image, resourcePolicyDigest: MATCH_PROFILE_POLICY_DIGEST,
      startExhibition: ({ exhibitionId }) => exhibitionId ?? "exhibition",
      // 生产默认仍冻结 8/24；测试缩小案例数，但完整保留公开与隐藏两阶段容器执行。
      evaluationCaseFactory: (sealedRuntime, experimentId, generation, role) => ({
        publicCases: [{ id: "public-01", seed: `public:${role}:1`, visibility: "public" }],
        hiddenCases: [{
          id: "hidden-01", seed: sealedRuntime.deriveHiddenSeed(experimentId, generation, `${role}:1`), visibility: "hidden",
        }],
      }),
    });

    let solverStarted!: () => void;
    const solverStart = new Promise<void>((resolveStarted) => { solverStarted = resolveStarted; });
    const initialAdapter = createAdapter(experiments, runtime, lineage, audits);
    const crashAfterGenerator: AutonomousEvolutionAdapter = {
      ...initialAdapter,
      runRole: (input) => {
        if (input.role === "generator") return initialAdapter.runRole(input);
        solverStarted();
        return new Promise((_resolve, reject) => {
          const stop = () => reject(new Error("模拟 Generator 检查点后的进程崩溃"));
          if (input.signal.aborted) stop();
          else input.signal.addEventListener("abort", stop, { once: true });
        });
      },
    };
    const firstRunner = new AutonomousExperimentRunner(runtime, experiments, audits, crashAfterGenerator);
    firstRunner.launch(experiment.id);
    await solverStart;
    const generatorCheckpoint = runtime.getRoleCheckpoint(experiment.id, 1, "generator");
    expect(generatorCheckpoint?.result).toMatchObject({ championBefore: baselines.generator, outcome: "promoted" });
    await firstRunner.close();
    audits.close();
    lineage.close();
    runtime.close();
    experiments.close();

    const recoveredExperiments = new ExperimentRepository(databasePath, join(root, "harness"));
    const recoveredRuntime = new ExperimentRuntimeRepository(databasePath);
    const recoveredLineage = new PluginLineageRepository(join(root, "lineages"), databasePath);
    const recoveredAudits = new AuditRepository(databasePath);
    const recoveredRunner = new AutonomousExperimentRunner(
      recoveredRuntime, recoveredExperiments, recoveredAudits,
      createAdapter(recoveredExperiments, recoveredRuntime, recoveredLineage, recoveredAudits),
    );
    recoveredRunner.resumePersisted();
    const firstGeneration = await waitFor(
      recoveredRuntime, experiment.id, (snapshot) => snapshot.generation === 1 && snapshot.state === "paused",
    );
    expect(firstGeneration.champions).toEqual({
      generator: generatorCheckpoint!.result.candidateCommit, solver: baselines.solver,
    });
    expect(firstGeneration.generations[0]).toMatchObject({
      generator: { championBefore: baselines.generator, outcome: "promoted" },
      solver: { championBefore: baselines.solver, outcome: "tie", championAfter: baselines.solver },
    });
    const firstGeneratorCommit = firstGeneration.generations[0]?.generator?.candidateCommit;
    const firstSolverCommit = firstGeneration.generations[0]?.solver?.candidateCommit;
    expect(evaluationInputs.filter(({ role, candidateCommit }) => role === "generator" && candidateCommit === firstGeneratorCommit))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        championCommit: baselines.generator, opponentCommit: baselines.solver,
      })]));
    expect(evaluationInputs.filter(({ role, candidateCommit }) => role === "solver" && candidateCommit === firstSolverCommit))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        championCommit: baselines.solver, opponentCommit: baselines.generator,
      })]));
    expect(recoveredLineage.listHistory(experiment.id, "generator")).toHaveLength(2);
    expect(recoveredLineage.listHistory(experiment.id, "solver")).toHaveLength(2);
    expect(recoveredAudits.list(experiment.id).events.filter(({ type }) => type === "harness.activity")).toHaveLength(2);
    const firstGenerationAudit = recoveredAudits.list(experiment.id).events;
    expect(firstGenerationAudit.filter(({ type }) => type === "candidate.prepared")).toHaveLength(2);
    expect(firstGenerationAudit.filter(({ type }) => type === "candidate.evaluated")).toHaveLength(2);
    expect(firstGenerationAudit.filter(({ type }) => type === "candidate.promoted")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({
        role: "generator", generation: 1, candidateCommit: generatorCheckpoint!.result.candidateCommit,
        championBefore: baselines.generator, championAfter: generatorCheckpoint!.result.candidateCommit,
        promotionTag: `promotion/${experiment.id}/generator/g0001`,
      }) }),
    ]);
    expect(firstGeneration.generations[0]?.generator).toMatchObject({
      attemptId: "g0001-generator", evidenceLevel: "deterministic-fixture", candidateStatus: "evaluated",
      trustedBuildSha256: expect.stringMatching(/^[0-9a-f]{64}$/), isolatedEvaluation: true,
    });

    recoveredRuntime.start(experiment.id);
    recoveredExperiments.setStatus(experiment.id, "running");
    recoveredRunner.resumePersisted();
    const secondGeneration = await waitFor(
      recoveredRuntime, experiment.id, (snapshot) => snapshot.generation === 2 && snapshot.state === "paused",
    );
    expect(evaluationFailures).toEqual([]);
    expect(secondGeneration.generations[1]).toMatchObject({
      generator: {
        championBefore: generatorCheckpoint!.result.candidateCommit,
        championAfter: generatorCheckpoint!.result.candidateCommit,
        outcome: "tie",
      },
      solver: { championBefore: baselines.solver, championAfter: baselines.solver, outcome: "failed" },
    });
    const committedAudit = recoveredAudits.list(experiment.id).events.filter(({ type }) => type === "generation.committed");
    expect(committedAudit.at(-1)?.details).toMatchObject({
      generation: 2, generatorStart: generatorCheckpoint!.result.candidateCommit,
      generatorChampion: generatorCheckpoint!.result.candidateCommit,
      solverStart: baselines.solver, solverChampion: baselines.solver,
    });
    const secondGenerator = secondGeneration.generations[1]?.generator?.candidateCommit;
    const secondSolver = secondGeneration.generations[1]?.solver?.candidateCommit;
    if (!secondGenerator) throw new Error("第二代 Generator 候选缺失");
    expect(evaluationInputs.filter(({ role, candidateCommit }) => role === "generator" && candidateCommit === secondGenerator))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        championCommit: generatorCheckpoint!.result.candidateCommit, opponentCommit: baselines.solver,
      })]));
    expect(evaluationInputs.filter(({ role, candidateCommit }) => role === "solver" && candidateCommit === secondSolver))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        championCommit: baselines.solver, opponentCommit: generatorCheckpoint!.result.candidateCommit,
      })]));
    const secondRoot = join(root, "generation-2-generator");
    recoveredLineage.materialize(experiment.id, "generator", secondGenerator, secondRoot);
    const secondSource = readFileSync(join(secondRoot, "src/index.ts"), "utf8");
    expect(secondSource).toContain("deterministicEvolutionAttempt_g0001_generator");
    expect(secondSource).toContain("deterministicEvolutionAttempt_g0002_generator");
    expect(recoveredLineage.listHistory(experiment.id, "generator")).toHaveLength(3);
    expect(recoveredLineage.listHistory(experiment.id, "solver")).toHaveLength(3);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare(`SELECT generation, tag_name, target_commit, state FROM promotion_tags
        WHERE experiment_id = ? ORDER BY generation`).all(experiment.id)).toEqual([{
        generation: 1, tag_name: `promotion/${experiment.id}/generator/g0001`,
        target_commit: generatorCheckpoint!.result.candidateCommit, state: "complete",
      }]);
      expect(database.prepare(`SELECT generation, COUNT(*) AS count FROM generation_records
        WHERE experiment_id = ? GROUP BY generation ORDER BY generation`).all(experiment.id)).toEqual([
        { generation: 1, count: 1 }, { generation: 2, count: 1 },
      ]);
    } finally { database.close(); }
    const dockerCalls = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const dockerRuns = dockerCalls.filter(([operation]) => operation === "run");
    expect(dockerRuns.length).toBeGreaterThan(0);
    expect(dockerRuns.every((args) => args.includes("--network=none") && args.includes("--read-only"))).toBe(true);
    expect(new Set(dockerRuns.map((args) => args[args.indexOf("--name") + 1])).size).toBe(dockerRuns.length);
    expect(readFileSync(join(globalHome, "readonly.txt"), "utf8")).toBe("locked");

    await recoveredRunner.close();
    recoveredAudits.close();
    recoveredLineage.close();
    recoveredRuntime.close();
    recoveredExperiments.close();
  }, 300_000);
});
