import type { Experiment, ExperimentStatus } from "@maze-arena/contracts";
import { FlaskConical, LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { arenaApi } from "./api";

const statusLabels: Record<ExperimentStatus, string> = {
  draft: "草稿",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function App() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const loadExperiments = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await arenaApi.listExperiments();
      setExperiments(next);
      setSelectedId((current) => current ?? next[0]?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取实验");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  async function createExperiment(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const created = await arenaApi.createExperiment({ name: name.trim() });
      setExperiments((current) => [created, ...current]);
      setSelectedId(created.id);
      setName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function startExperiment(experiment: Experiment) {
    setError(undefined);
    try {
      const updated = await arenaApi.startExperiment(experiment.id);
      setExperiments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "启动失败");
    }
  }

  const selected = experiments.find((experiment) => experiment.id === selectedId);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><FlaskConical size={20} /> Maze Arena</div>
        <div className="instance-state"><span /> 本机 Arena</div>
      </header>

      <main className="workspace">
        <aside className="experiment-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">实验工作台</p>
              <h1>实验</h1>
            </div>
            <button className="icon-button" type="button" title="刷新实验" onClick={() => void loadExperiments()}>
              <RefreshCw size={17} />
            </button>
          </div>

          <form className="create-form" onSubmit={(event) => void createExperiment(event)}>
            <label htmlFor="experiment-name">新实验名称</label>
            <div className="create-row">
              <input
                id="experiment-name"
                maxLength={120}
                placeholder="例如：求解器基线"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <button className="primary-button" type="submit" disabled={submitting || !name.trim()}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
                创建
              </button>
            </div>
          </form>

          {error && <div className="error-banner" role="alert">{error}</div>}

          <div className="experiment-list" role="region" aria-label="实验列表">
            {loading ? (
              <div className="empty-state"><LoaderCircle className="spin" size={20} />正在读取实验</div>
            ) : experiments.length === 0 ? (
              <div className="empty-state">尚无实验，请先创建一个草稿。</div>
            ) : experiments.map((experiment) => (
              <button
                className={`experiment-row ${selectedId === experiment.id ? "selected" : ""}`}
                key={experiment.id}
                type="button"
                onClick={() => setSelectedId(experiment.id)}
              >
                <span className="experiment-name">{experiment.name}</span>
                <span className={`status status-${experiment.status}`}>{statusLabels[experiment.status]}</span>
                <time>{new Date(experiment.createdAt).toLocaleString("zh-CN")}</time>
              </button>
            ))}
          </div>
        </aside>

        <section className="detail-panel" aria-label="实验详情">
          {selected ? (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">实验详情</p>
                  <h2>{selected.name}</h2>
                </div>
                {selected.status === "draft" && (
                  <button className="primary-button" type="button" onClick={() => void startExperiment(selected)}>
                    <Play size={17} fill="currentColor" />启动实验
                  </button>
                )}
              </div>
              <dl className="facts">
                <div><dt>状态</dt><dd><span className={`status status-${selected.status}`}>{statusLabels[selected.status]}</span></dd></div>
                <div><dt>创建时间</dt><dd>{new Date(selected.createdAt).toLocaleString("zh-CN")}</dd></div>
                <div><dt>实验 ID</dt><dd className="mono">{selected.id}</dd></div>
              </dl>
              <div className="arena-placeholder">
                <div className="grid-preview" aria-hidden="true" />
                <div><strong>竞技场待命</strong><p>实验配置将在后续切片中冻结并进入基线验收。</p></div>
              </div>
            </>
          ) : (
            <div className="detail-empty"><FlaskConical size={30} /><p>选择或创建实验以查看详情。</p></div>
          )}
        </section>
      </main>
    </div>
  );
}
