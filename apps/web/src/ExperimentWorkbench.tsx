import type { ArenaMatch, BaselineValidationRecord, ExperimentAuditEvent, ExperimentRuntimeSnapshot, LineageHistoryResponse, ModelProfileInput } from "@maze-arena/contracts";
import { Check, CircleAlert, FlaskConical, GitBranch, Pause, Play, ShieldCheck, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

      {tab === "Generations" && <div className="workbench-view"><h3>进化代</h3>{runtime?.generations.length ? runtime.generations.map((generation) => <div className="data-row" key={generation.generation}><strong>第 {generation.generation} 代</strong><span>Generator {generation.generator?.outcome ?? "基础设施失败"} · 公开 {generation.generator?.publicProgress ?? 0} / 隐藏 {generation.generator?.hiddenProgress ?? 0}</span><span>Solver {generation.solver?.outcome ?? "基础设施失败"} · 公开 {generation.solver?.publicProgress ?? 0} / 隐藏 {generation.solver?.hiddenProgress ?? 0}</span><span>停滞 {generation.stagnationCount} · 展示局 {generation.exhibitionMatchId ?? "无"}</span></div>) : <p className="muted">尚无已提交进化代。</p>}</div>}
      {tab === "Matches" && <div className="workbench-view"><h3>比赛</h3><div className="filter-bar"><select aria-label="代次筛选" value={generationFilter} onChange={(event) => setGenerationFilter(event.target.value)}><option value="all">全部代次</option>{runtime?.generations.map(({ generation }) => <option key={generation} value={generation}>第 {generation} 代</option>)}</select><select aria-label="角色筛选" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">全部角色</option><option value="generator">Generator</option><option value="solver">Solver</option><option value="exhibition">展示局</option></select><input aria-label="对手筛选" placeholder="对手版本" value={opponentFilter} onChange={(event) => setOpponentFilter(event.target.value)} /><select aria-label="评测类型筛选" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">全部类型</option><option value="public">公开评测</option><option value="hidden">隐藏聚合</option><option value="exhibition">展示局</option></select><select aria-label="结果筛选" value={resultFilter} onChange={(event) => setResultFilter(event.target.value)}><option value="all">全部结果</option><option value="won">胜</option><option value="lost">负</option><option value="tie">平</option><option value="completed">完成</option></select></div>{visibleMatches.map((match) => <div className="data-row" key={match.id}><code>{match.id}</code><span>{match.observation ? `${match.observation.role} · ${match.observation.evaluationType} · ${match.observation.result}` : "基线"} · {match.committedEventCount} 步</span>{match.observation?.replayable !== false && <button className="secondary-button" onClick={() => onOpenMatch(match.id)}>打开回放</button>}</div>)}<p className="muted">隐藏评测只显示聚合进度，不提供种子、迷宫或单场轨迹。</p></div>}
      {tab === "Lineages" && <div className="workbench-view"><h3>插件谱系</h3><div className="champion-grid"><div><GitBranch size={17} /><span>Generator 冠军</span><code>{runtime?.champions.generator ?? "baseline"}</code></div><div><GitBranch size={17} /><span>Solver 冠军</span><code>{runtime?.champions.solver ?? "baseline"}</code></div></div>{lineages.generator.map((entry) => <div className="data-row" key={`g-${entry.commit}`}><strong>Generator</strong><code>{entry.commit}</code><span>{entry.subject} {entry.tags.join(" · ")}</span></div>)}{lineages.solver.map((entry) => <div className="data-row" key={`s-${entry.commit}`}><strong>Solver</strong><code>{entry.commit}</code><span>{entry.subject} {entry.tags.join(" · ")}</span></div>)}{runtime && <><div className="derive-controls"><input aria-label="派生实验名称" placeholder="派生实验名称" value={derivedName} onChange={(event) => setDerivedName(event.target.value)} /><button className="secondary-button" disabled={busy || !derivedName.trim()} onClick={() => void derive("clone")}>比较克隆</button><button className="secondary-button" disabled={busy || !derivedName.trim()} onClick={() => void derive("fork")}>延续分支</button><button className="danger-button" disabled={busy || runtime.state === "running" || !runtime.sealed} onClick={() => void arenaApi.unsealGroup(experimentId).then(() => refresh()).catch((reason) => setError(reason.message))}>解封组</button></div><div className="derive-controls"><select aria-label="展示局 Generator 版本" value={generatorCommit} onChange={(event) => setGeneratorCommit(event.target.value)}>{lineages.generator.map((entry) => <option key={entry.commit} value={entry.commit}>{entry.commit.slice(0, 12)} · {entry.subject}</option>)}</select><select aria-label="展示局 Solver 版本" value={solverCommit} onChange={(event) => setSolverCommit(event.target.value)}>{lineages.solver.map((entry) => <option key={entry.commit} value={entry.commit}>{entry.commit.slice(0, 12)} · {entry.subject}</option>)}</select><input aria-label="展示局公开种子" value={publicSeed} onChange={(event) => setPublicSeed(event.target.value)} /><button className="secondary-button" disabled={busy || !publicSeed || !generatorCommit || !solverCommit} onClick={() => void createExhibition()}>创建展示局</button></div><p className="muted">兼容性指纹：<code>{runtime.compatibilityFingerprint}</code> · 评测套件：<code>{runtime.evaluationSuiteId}</code>。指纹不同的延续分支不可直接比较。</p></>}</div>}
      {tab === "Candidates" && <div className="workbench-view"><h3>候选与门禁</h3>{runtime?.generations.flatMap((generation) => [generation.generator, generation.solver]).filter(Boolean).map((candidate, index) => <div className="data-row" key={index}><code>{candidate!.candidateCommit}</code><span>{candidate!.hypothesis ?? candidate!.outcome}<br />{candidate!.diffSummary || "无源码差异"}</span><span>{candidate!.gateDiagnostics?.join("；") || candidate!.promotionTag || "未晋级"}</span></div>)}</div>}
      {tab === "Audit" && <div className="workbench-view" data-owner-only="true"><h3>本机所有者审计</h3>{audit.map((event) => <div className="data-row" key={event.id}><time>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time><strong>{event.type}</strong><code>{JSON.stringify(event.details)}</code></div>)}</div>}
    </section>
  );
}
