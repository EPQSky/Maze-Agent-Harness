import type { ArenaMatch, BaselineValidationRecord, EvolutionEvidenceLevel, EvolutionRole, ExperimentAuditEvent, ExperimentRuntimeSnapshot, GenerationRecord, GenerationRoleResult, LineageHistoryResponse, ModelProfileInput } from "@maze-arena/contracts";
import { Bot, Box, Check, CheckCircle2, CircleAlert, CircleMinus, FlaskConical, GitBranch, GitCommitHorizontal, Hammer, Pause, Play, ShieldCheck, Square, Trophy, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { arenaApi } from "./api";

const stepLabels: Record<string, string> = {
  "model-config": "模型配置", "native-plugin-install": "原生插件安装", "isolated-match": "隔离比赛",
  "event-replay": "事件回放", determinism: "确定性复检", "maze-legality": "迷宫合法性",
  persistence: "持久化", "live-delivery": "直播交付", "paired-evaluation": "配对评测", "promotion-tag": "晋级标签",
};
const tabs = ["Arena", "Generations", "Matches", "Lineages", "Candidates", "Audit"] as const;

export function ExperimentWorkbench({ experimentId, modelProfile, onOpenMatch }: { experimentId: string; modelProfile: ModelProfileInput | null; onOpenMatch(matchId: string): void }) {
  const [baseline, setBaseline] = useState<BaselineValidationRecord>();
  const [runtime, setRuntime] = useState<ExperimentRuntimeSnapshot | null>(null);
  const [audit, setAudit] = useState<ExperimentAuditEvent[]>([]);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Arena");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [derivedName, setDerivedName] = useState("");
  const [publicSeed, setPublicSeed] = useState("exhibition-v1");
  const [matches, setMatches] = useState<ArenaMatch[]>([]);
  const [lineages, setLineages] = useState<LineageHistoryResponse>({ generator: [], solver: [] });
  const [generationFilter, setGenerationFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [opponentFilter, setOpponentFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [resultFilter, setResultFilter] = useState("all");
  const [generatorCommit, setGeneratorCommit] = useState("");
  const [solverCommit, setSolverCommit] = useState("");
  const activeExperimentId = useRef(experimentId);
  const refreshSequence = useRef(0);
  activeExperimentId.current = experimentId;

  async function refresh() {
    const requestedExperimentId = experimentId;
    const sequence = ++refreshSequence.current;
    const [nextBaseline, nextRuntime, nextAudit, nextMatches, nextLineages] = await Promise.all([
      arenaApi.getBaselineValidation(requestedExperimentId), arenaApi.getRuntime(requestedExperimentId),
      arenaApi.getAuditEvents(requestedExperimentId), arenaApi.listMatches(requestedExperimentId),
      arenaApi.getLineages(requestedExperimentId).catch(() => ({ generator: [], solver: [] })),
    ]);
    // 丢弃实验切换或后发刷新已经发生后的旧响应，避免不同实验的观察数据串台。
    if (activeExperimentId.current !== requestedExperimentId || refreshSequence.current !== sequence) return;
    setBaseline(nextBaseline); setRuntime(nextRuntime); setAudit(nextAudit.events); setMatches(nextMatches); setLineages(nextLineages);
    setGeneratorCommit((current) => nextLineages.generator.some(({ commit }) => commit === current)
      ? current : nextRuntime?.champions.generator || "");
    setSolverCommit((current) => nextLineages.solver.some(({ commit }) => commit === current)
      ? current : nextRuntime?.champions.solver || "");
  }

  useEffect(() => { void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "读取控制面失败")); }, [experimentId]);
  useEffect(() => {
    if (runtime?.state !== "running") return;
    const timer = window.setInterval(() => {
      void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "刷新控制面失败"));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [experimentId, runtime?.state]);

  async function runBaseline(smokeProvider: boolean) {
    setBusy(true); setError(undefined);
    try { setBaseline(await arenaApi.runBaselineValidation(experimentId, smokeProvider)); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "基线验收失败"); }
    finally { setBusy(false); }
  }

  async function confirmBaseline() {
    setBusy(true); setError(undefined);
    try { setBaseline(await arenaApi.confirmBaseline(experimentId)); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "基线确认失败"); }
    finally { setBusy(false); }
  }

  async function act(action: "start" | "pause" | "resume" | "cancel") {
    setBusy(true); setError(undefined);
    try { setRuntime(await arenaApi.runtimeAction(experimentId, action)); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "运行控制失败"); }
    finally { setBusy(false); }
  }

  async function derive(kind: "clone" | "fork") {
    if (!runtime || !modelProfile || !derivedName.trim()) return;
    setBusy(true); setError(undefined);
    try {
      if (kind === "clone") await arenaApi.cloneComparison(experimentId, derivedName.trim(), modelProfile, runtime.budget.costLimit);
      else await arenaApi.forkContinuation(
        experimentId, derivedName.trim(), modelProfile, undefined, generatorCommit, solverCommit, runtime.budget.costLimit,
      );
      setDerivedName("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "派生实验失败"); }
    finally { setBusy(false); }
  }

  async function createExhibition() {
    if (!runtime) return;
    setBusy(true); setError(undefined);
    try { await arenaApi.createExhibition(experimentId, generatorCommit, solverCommit, publicSeed); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "展示局创建失败"); }
    finally { setBusy(false); }
  }

  const visibleMatches = matches.filter((match) => {
    const observation = match.observation;
    return (generationFilter === "all" || String(observation?.generation) === generationFilter)
      && (roleFilter === "all" || observation?.role === roleFilter)
      && (!opponentFilter || observation?.opponent.toLowerCase().includes(opponentFilter.toLowerCase()))
      && (typeFilter === "all" || observation?.evaluationType === typeFilter)
      && (resultFilter === "all" || observation?.result === resultFilter);
  });

  return (
    <section className="experiment-workbench" aria-label="自治实验工作台">
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="workbench-tabs" role="tablist">
        {tabs.map((value) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>)}
      </div>

      {tab === "Arena" && (
        <div className="workbench-view">
          <div className="section-heading"><div><p className="eyebrow">监督门禁</p><h3>基线验收</h3></div>
            <div className="control-actions">
              {baseline?.status !== "ready" && <button className="secondary-button" disabled={busy} onClick={() => void runBaseline(false)}><FlaskConical size={16} />执行验收</button>}
              {baseline?.status !== "ready" && <button className="secondary-button" disabled={busy} onClick={() => void runBaseline(true)}>提供方冒烟</button>}
              {baseline?.status === "passed" && <button className="primary-button" disabled={busy} onClick={() => void confirmBaseline()}><ShieldCheck size={16} />确认并冻结</button>}
            </div>
          </div>
          <div className="validation-grid">
            {Object.entries(stepLabels).map(([step, label]) => {
              const result = baseline?.steps.find((candidate) => candidate.step === step);
              return <div className={`validation-step ${result?.passed ? "passed" : result ? "failed" : "pending"}`} key={step}>
                {result?.passed ? <Check size={16} /> : result ? <CircleAlert size={16} /> : <span className="step-dot" />}
                <div><strong>{label}</strong><small>{result?.diagnostics.join("；") || "等待执行"}</small></div>
              </div>;
            })}
          </div>
          {runtime && <>
            <div className="runtime-strip">
              <span>阶段 <strong>{runtime.phase}</strong></span><span>代次 <strong>{runtime.generation}</strong></span>
              <span>停滞 <strong>{runtime.stagnationCount}/5</strong></span><span>令牌 <strong>{runtime.usage.tokens}/{runtime.budget.tokenLimit}</strong></span>
              <span>成本 <strong>{runtime.usage.cost}/{runtime.budget.costLimit ?? "不限"}</strong></span>
              <span>密封 <strong>{runtime.sealed ? "是" : "否"}</strong></span>
              <span>Generator <code>{runtime.champions.generator.substring(0, 12)}</code></span>
              <span>Solver <code>{runtime.champions.solver.substring(0, 12)}</code></span>
            </div>
            <div className="control-actions runtime-actions">
              {runtime.state === "ready" && <button className="primary-button" disabled={busy} onClick={() => void act("start")}><Play size={16} />启动进化</button>}
              {runtime.state === "running" && <button className="secondary-button" disabled={busy || runtime.pauseRequested} onClick={() => void act("pause")}><Pause size={16} />安全暂停</button>}
              {runtime.state === "paused" && <button className="primary-button" disabled={busy} onClick={() => void act("resume")}><Play size={16} />恢复</button>}
              {!(["completed", "cancelled"] as string[]).includes(runtime.state) && <button className="danger-button" disabled={busy} onClick={() => void act("cancel")}><Square size={15} />终止</button>}
            </div>
          </>}
        </div>
      )}

      {tab === "Generations" && <GenerationEvidenceView runtime={runtime} audit={audit} />}
      {tab === "Matches" && <div className="workbench-view"><h3>比赛</h3><div className="filter-bar"><select aria-label="代次筛选" value={generationFilter} onChange={(event) => setGenerationFilter(event.target.value)}><option value="all">全部代次</option>{runtime?.generations.map(({ generation }) => <option key={generation} value={generation}>第 {generation} 代</option>)}</select><select aria-label="角色筛选" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">全部角色</option><option value="generator">Generator</option><option value="solver">Solver</option><option value="exhibition">展示局</option></select><input aria-label="对手筛选" placeholder="对手版本" value={opponentFilter} onChange={(event) => setOpponentFilter(event.target.value)} /><select aria-label="评测类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部类型</option><option value="public">公开评测</option><option value="hidden">隐藏聚合</option><option value="exhibition">展示局</option></select><select aria-label="结果筛选" value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}><option value="all">全部结果</option><option value="won">胜</option><option value="lost">负</option><option value="tie">平</option><option value="completed">完成</option></select></div>{visibleMatches.map((match) => <div className="data-row" key={match.id}><code>{match.id}</code><span>{match.observation ? `${match.observation.role} · ${match.observation.evaluationType} · ${match.observation.result}` : "基线"} · {match.committedEventCount} 步</span>{match.observation?.replayable !== false && <button className="secondary-button" onClick={() => onOpenMatch(match.id)}>打开回放</button>}</div>)}<p className="muted">隐藏评测只显示聚合进度，不提供种子、迷宫或单场轨迹。</p></div>}
      {tab === "Lineages" && <div className="workbench-view"><LineageEvidenceView runtime={runtime} lineages={lineages} />{runtime && <><div className="derive-controls"><input aria-label="派生实验名称" placeholder="派生实验名称" value={derivedName} onChange={(event) => setDerivedName(event.target.value)} /><button className="secondary-button" disabled={busy || !derivedName.trim()} onClick={() => void derive("clone")}>比较克隆</button><button className="secondary-button" disabled={busy || !derivedName.trim()} onClick={() => void derive("fork")}>延续分支</button><button className="danger-button" disabled={busy || runtime.state === "running" || !runtime.sealed} onClick={() => void arenaApi.unsealGroup(experimentId).then(() => refresh()).catch((reason) => setError(reason.message))}>解封组</button></div><div className="derive-controls"><select aria-label="展示局 Generator 版本" value={generatorCommit} onChange={(event) => setGeneratorCommit(event.target.value)}>{lineages.generator.map((entry) => <option key={entry.commit} value={entry.commit}>{entry.commit.slice(0, 12)} · {entry.subject}</option>)}</select><select aria-label="展示局 Solver 版本" value={solverCommit} onChange={(event) => setSolverCommit(event.target.value)}>{lineages.solver.map((entry) => <option key={entry.commit} value={entry.commit}>{entry.commit.slice(0, 12)} · {entry.subject}</option>)}</select><input aria-label="展示局公开种子" value={publicSeed} onChange={(event) => setPublicSeed(event.target.value)} /><button className="secondary-button" disabled={busy || !publicSeed || !generatorCommit || !solverCommit} onClick={() => void createExhibition()}>创建展示局</button></div><p className="muted">兼容性指纹：<code>{runtime.compatibilityFingerprint}</code> · 评测套件：<code>{runtime.evaluationSuiteId}</code>。指纹不同的延续分支不可直接比较。</p></>}</div>}
      {tab === "Candidates" && <CandidateEvidenceView runtime={runtime} audit={audit} />}
      {tab === "Audit" && <AuditEvidenceView audit={audit} />}
    </section>
  );
}

function EvidenceBadge({ level }: { level?: EvolutionEvidenceLevel }) {
  const label = level === "real-provider" ? "真实模型运行"
    : level === "deterministic-fixture" ? "确定性自治夹具"
    : level === "fake" ? "Fake Harness 测试"
    : "证据等级未知";
  return <span className={`evidence-badge evidence-${level ?? "unknown"}`} title={evidenceDescription(level)}><Bot size={13} />{label}</span>;
}

function evidenceDescription(level?: EvolutionEvidenceLevel) {
  if (level === "real-provider") return "真实提供方调用证据；候选是否晋级由后续可信门禁决定";
  if (level === "deterministic-fixture") return "生产协议、可信构建与隔离评测链路证据；不代表真实模型能力";
  if (level === "fake") return "开发替身证据；不得作为真实插件自进化结论";
  return "旧记录或缺失审计，不能判定模型调用证据等级";
}

function evidenceFor(candidate: GenerationRoleResult, audit: ExperimentAuditEvent[]) {
  if (candidate.evidenceLevel) return candidate.evidenceLevel;
  const event = [...audit].reverse().find(({ type, details }) => type === "harness.activity"
    && candidate.attemptId !== undefined && details.attemptId === candidate.attemptId);
  const kind = event?.details.executionKind;
  return kind === "fake" || kind === "deterministic-fixture" || kind === "real-provider" ? kind : undefined;
}

function GenerationEvidenceView({ runtime, audit }: { runtime: ExperimentRuntimeSnapshot | null; audit: ExperimentAuditEvent[] }) {
  return <div className="workbench-view"><div className="evidence-heading"><div><p className="eyebrow">累积继承证据</p><h3>进化代</h3></div><span className="privacy-note"><ShieldCheck size={14} />隐藏评测仅显示聚合进度</span></div>
    {runtime?.generations.length ? runtime.generations.map((generation, index) => {
      const next = runtime.generations[index + 1];
      return <section className="generation-evidence" key={generation.generation} aria-label={`第 ${generation.generation} 代证据`}>
        <div className="generation-title"><strong>第 {generation.generation} 代</strong><span>{generation.status === "completed" ? "已原子提交" : "基础设施失败"}</span><span>停滞 {generation.stagnationCount}</span></div>
        <div className="role-evidence-grid">{(["generator", "solver"] as const).map((role) => <RoleGenerationEvidence key={role} role={role} result={generation[role]} nextStart={next?.[role]?.championBefore} audit={audit} />)}</div>
        <div className="generation-footer"><span>展示局 <code>{generation.exhibitionMatchId ?? "无"}</code></span><span>下一代状态 {next ? `已从第 ${next.generation} 代起点验证` : "等待下一代"}</span></div>
      </section>;
    }) : <p className="muted">尚无已提交进化代。</p>}
  </div>;
}

function RoleGenerationEvidence({ role, result, nextStart, audit }: { role: EvolutionRole; result: GenerationRoleResult | null; nextStart?: string; audit: ExperimentAuditEvent[] }) {
  if (!result) return <div className="role-evidence"><strong>{roleLabel(role)}</strong><span className="outcome-badge outcome-failed"><XCircle size={13} />基础设施失败</span></div>;
  const inherited = nextStart === undefined ? undefined : nextStart === result.championAfter;
  return <div className="role-evidence"><div className="role-evidence-title"><strong>{roleLabel(role)}</strong><OutcomeBadge outcome={result.outcome} /></div>
    <EvidenceBadge level={evidenceFor(result, audit)} />
    <CommitFact label="本代起点" value={result.championBefore} />
    <CommitFact label="本代冠军" value={result.championAfter} />
    <div className="progress-facts"><span>公开 <strong>{result.publicProgress}</strong></span><span>隐藏 <strong>{result.hiddenProgress}</strong></span></div>
    <span className={`inheritance-proof ${inherited === false ? "failed" : ""}`}>{inherited === undefined ? "下一代尚未开始" : inherited ? "下一代已继承该冠军" : "下一代起点不一致"}</span>
  </div>;
}

function CandidateEvidenceView({ runtime, audit }: { runtime: ExperimentRuntimeSnapshot | null; audit: ExperimentAuditEvent[] }) {
  const candidates = runtime?.generations.flatMap((generation) => ([
    generation.generator && { generation: generation.generation, role: "generator" as const, candidate: generation.generator },
    generation.solver && { generation: generation.generation, role: "solver" as const, candidate: generation.solver },
  ].filter(Boolean) as Array<{ generation: number; role: EvolutionRole; candidate: GenerationRoleResult }>)) ?? [];
  return <div className="workbench-view"><div className="evidence-heading"><div><p className="eyebrow">源码到晋级</p><h3>候选与门禁</h3></div><span className="privacy-note"><ShieldCheck size={14} />不公开隐藏种子与单场事实</span></div>
    {candidates.length ? candidates.map(({ generation, role, candidate }) => <article className="candidate-evidence" key={`${generation}-${role}`} aria-label={`第 ${generation} 代 ${roleLabel(role)} 候选`}>
      <div className="candidate-heading"><div><span>第 {generation} 代 · {roleLabel(role)}</span><h4>{candidate.hypothesis ?? "未记录候选假设"}</h4></div><OutcomeBadge outcome={candidate.outcome} /></div>
      <EvidenceBadge level={evidenceFor(candidate, audit)} />
      <div className="candidate-pipeline" aria-label="候选证据链">
        <PipelineStep icon={<Bot size={15} />} label="模型调用" value={candidate.attemptId ?? "旧记录"} state={evidenceFor(candidate, audit) ? "passed" : "unknown"} />
        <PipelineStep icon={<GitCommitHorizontal size={15} />} label="有效载荷" value={candidate.diffSummary ? "已修改" : candidate.candidateStatus ? "未形成差异" : "旧记录"} state={candidate.diffSummary ? "passed" : candidate.candidateStatus ? "failed" : "unknown"} />
        <PipelineStep icon={<Hammer size={15} />} label="可信构建" value={candidate.trustedBuildSha256 ? candidate.trustedBuildSha256.slice(0, 12) : candidate.candidateStatus === "invalid" ? "未通过" : "旧记录"} state={candidate.trustedBuildSha256 ? "passed" : candidate.candidateStatus === "invalid" ? "failed" : "unknown"} />
        <PipelineStep icon={<Box size={15} />} label="隔离评测" value={candidate.isolatedEvaluation ? "Docker Match Profile" : candidate.publicProgress || candidate.hiddenProgress ? "已完成" : "未执行"} state={candidate.isolatedEvaluation || candidate.publicProgress || candidate.hiddenProgress ? "passed" : "failed"} />
      </div>
      <dl className="candidate-facts"><div><dt>候选提交</dt><dd>{candidate.candidateStatus === "invalid" ? "未形成候选 Git 提交" : <code>{candidate.candidateCommit}</code>}</dd></div><div><dt>Champion Version</dt><dd><code>{candidate.championAfter}</code></dd></div><div><dt>公开门禁</dt><dd>{candidate.publicProgress} 个案例</dd></div><div><dt>隐藏评测</dt><dd>{candidate.hiddenProgress} 个案例，只有聚合结论</dd></div></dl>
      <div className="candidate-diff"><strong>允许范围内的代码差异</strong><pre>{candidate.diffSummary || "未形成可安装运行载荷差异"}</pre></div>
      <div className="candidate-decision"><strong>{candidate.promotionTag ? "晋级标签" : "最终结论"}</strong><span>{candidate.promotionTag ?? rejectionReason(candidate)}</span></div>
    </article>) : <p className="muted">尚无候选证据。</p>}
  </div>;
}

function LineageEvidenceView({ runtime, lineages }: { runtime: ExperimentRuntimeSnapshot | null; lineages: LineageHistoryResponse }) {
  return <><div className="evidence-heading"><div><p className="eyebrow">Git 权威证据</p><h3>插件谱系</h3></div><span className="privacy-note"><GitBranch size={14} />候选、冠军与标签可定位</span></div>
    <div className="champion-grid"><div><GitBranch size={17} /><span>Generator Champion Version</span><code>{runtime?.champions.generator ?? "baseline"}</code></div><div><GitBranch size={17} /><span>Solver Champion Version</span><code>{runtime?.champions.solver ?? "baseline"}</code></div></div>
    {(["generator", "solver"] as const).map((role) => <section className="lineage-lane" key={role} aria-label={`${roleLabel(role)} 谱系`}><h4>{roleLabel(role)}</h4>{lineages[role].map((entry) => {
      const isChampion = runtime?.champions[role] === entry.commit;
      return <div className="lineage-row" key={entry.commit}><GitCommitHorizontal size={16} /><div><code>{entry.commit}</code><span>{entry.subject}</span></div><div className="lineage-milestones"><LineageMilestone entry={entry} />{isChampion ? <span className="milestone champion"><Trophy size={12} />当前冠军</span> : null}{entry.tags.map((tag) => <code className="tag-proof" key={tag}>{tag}</code>)}</div></div>;
    })}</section>)}
  </>;
}

function LineageMilestone({ entry }: { entry: LineageHistoryResponse["generator"][number] }) {
  if (entry.kind === "baseline") return <span className="milestone baseline">可信基线</span>;
  if (entry.candidateStage === "intermediate") return <span className="milestone intermediate">中间修复候选</span>;
  if (entry.outcome === "public-only") return <span className="milestone intermediate">公开门禁候选</span>;
  if (entry.outcome === "promoted" || entry.outcome === "tie" || entry.outcome === "failed") {
    return <OutcomeBadge outcome={entry.outcome} />;
  }
  return <span className="milestone intermediate">候选结果待登记</span>;
}

function AuditEvidenceView({ audit }: { audit: ExperimentAuditEvent[] }) {
  return <div className="workbench-view" data-owner-only="true"><div className="evidence-heading"><div><p className="eyebrow">只读可信记录</p><h3>本机所有者审计</h3></div><span className="privacy-note"><ShieldCheck size={14} />仅显示净化后的结构化事实</span></div>
    {audit.length ? audit.map((event) => {
      const summary = auditSummary(event);
      return <div className={`audit-row audit-${summary.tone}`} key={event.id}><time>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time><div className="audit-marker">{summary.icon}<span>{summary.title}</span></div><p>{summary.description}</p>{summary.level ? <EvidenceBadge level={summary.level} /> : null}</div>;
    }) : <p className="muted">尚无审计事件。</p>}
  </div>;
}

function auditSummary(event: ExperimentAuditEvent): { title: string; description: string; tone: string; level?: EvolutionEvidenceLevel; icon: ReactNode } {
  const detail = event.details;
  const role = detail.role === "generator" || detail.role === "solver" ? roleLabel(detail.role) : "候选";
  const kind = detail.executionKind === "fake" || detail.executionKind === "deterministic-fixture" || detail.executionKind === "real-provider" ? detail.executionKind : undefined;
  if (event.type === "harness.activity") return { title: "Harness 已调用", tone: detail.outcome === "succeeded" ? "info" : "failed", level: kind,
    icon: <Bot size={15} />, description: detail.outcome === "succeeded" ? `${role} ${kind === "real-provider" ? "实际提供方返回" : "自治调用返回"}；这不等同于插件已进化。` : `${role} Harness 调用失败；未形成插件进化证据。` };
  if (event.type === "candidate.invalid") return { title: "候选无效", tone: "failed", icon: <XCircle size={15} />, description: `${role} 未通过候选验证，原因分类：${String(detail.reason ?? "unknown")}。` };
  if (event.type === "candidate.prepared") return { title: "可信构建完成", tone: "info", icon: <Hammer size={15} />, description: `${role} 有效载荷已修改并从源码可信重建；候选提交 ${shortFact(detail.candidateCommit)}。` };
  if (event.type === "candidate.evaluated") return { title: "候选已评测", tone: detail.outcome === "failed" ? "failed" : "info", icon: <Box size={15} />, description: `${role} 已完成隔离评测；公开 ${numberFact(detail.publicCaseCount)}，隐藏 ${numberFact(detail.hiddenCaseCount)} 个案例，结果 ${outcomeLabel(detail.outcome)}。` };
  if (event.type === "candidate.promoted") return { title: "候选已晋级", tone: "promoted", icon: <Trophy size={15} />, description: `${role} 已成为 Champion Version；晋级标签 ${String(detail.promotionTag ?? "缺失")}。` };
  if (event.type === "generation.committed") return { title: "代次已提交", tone: "info", icon: <CheckCircle2 size={15} />, description: `第 ${numberFact(detail.generation)} 代已原子提交；下一代起点由本代双角色冠军冻结。` };
  return { title: auditEventLabel(event.type), tone: event.type.includes("failed") ? "failed" : "neutral", icon: <CircleMinus size={15} />, description: safeGeneralAuditDescription(event) };
}

function OutcomeBadge({ outcome }: { outcome: GenerationRoleResult["outcome"] }) {
  const icon = outcome === "promoted" ? <Trophy size={13} /> : outcome === "tie" ? <CircleMinus size={13} /> : <XCircle size={13} />;
  return <span className={`outcome-badge outcome-${outcome}`}>{icon}{outcomeLabel(outcome)}</span>;
}

function PipelineStep({ icon, label, value, state }: { icon: ReactNode; label: string; value: string; state: "passed" | "failed" | "unknown" }) {
  return <div className={`pipeline-step pipeline-${state}`}>{icon}<span>{label}</span><strong>{value}</strong></div>;
}

function CommitFact({ label, value }: { label: string; value: string }) {
  return <span className="commit-fact"><small>{label}</small><code>{value}</code></span>;
}

function rejectionReason(candidate: GenerationRoleResult) {
  if (candidate.outcome === "tie") return "平局：冠军保持不变";
  if (candidate.gateDiagnostics?.length) return `拒绝：${candidate.gateDiagnostics.join("；")}`;
  return candidate.candidateStatus === "invalid" ? "拒绝：候选无效" : "失败：未满足晋级比较规则";
}

function roleLabel(role: EvolutionRole) { return role === "generator" ? "Generator" : "Solver"; }
function outcomeLabel(outcome: unknown) { return outcome === "promoted" ? "晋级" : outcome === "tie" ? "平局" : outcome === "failed" ? "失败" : "未知"; }
function shortFact(value: unknown) { return typeof value === "string" ? value.slice(0, 12) : "缺失"; }
function numberFact(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function auditEventLabel(type: ExperimentAuditEvent["type"]) {
  const labels: Partial<Record<ExperimentAuditEvent["type"], string>> = {
    "match.started": "比赛已启动", "match.completed": "比赛已完成", "match.failed": "比赛失败",
    "match.integrity-failed": "比赛完整性失败", "baseline.passed": "基线已通过", "baseline.failed": "基线失败",
    "baseline.confirmed": "基线已冻结", "runtime.started": "运行已启动", "runtime.paused": "运行已暂停",
    "runtime.cancelled": "运行已终止", "exhibition.started": "展示局已启动",
  };
  return labels[type] ?? type;
}

function safeGeneralAuditDescription(event: ExperimentAuditEvent) {
  const generation = typeof event.details.generation === "number" ? `第 ${event.details.generation} 代；` : "";
  const reason = typeof event.details.reason === "string" && /^[a-z0-9.-]{1,80}$/i.test(event.details.reason)
    ? `原因分类 ${event.details.reason}。` : "";
  return `${generation}${auditEventLabel(event.type)}。${reason}`;
}
