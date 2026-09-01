import type { ArenaMatch, MatchEvent, MatchEventPage } from "@maze-arena/contracts";
import { createInitialProjection, projectMatchEvents } from "@maze-arena/engine";
import { ChevronLeft, ChevronRight, LoaderCircle, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface ArenaViewProps {
  experimentId: string;
  canRun: boolean;
  runMatch: (experimentId: string) => Promise<ArenaMatch>;
  loadLatest: (experimentId: string) => Promise<ArenaMatch | null>;
  loadEvents: (matchId: string, afterSequence: number) => Promise<MatchEventPage>;
}

export function ArenaView({ experimentId, canRun, runMatch, loadLatest, loadEvents }: ArenaViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [match, setMatch] = useState<ArenaMatch>();
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const projection = useMemo(
    () => projectMatchEvents(createInitialProjection(), events.slice(0, cursor)),
    [cursor, events],
  );

  useEffect(() => {
    let active = true;
    setMatch(undefined);
    setEvents([]);
    setCursor(0);
    setPlaying(false);
    setError(undefined);
    void loadLatest(experimentId).then((latest) => {
      if (active && latest) setMatch(latest);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "读取历史比赛失败");
    });
    return () => { active = false; };
  }, [experimentId, loadLatest]);

  useEffect(() => {
    if (!match) return;
    let active = true;
    const after = events.at(-1)?.sequence ?? 0;
    if (match.status === "completed" && after >= match.committedEventCount) return;
    const timer = window.setTimeout(() => {
      void loadEvents(match.id, after).then((page) => {
        if (!active) return;
        setMatch(page.match);
        if (page.events.length > 0) {
          setEvents((current) => [...current, ...page.events]);
        }
      }).catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "读取比赛事件失败");
      });
    }, after === 0 ? 0 : 20);
    return () => { active = false; window.clearTimeout(timer); };
  }, [events, loadEvents, match]);

  useEffect(() => {
    if (!playing || cursor >= events.length) return;
    const timer = window.setInterval(() => {
      setCursor((current) => Math.min(events.length, current + Math.max(1, speed * 4)));
    }, 80);
    return () => window.clearInterval(timer);
  }, [cursor, events.length, playing, speed]);

  useEffect(() => {
    if (match?.status === "completed" && cursor >= events.length) setPlaying(false);
  }, [cursor, events.length, match?.status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const pixels = Math.max(320, Math.floor(canvas.getBoundingClientRect().width || 640));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = pixels * ratio;
    canvas.height = pixels * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#081015";
    context.fillRect(0, 0, pixels, pixels);
    const padding = 14;
    const cell = (pixels - padding * 2) / projection.size;
    context.strokeStyle = "#1a2830";
    context.lineWidth = 1;
    for (let index = 0; index <= projection.size; index += 1) {
      const offset = padding + index * cell;
      context.beginPath(); context.moveTo(padding, offset); context.lineTo(pixels - padding, offset); context.stroke();
      context.beginPath(); context.moveTo(offset, padding); context.lineTo(offset, pixels - padding); context.stroke();
    }
    context.strokeStyle = "#66d3b2";
    context.lineWidth = Math.max(2, cell * 0.42);
    context.lineCap = "square";
    for (const passage of projection.passages) {
      context.beginPath();
      context.moveTo(padding + (passage.from.x + 0.5) * cell, padding + (passage.from.y + 0.5) * cell);
      context.lineTo(padding + (passage.to.x + 0.5) * cell, padding + (passage.to.y + 0.5) * cell);
      context.stroke();
    }
    for (const [point, color] of [[projection.start, "#65a9ff"], [projection.goal, "#f3c969"], [projection.solver, "#ff7d8d"]] as const) {
      context.fillStyle = color;
      context.beginPath();
      context.arc(padding + (point.x + 0.5) * cell, padding + (point.y + 0.5) * cell, Math.max(3, cell * 0.34), 0, Math.PI * 2);
      context.fill();
    }
  }, [projection]);

  async function executeBaseline() {
    setRunning(true);
    setError(undefined);
    try {
      const started = await runMatch(experimentId);
      setMatch(started);
      setEvents([]);
      setCursor(0);
      setPlaying(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "基线比赛执行失败");
    } finally {
      setRunning(false);
    }
  }

  const buffered = Math.max(0, (match?.committedEventCount ?? events.length) - cursor);
  return (
    <section className="arena-view" aria-label="Arena 直播与回放">
      <div className="arena-heading">
        <div><p className="eyebrow">Arena Engine</p><h3>基线迷宫直播</h3></div>
        {canRun ? <button className="primary-button" type="button" disabled={running} onClick={() => void executeBaseline()}>
          {running ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
          运行基线比赛
        </button> : null}
      </div>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      <div className="arena-layout">
        <canvas ref={canvasRef} className="maze-canvas" role="img" aria-label="迷宫比赛画布" />
        <div className="arena-sidebar">
          <dl className="arena-stats">
            <div><dt>阶段</dt><dd>{phaseLabel(projection.phase)}</dd></div>
            <div><dt>事件</dt><dd>序号 {cursor} / {events.length}</dd></div>
            <div><dt>缓冲</dt><dd>缓冲 {buffered}</dd></div>
            <div><dt>动作</dt><dd>{projection.actions} / 1441</dd></div>
          </dl>
          <div className="playback-controls" aria-label="回放控制">
            <button className="icon-button" type="button" title="跳到开头" aria-label="跳到开头" disabled={!match} onClick={() => setCursor(0)}><SkipBack size={17} /></button>
            <button className="icon-button" type="button" title="单步后退" aria-label="单步后退" disabled={!match || cursor === 0} onClick={() => setCursor((value) => Math.max(0, value - 1))}><ChevronLeft size={17} /></button>
            <button className="icon-button playback-primary" type="button" title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"} disabled={!match || cursor >= events.length} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}</button>
            <button className="icon-button" type="button" title="单步前进" aria-label="单步前进" disabled={!match || cursor >= events.length} onClick={() => setCursor((value) => Math.min(events.length, value + 1))}><ChevronRight size={17} /></button>
            <button className="icon-button" type="button" title="跳到结尾" aria-label="跳到结尾" disabled={!match} onClick={() => setCursor(events.length)}><SkipForward size={17} /></button>
          </div>
          <label className="timeline-label">事件位置
            <input aria-label="事件位置" type="range" min="0" max={events.length} value={cursor} disabled={!match} onChange={(event) => { setPlaying(false); setCursor(Number(event.target.value)); }} />
          </label>
          <label className="speed-label">播放速度
            <select aria-label="播放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
              <option value="1">1x</option><option value="2">2x</option><option value="4">4x</option><option value="8">8x</option>
            </select>
          </label>
          <div className={`match-result ${projection.score?.solved ? "solved" : ""}`}>
            {projection.score ? (projection.score.solved ? "已解决" : "预算耗尽") : match?.status === "running" ? "执行中" : "等待比赛事件"}
          </div>
        </div>
      </div>
    </section>
  );
}

function phaseLabel(phase: "generation" | "solving" | "completed"): string {
  return phase === "generation" ? "生成" : phase === "solving" ? "求解" : "完成";
}
