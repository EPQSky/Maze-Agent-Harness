import type { ArenaMatch, MatchEventPage } from "@maze-arena/contracts";
import { runBaselineMatch } from "@maze-arena/engine";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArenaView } from "./ArenaView";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function completedFixture(seed = "web-seed") {
  const result = runBaselineMatch(seed);
  const match: ArenaMatch = {
    id: "match-1", experimentId: "experiment-1", seed, protocolVersion: 1, status: "completed",
    committedEventCount: result.events.length, totalEventCount: result.events.length, score: result.score,
  };
  const loadEvents = vi.fn(async (_id: string, after: number): Promise<MatchEventPage> => {
    const events = result.events.slice(after, after + 256);
    return { match, events, nextSequence: events.at(-1)?.sequence ?? after };
  });
  return { result, match, loadEvents };
}

describe("Arena 播放器", () => {
  it("切换实验后自动加载最新历史比赛并完整回放", async () => {
    const { result, match, loadEvents } = completedFixture();
    render(<ArenaView
      experimentId="experiment-1" canRun={true}
      runMatch={vi.fn()} loadLatest={vi.fn().mockResolvedValue(match)} loadEvents={loadEvents}
    />);

    await waitFor(() => expect(loadEvents).toHaveBeenCalledTimes(Math.ceil(result.events.length / 256)));
    expect(screen.getByText(`序号 0 / ${result.events.length}`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("事件位置"), { target: { value: String(result.events.length) } });
    expect(screen.getByText("已解决")).toBeInTheDocument();
  });

  it("轮询运行中已提交事件形成缓冲，且终态实验隐藏运行入口", async () => {
    const result = runBaselineMatch("live-seed");
    const running: ArenaMatch = {
      id: "live-match", experimentId: "experiment-1", seed: "live-seed", protocolVersion: 1,
      status: "running", committedEventCount: 80, totalEventCount: result.events.length, score: null,
    };
    const completed: ArenaMatch = { ...running, status: "completed", committedEventCount: result.events.length, score: result.score };
    const loadEvents = vi.fn()
      .mockResolvedValueOnce({ match: running, events: result.events.slice(0, 80), nextSequence: 80 })
      .mockResolvedValue({ match: completed, events: result.events.slice(80), nextSequence: result.events.length });
    render(<ArenaView
      experimentId="experiment-1" canRun={false}
      runMatch={vi.fn()} loadLatest={vi.fn().mockResolvedValue(running)} loadEvents={loadEvents}
    />);

    expect(screen.queryByRole("button", { name: "运行基线比赛" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/缓冲 80/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(`序号 0 / ${result.events.length}`)).toBeInTheDocument());
  });

  it("Canvas 使用稳定方形尺寸并执行绘制调用", () => {
    render(<ArenaView
      experimentId="experiment-1" canRun={false}
      runMatch={vi.fn()} loadLatest={vi.fn().mockResolvedValue(null)} loadEvents={vi.fn()}
    />);
    const canvas = screen.getByRole("img", { name: "迷宫比赛画布" }) as HTMLCanvasElement;
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const context = getContext.mock.results.at(-1)?.value as unknown as { fillRect: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn> };
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(640);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 640, 640);
    expect(context.stroke).toHaveBeenCalled();
  });

  it("8x 在相同计时窗口内比 1x 消费更多事件", async () => {
    const { result, match } = completedFixture("speed-seed");
    const loadEvents = vi.fn().mockResolvedValue({ match, events: result.events, nextSequence: result.events.length });
    render(<ArenaView
      experimentId="experiment-1" canRun={true}
      runMatch={vi.fn()} loadLatest={vi.fn().mockResolvedValue(match)} loadEvents={loadEvents}
    />);
    await waitFor(() => expect(screen.getByText(`序号 0 / ${result.events.length}`)).toBeInTheDocument());
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("播放速度"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    expect(screen.getByText(`序号 4 / ${result.events.length}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    fireEvent.click(screen.getByRole("button", { name: "跳到开头" }));
    fireEvent.change(screen.getByLabelText("播放速度"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    expect(screen.getByText(`序号 32 / ${result.events.length}`)).toBeInTheDocument();
  });
});
