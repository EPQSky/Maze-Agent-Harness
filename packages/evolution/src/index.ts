import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateCommit, PluginLineageRepository, PluginRole } from "@maze-arena/lineage";

export interface TypedPublicTrace {
  caseId: string;
  outcome: "success" | "failure";
  actions: number;
  illegalActions: number;
  observations?: Array<{
    position: { x: number; y: number };
    openDirections: string[];
    remainingSteps: number;
    moved: boolean | null;
  }>;
}

export interface TrustedEvolutionInput {
  role: PluginRole;
  championRoot: string;
  lineagePlans: readonly { attemptId: string; hypothesis: string }[];
  trustedResults: readonly { generation: number; promoted: boolean; primaryMetric: number }[];
  publicTraces: readonly TypedPublicTrace[];
  hiddenAggregate: Readonly<Record<string, number>>;
}

export interface EvolutionSessionRequest {
  role: PluginRole;
  home: string;
  workspace: string;
  input: TrustedEvolutionInput;
  allowedTools: readonly ["read", "edit", "search", "shell", "test", "public-check", "submit"];
  repairAttempt: number;
  diagnostics: readonly string[];
}

export interface EvolutionSessionResponse {
  hypothesis: string;
  strategyPlan: string;
  submitted: boolean;
}

export interface EvolutionHarnessSession {
  run(request: EvolutionSessionRequest): EvolutionSessionResponse | Promise<EvolutionSessionResponse>;
  close(): void | Promise<void>;
}

export interface PublicGateResult { passed: boolean; diagnostics: string[] }
export interface HiddenEvaluationResult {
  promote: boolean;
  resultSummary: string;
  outcome?: "failed" | "tie" | "promoted";
}

export interface EvolutionAttemptResult {
  status: "invalid-candidate" | "public-gate-failed" | "evaluated";
  repairs: number;
  hiddenEvaluationCount: number;
  promoted: boolean;
  candidate?: CandidateCommit;
}

export async function runEvolutionAttempt(options: {
  experimentId: string;
  generation: number;
  attemptId: string;
  role: PluginRole;
  championRoot: string;
  isolatedRoot: string;
  input: Omit<TrustedEvolutionInput, "role" | "championRoot">;
  createSession(environment: { home: string; workspace: string }): EvolutionHarnessSession;
  publicGate(workspace: string): PublicGateResult | Promise<PublicGateResult>;
  hiddenEvaluate(workspace: string): HiddenEvaluationResult | Promise<HiddenEvaluationResult>;
  lineage: PluginLineageRepository;
}): Promise<EvolutionAttemptResult> {
  assertNoPrivateEvolutionData(options.input);
  const home = join(options.isolatedRoot, options.attemptId, "harness-home");
  const workspace = join(options.isolatedRoot, options.attemptId, "workspace");
  rmSync(join(options.isolatedRoot, options.attemptId), { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  cpSync(options.championRoot, workspace, {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes("/.git") && !source.endsWith("/dist"),
  });
  const session = options.createSession({ home, workspace });
  let response: EvolutionSessionResponse | undefined;
  let diagnostics: string[] = [];
  let repairs = 0;
  try {
    for (let repairAttempt = 0; repairAttempt <= 3; repairAttempt += 1) {
      response = await session.run({
        role: options.role,
        home,
        workspace,
        input: { role: options.role, championRoot: workspace, ...options.input },
        allowedTools: ["read", "edit", "search", "shell", "test", "public-check", "submit"],
        repairAttempt,
        diagnostics,
      });
      if (!response.submitted) return { status: "invalid-candidate", repairs, hiddenEvaluationCount: 0, promoted: false };
      if (options.role === "solver") assertSolverCandidateScope(options.championRoot, workspace);
      const gate = await options.publicGate(workspace);
      if (gate.passed) break;
      diagnostics = [...gate.diagnostics];
      if (repairAttempt === 3) {
        writeStrategyPlan(workspace, options.attemptId, response.strategyPlan);
        const candidate = await options.lineage.commitCandidate({
          experimentId: options.experimentId, role: options.role, sourceRoot: workspace, attemptId: options.attemptId,
          hypothesis: response.hypothesis, resultSummary: diagnostics.join("; "), outcome: "failed",
        });
        return { status: "public-gate-failed", repairs, hiddenEvaluationCount: 0, promoted: false, candidate };
      }
      repairs += 1;
    }
    if (!response) return { status: "invalid-candidate", repairs, hiddenEvaluationCount: 0, promoted: false };
    const hidden = await options.hiddenEvaluate(workspace);
    writeStrategyPlan(workspace, options.attemptId, response.strategyPlan);
    const candidate = await options.lineage.commitCandidate({
      experimentId: options.experimentId, role: options.role, sourceRoot: workspace, attemptId: options.attemptId,
      hypothesis: response.hypothesis, resultSummary: hidden.resultSummary,
      outcome: hidden.outcome ?? (hidden.promote ? "promoted" : "failed"), generation: hidden.promote ? options.generation : undefined,
    });
    return { status: "evaluated", repairs, hiddenEvaluationCount: 1, promoted: hidden.promote, candidate };
  } finally {
    await session.close();
  }
}

function writeStrategyPlan(workspace: string, attemptId: string, content: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(attemptId)) throw new Error("候选尝试标识非法");
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("策略计划超过 64 KiB 冻结上限");
  const directory = join(workspace, "lineage");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${attemptId}.md`);
  if (existsSync(target)) throw new Error("本次候选尝试的策略计划已经存在");
  writeFileSync(target, content, "utf8");
}

export function assertNoPrivateEvolutionData(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["generationSeed", "mazeTopology", "shortestPath", "opponentSource", "opponentStderr", "prompt", "reasoning", "toolCalls"]) {
    if (serialized.includes(`\"${forbidden}\"`)) throw new Error(`进化输入包含禁止字段：${forbidden}`);
  }
}

export function assertSolverCandidateScope(championRoot: string, candidateRoot: string): void {
  const championPackage = packageDependencyContract(championRoot);
  const candidatePackage = packageDependencyContract(candidateRoot);
  if (JSON.stringify(championPackage) !== JSON.stringify(candidatePackage)) {
    throw new Error("Solver 候选不得修改依赖集合");
  }
  const protectedPaths = new Set([
    ...findProtectedFiles(championRoot),
    ...findProtectedFiles(candidateRoot),
  ]);
  for (const local of protectedPaths) {
    const before = readOptional(join(championRoot, local));
    const after = readOptional(join(candidateRoot, local));
    if (before !== after) throw new Error(`Solver 候选不得修改比赛配置档、协议或 Arena 规则：${local}`);
  }
}

function packageDependencyContract(root: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  return Object.fromEntries(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .map((key) => [key, value[key] ?? {}]));
}

function findProtectedFiles(root: string, current = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(current)) {
    if (["node_modules", "dist", ".git"].includes(entry)) continue;
    const path = join(current, entry);
    if (statSync(path).isDirectory()) found.push(...findProtectedFiles(root, path));
    else {
      const local = path.slice(root.length + 1);
      if (entry === "cordis.patch.yml" || /(?:^|[._-])(protocol|arena-rules?)(?:[._-]|$)/i.test(entry)) found.push(local);
    }
  }
  return found;
}

function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
