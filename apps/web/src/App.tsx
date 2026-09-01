import type {
  Experiment,
  ExperimentStatus,
  HarnessCatalogResponse,
  HarnessModel,
  ModelProfileInput,
  ProviderOptionValue,
  ReasoningEffort,
} from "@maze-arena/contracts";
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
  const [catalog, setCatalog] = useState<HarnessCatalogResponse>({ providers: [] });
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [contextTokens, setContextTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [totalTokenLimit, setTotalTokenLimit] = useState("");
  const [providerOptions, setProviderOptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState<string>();

  const loadExperiments = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [next, nextCatalog] = await Promise.all([
        arenaApi.listExperiments(),
        arenaApi.getHarnessCatalog(),
      ]);
      setExperiments(next);
      setCatalog(nextCatalog);
      const firstProvider = nextCatalog.providers[0];
      const firstModel = firstProvider?.models[0];
      setProviderId(firstProvider?.id ?? "");
      setModelId(firstModel?.id ?? "");
      resetModelFields(firstModel);
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
      const modelProfile = buildModelProfile();
      const created = await arenaApi.createExperiment({ name: name.trim(), modelProfile });
      setExperiments((current) => [created, ...current]);
      setSelectedId(created.id);
      setName("");
      setCredentialRef("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveSelectedModelProfile() {
    if (!selected || selected.status !== "draft") return;
    setSavingProfile(true);
    setError(undefined);
    try {
      const updated = await arenaApi.updateModelProfile(selected.id, buildModelProfile());
      setExperiments((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存模型配置失败");
    } finally {
      setSavingProfile(false);
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
  const selectedProvider = catalog.providers.find((provider) => provider.id === providerId) ?? catalog.providers[0];
  const selectedModel = selectedProvider?.models.find((model) => model.id === modelId) ?? selectedProvider?.models[0];

  function buildModelProfile(): ModelProfileInput {
    const modelProfile: ModelProfileInput = {
      providerId,
      modelId,
      credentialRef: credentialRef.trim(),
      contextTokens: Number(contextTokens),
      outputTokens: Number(outputTokens),
      totalTokenLimit: Number(totalTokenLimit),
    };
    if (selectedModel?.capabilities.reasoningEfforts.length) modelProfile.reasoningEffort = reasoningEffort;
    if (selectedModel?.capabilities.temperature) modelProfile.temperature = Number(temperature);
    if (selectedModel?.capabilities.topP) modelProfile.topP = Number(topP);
    const parsedProviderOptions: Record<string, ProviderOptionValue> = {};
    for (const [key, capability] of Object.entries(selectedModel?.capabilities.providerOptions ?? {})) {
      const value = providerOptions[key] ?? "";
      parsedProviderOptions[key] = capability.type === "number" ? Number(value)
        : capability.type === "boolean" ? value === "true"
        : value;
    }
    if (Object.keys(parsedProviderOptions).length > 0) modelProfile.providerOptions = parsedProviderOptions;
    return modelProfile;
  }

  function resetModelFields(model: HarnessModel | undefined) {
    if (!model) return;
    setReasoningEffort(model.capabilities.reasoningEfforts[0] ?? "medium");
    setTemperature(model.capabilities.temperature ? String(model.capabilities.temperature.minimum) : "");
    setTopP(model.capabilities.topP ? String(model.capabilities.topP.maximum) : "");
    setContextTokens(String(Math.min(4_000, model.capabilities.maxContextTokens)));
    setOutputTokens(String(Math.min(1_000, model.capabilities.maxOutputTokens)));
    setTotalTokenLimit(String(Math.min(5_000, model.capabilities.maxTotalTokens)));
    setProviderOptions(Object.fromEntries(Object.entries(model.capabilities.providerOptions).map(([key, capability]) => [
      key,
      capability.type === "boolean" ? "false" : capability.type === "number" ? String(capability.minimum ?? 0) : "",
    ])));
  }

  function changeProvider(nextProviderId: string) {
    const provider = catalog.providers.find((candidate) => candidate.id === nextProviderId);
    const model = provider?.models[0];
    setProviderId(nextProviderId);
    setModelId(model?.id ?? "");
    resetModelFields(model);
  }

  function changeModel(nextModelId: string) {
    const model = selectedProvider?.models.find((candidate) => candidate.id === nextModelId);
    setModelId(nextModelId);
    resetModelFields(model);
  }

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
            <div className="field-grid">
              <label>新实验名称<input
                id="experiment-name"
                aria-label="新实验名称"
                maxLength={120}
                placeholder="例如：求解器基线"
                value={name}
                onChange={(event) => setName(event.target.value)}
              /></label>
              <label>模型提供方<select aria-label="模型提供方" value={providerId} onChange={(event) => changeProvider(event.target.value)}>
                {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
              </select></label>
              <label>模型<select aria-label="模型" value={modelId} onChange={(event) => changeModel(event.target.value)}>
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select></label>
              <label>凭据引用<input aria-label="凭据引用" placeholder="例如：dsh-credential://deepseek-main" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} /></label>
              {selectedModel?.capabilities.reasoningEfforts.length ? (
                <label>推理强度<select aria-label="推理强度" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}>
                  {selectedModel.capabilities.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                </select></label>
              ) : null}
              {selectedModel?.capabilities.temperature ? <label>温度<input aria-label="温度" type="number" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></label> : null}
              {selectedModel?.capabilities.topP ? <label>Top P<input aria-label="Top P" type="number" step="0.1" value={topP} onChange={(event) => setTopP(event.target.value)} /></label> : null}
              <label>上下文令牌<input aria-label="上下文令牌" type="number" value={contextTokens} onChange={(event) => setContextTokens(event.target.value)} /></label>
              <label>输出令牌<input aria-label="输出令牌" type="number" value={outputTokens} onChange={(event) => setOutputTokens(event.target.value)} /></label>
              <label>总令牌上限<input aria-label="总令牌上限" type="number" value={totalTokenLimit} onChange={(event) => setTotalTokenLimit(event.target.value)} /></label>
              {Object.entries(selectedModel?.capabilities.providerOptions ?? {}).map(([option, capability]) => (
                <label key={option}>{option}{capability.type === "boolean" ? (
                  <select aria-label={option} value={providerOptions[option] ?? "false"} onChange={(event) => setProviderOptions((current) => ({ ...current, [option]: event.target.value }))}>
                    <option value="false">false</option><option value="true">true</option>
                  </select>
                ) : (
                  <input aria-label={option} type={capability.type === "number" ? "number" : "text"} value={providerOptions[option] ?? ""} onChange={(event) => setProviderOptions((current) => ({ ...current, [option]: event.target.value }))} />
                )}</label>
              ))}
            </div>
            <div className="create-actions">
              {selected?.status === "draft" && selected.modelProfile === null && (
                <button className="secondary-button" type="button" disabled={savingProfile || !credentialRef.trim() || !selectedModel} onClick={() => void saveSelectedModelProfile()}>
                  {savingProfile ? <LoaderCircle className="spin" size={17} /> : null}
                  保存到当前草稿
                </button>
              )}
              <button className="primary-button" type="submit" disabled={submitting || !name.trim() || !credentialRef.trim() || !selectedModel}>
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
                {selected.status === "draft" && selected.modelProfile && (
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
              <section className="model-profile" aria-label="模型配置档">
                {selected.modelProfile ? (
                  <>
                    <div className="profile-heading"><div><p className="eyebrow">冻结配置档</p><h3>{selected.modelProfile.providerLabel} / {selected.modelProfile.modelLabel}</h3></div><span className="status">{selected.status === "draft" ? "启动时冻结" : "已冻结"}</span></div>
                    <dl className="profile-grid">
                      <div><dt>凭据引用</dt><dd className="mono">{selected.modelProfile.credentialRef}</dd></div>
                      <div><dt>上下文 / 输出</dt><dd>{selected.modelProfile.contextTokens} / {selected.modelProfile.outputTokens}</dd></div>
                      <div><dt>总令牌上限</dt><dd>{selected.modelProfile.totalTokenLimit}</dd></div>
                      <div><dt>Generator Home</dt><dd className="mono">{selected.harnessEnvironments.generator.home}</dd></div>
                      <div><dt>Solver Home</dt><dd className="mono">{selected.harnessEnvironments.solver.home}</dd></div>
                    </dl>
                  </>
                ) : (
                  <div className="profile-heading"><div><p className="eyebrow">模型配置档</p><h3>尚未配置</h3></div><span className="status">启动前必需</span></div>
                )}
              </section>
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
