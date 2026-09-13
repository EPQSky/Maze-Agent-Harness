import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateCommit, PluginLineageRepository, PluginRole } from "@maze-arena/lineage";

export type TypedPublicTraceEvent =
  | { type: "maze.carved"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "maze.completed"; passageCount: number }
  | { type: "solver.decision"; position: { x: number; y: number }; openDirections: readonly ("north" | "east" | "south" | "west")[]; remainingSteps: number; direction: "north" | "east" | "south" | "west"; kind: "move" | "backtrack" };

export interface TypedPublicTrace {
  attemptId: string;
  generation: number;
  traceId: string;
  outcome: "success" | "failure" | "tie";
  metrics: Readonly<Record<string, number>>;
  events: readonly TypedPublicTraceEvent[];
}

export interface TrustedAttemptResult {
  attemptId: string;
  generation: number;
  role: PluginRole;
  outcome: "promoted" | "failed" | "tie";
  publicCaseCount: number;
  hiddenCaseCount: number;
  totalCandidateAggregate: Readonly<Record<string, number>>;
  /** 旧检查点缺少该字段；存在时仅包含去身份化的隐藏指标汇总。 */
  hiddenCandidateAggregate?: Readonly<Record<string, number>>;
}

export interface DelayedHiddenAggregate {
  completedAttemptCount: number;
  metricAvailableAttemptCount: number;
  metricUnavailableAttemptCount: number;
  promotedAttemptCount: number;
  failedAttemptCount: number;
  tieAttemptCount: number;
  evaluatedHiddenCaseCount: number;
  metricTotals: Readonly<Record<string, number>>;
}

export interface TrustedEvolutionInput {
  role: PluginRole;
  championRoot: string;
  lineagePlans: readonly { attemptId: string; strategyPlan: string }[];
  trustedResults: readonly TrustedAttemptResult[];
  publicTraces: readonly TypedPublicTrace[];
  hiddenAggregate: DelayedHiddenAggregate;
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
  diagnostics: readonly string[];
  candidate?: CandidateCommit;
}

const MODEL_CALL_BUDGET_EXHAUSTED_CODE = "MODEL_CALL_BUDGET_EXHAUSTED";
const MODEL_CALL_BUDGET_EXHAUSTED_DIAGNOSTIC = "剩余模型调用额度不足以继续候选修复";

const EXCLUDED_SESSION_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "cache", ".cache", ".next", ".turbo", ".vite", "coverage", ".pnpm-store",
]);

function assertSafeWorkspaceTree(root: string, ignoredDirectories: ReadonlySet<string> = new Set()): void {
  const absoluteRoot = resolve(root);
  const canonicalRoot = realpathSync(absoluteRoot);
  let files = 0;
  let totalBytes = 0;
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (ignoredDirectories.has(name)) continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`候选工作区不得包含符号链接：${relative(absoluteRoot, path)}`);
      const relation = relative(canonicalRoot, realpathSync(path));
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error("候选工作区路径越界");
      if (stat.isDirectory()) visit(path);
      else if (!stat.isFile()) throw new Error(`候选工作区包含不支持的文件类型：${relative(absoluteRoot, path)}`);
      else {
        files += 1;
        totalBytes += stat.size;
        if (files > 256 || stat.size > 2 * 1024 * 1024 || totalBytes > 5 * 1024 * 1024) {
          throw new Error("候选工作区超过冻结预检配额");
        }
      }
    }
  };
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("候选工作区必须为真实目录");
  visit(absoluteRoot);
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
  beginRepairAttempt?(repairAttempt: number): void;
  prepareCandidate(workspace: string, strategyRecord: { attemptId: string; strategyPlan: string }): Promise<string> | string;
  candidatePrepared?(candidate: Pick<CandidateCommit, "commit" | "role">): Promise<void> | void;
  verifyCandidate(workspace: string, expectedIdentity: string): Promise<void> | void;
  publicGate(workspace: string): PublicGateResult | Promise<PublicGateResult>;
  hiddenEvaluate(workspace: string): HiddenEvaluationResult | Promise<HiddenEvaluationResult>;
  lineage: PluginLineageRepository;
}): Promise<EvolutionAttemptResult> {
  assertNoPrivateEvolutionData(options.input);
  assertSafeWorkspaceTree(options.championRoot, EXCLUDED_SESSION_DIRECTORIES);
  const lineageBaseline = collectLineageBaseline(options.championRoot);
  const attemptRoot = join(options.isolatedRoot, options.attemptId);
  const workspace = join(options.isolatedRoot, options.attemptId, "workspace");
  rmSync(attemptRoot, { recursive: true, force: true });
  mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
  cpSync(options.championRoot, workspace, {
    recursive: true,
    dereference: false,
    filter: (source) => relative(options.championRoot, source).split(sep)
      .filter(Boolean).every((segment) => !EXCLUDED_SESSION_DIRECTORIES.has(segment)),
  });
  chmodSync(workspace, 0o700);
  let response: EvolutionSessionResponse | undefined;
  let trustedCandidateIdentity: string | undefined;
  let diagnostics: string[] = [];
  let repairs = 0;
  let provisionalStrategyPlan: string | undefined;
  for (let repairAttempt = 0; repairAttempt <= 3; repairAttempt += 1) {
    options.beginRepairAttempt?.(repairAttempt);
    const home = join(attemptRoot, `harness-home-r${repairAttempt}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // 每次修复都重建并关闭 Harness 会话；只有候选工作区跨修复保留状态。
    const session = options.createSession({ home, workspace });
    let nextResponse: EvolutionSessionResponse;
    try {
      nextResponse = await session.run({
        role: options.role,
        home,
        workspace,
        input: { role: options.role, championRoot: workspace, ...options.input },
        allowedTools: ["read", "edit", "search", "shell", "test", "public-check", "submit"],
        repairAttempt,
        diagnostics,
      });
    } catch (error) {
      // 公开门禁已经失败时，剩余模型额度可能不足以完成下一次 read/edit/JSON 修复。
      // 这是当前候选的验证终止，不是提供方或运行时基础设施故障；保留此前门禁诊断并停止继续外呼。
      if (isModelCallBudgetExhausted(error)) {
        const exhaustedDiagnostics = diagnostics.includes(MODEL_CALL_BUDGET_EXHAUSTED_DIAGNOSTIC)
          ? diagnostics
          : [...diagnostics, MODEL_CALL_BUDGET_EXHAUSTED_DIAGNOSTIC];
        return {
          status: "invalid-candidate",
          repairs,
          hiddenEvaluationCount: 0,
          promoted: false,
          diagnostics: exhaustedDiagnostics.length > 0
            ? exhaustedDiagnostics
            : [MODEL_CALL_BUDGET_EXHAUSTED_DIAGNOSTIC],
        };
      }
      throw error;
    } finally {
      await session.close();
    }
    response = nextResponse;
    // 模型命令返回后重新检查实际文件类型，禁止利用链接或特殊文件绕过公开门禁。
    assertSafeWorkspaceTree(workspace);
    if (!response.submitted) return {
      status: "invalid-candidate", repairs, hiddenEvaluationCount: 0, promoted: false, diagnostics: ["Harness 未提交候选"],
    };
    assertCandidateScope(options.championRoot, workspace);
    let gate: PublicGateResult;
    let prepared = false;
    let preparedIdentity: string | undefined;
    try {
      provisionalStrategyPlan = ensureStrategyPlan(
        workspace, lineageBaseline, options.attemptId, response.strategyPlan, provisionalStrategyPlan,
      );
      assertCandidateStrategyRecord(workspace, lineageBaseline, options.attemptId, response.strategyPlan);
      preparedIdentity = await options.prepareCandidate(workspace, {
        attemptId: options.attemptId,
        strategyPlan: response.strategyPlan,
      });
      trustedCandidateIdentity = preparedIdentity;
      const candidate = await options.lineage.createCandidate({
        experimentId: options.experimentId, role: options.role, sourceRoot: workspace,
        attemptId: options.attemptId, hypothesis: response.hypothesis, lineageBaseline,
      });
      await options.candidatePrepared?.(candidate);
      gate = await options.publicGate(workspace);
      await options.verifyCandidate(workspace, preparedIdentity);
      prepared = true;
    } catch (error) {
      gate = { passed: false, diagnostics: [error instanceof Error ? error.message : "候选可信重建失败"] };
    }
    if (gate.passed) break;
    diagnostics = [...gate.diagnostics];
    if (repairAttempt === 3) {
      if (!prepared) return { status: "invalid-candidate", repairs, hiddenEvaluationCount: 0, promoted: false, diagnostics };
      const preparedCandidate = await options.lineage.createCandidate({
        experimentId: options.experimentId, role: options.role, sourceRoot: workspace, attemptId: options.attemptId,
        hypothesis: response.hypothesis, lineageBaseline,
      });
      const candidate = options.lineage.recordCandidateResult({
        experimentId: options.experimentId, role: options.role, commit: preparedCandidate.commit, attemptId: options.attemptId,
        hypothesis: response.hypothesis, resultSummary: diagnostics.join("; "), outcome: "failed",
      });
      return { status: "public-gate-failed", repairs, hiddenEvaluationCount: 0, promoted: false, diagnostics, candidate };
    }
    repairs += 1;
  }
  if (!response || !trustedCandidateIdentity) return {
    status: "invalid-candidate", repairs, hiddenEvaluationCount: 0, promoted: false, diagnostics,
  };
  const hidden = await options.hiddenEvaluate(workspace);
  await options.verifyCandidate(workspace, trustedCandidateIdentity);
  const preparedCandidate = await options.lineage.createCandidate({
    experimentId: options.experimentId, role: options.role, sourceRoot: workspace, attemptId: options.attemptId,
    hypothesis: response.hypothesis, lineageBaseline,
  });
  const candidate = options.lineage.recordCandidateResult({
    experimentId: options.experimentId, role: options.role, commit: preparedCandidate.commit, attemptId: options.attemptId,
    hypothesis: response.hypothesis, resultSummary: hidden.resultSummary,
    outcome: hidden.outcome ?? (hidden.promote ? "promoted" : "failed"), generation: hidden.promote ? options.generation : undefined,
  });
  return { status: "evaluated", repairs, hiddenEvaluationCount: 1, promoted: hidden.promote, diagnostics: [], candidate };
}

function isModelCallBudgetExhausted(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === MODEL_CALL_BUDGET_EXHAUSTED_CODE;
}

function ensureStrategyPlan(
  workspace: string,
  lineageBaseline: Readonly<Record<string, string>>,
  attemptId: string,
  content: string,
  previousContent?: string,
): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(attemptId)) throw new Error("候选尝试标识非法");
  if (Buffer.byteLength(content, "utf8") > 64 * 1024) throw new Error("策略计划超过 64 KiB 冻结上限");
  const directory = join(workspace, "lineage");
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${attemptId}.md`);
  const targetPath = `lineage/${attemptId}.md`;
  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing === content) return content;
    if (targetPath in lineageBaseline) throw new Error(`候选修改或删除了既有策略记录：${targetPath}`);
    // 新尝试的临时记录不可信，始终由结构化响应覆盖，确保进入可信重建的
    // 文件内容与响应一致；后续修复只允许更新上一轮由编排器确认的记录，
    // 不能掩盖模型对它的额外篡改。
    if (previousContent !== undefined && existing !== previousContent) {
      throw new Error("候选策略记录与 Harness 响应不一致");
    }
    writeFileSync(target, content, "utf8");
    return content;
  }
  if (previousContent !== undefined && !(targetPath in lineageBaseline)) {
    throw new Error(`候选删除了临时策略记录：${targetPath}`);
  }
  writeFileSync(target, content, "utf8");
  return content;
}

function assertCandidateStrategyRecord(
  workspace: string,
  lineageBaseline: Readonly<Record<string, string>>,
  attemptId: string,
  strategyPlan: string,
): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(attemptId)) throw new Error("候选尝试标识非法");
  if (Buffer.byteLength(strategyPlan, "utf8") > 64 * 1024) throw new Error("策略计划超过 64 KiB 冻结上限");
  const current = collectLineageBaseline(workspace);
  for (const [path, hash] of Object.entries(lineageBaseline)) {
    if (current[path] !== hash) throw new Error(`候选修改或删除了既有策略记录：${path}`);
  }
  const additions = Object.keys(current).filter((path) => !(path in lineageBaseline));
  const expectedPath = `lineage/${attemptId}.md`;
  if (expectedPath in lineageBaseline) throw new Error("本次候选尝试的策略记录已存在于冠军基线");
  const unexpected = additions.find((path) => path !== expectedPath);
  if (unexpected) throw new Error(`候选新增了非标准策略记录：${unexpected}`);
  if (additions.includes(expectedPath) && readFileSync(join(workspace, expectedPath), "utf8") !== strategyPlan) {
    throw new Error("候选策略记录与 Harness 响应不一致");
  }
}

export function assertNoPrivateEvolutionData(value: unknown): void {
  const forbidden = new Set([
    "seed", "generationSeed", "mazeTopology", "shortestPath", "opponent", "opponentVersion",
    "opponentSource", "opponentComments", "opponentStderr", "stderr", "prompt", "reasoning",
    "toolCalls", "toolActivity", "source", "comments",
  ]);
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) { current.forEach(visit); return; }
    if (!current || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      if (forbidden.has(key)) throw new Error(`进化输入包含禁止字段：${key}`);
      visit(nested);
    }
  };
  visit(value);
}

export function assertCandidateScope(championRoot: string, candidateRoot: string): void {
  const championPackage = packageDependencyContract(championRoot);
  const candidatePackage = packageDependencyContract(candidateRoot);
  if (JSON.stringify(championPackage) !== JSON.stringify(candidatePackage)) {
    throw new Error("候选不得修改依赖集合");
  }
  const protectedPaths = new Set([
    ...findProtectedFiles(championRoot),
    ...findProtectedFiles(candidateRoot),
  ]);
  for (const local of protectedPaths) {
    const before = readOptional(join(championRoot, local));
    const after = readOptional(join(candidateRoot, local));
    if (before !== after) throw new Error(`候选不得修改比赛配置档、协议或 Arena 规则：${local}`);
  }
}

export const assertSolverCandidateScope = assertCandidateScope;

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

function collectLineageBaseline(root: string): Record<string, string> {
  const lineageRoot = join(root, "lineage");
  if (!existsSync(lineageRoot)) return {};
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const local = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`既有策略记录包含不安全文件：${local}`);
      if (stat.isDirectory()) visit(path);
      else result[local] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  visit(lineageRoot);
  return result;
}
