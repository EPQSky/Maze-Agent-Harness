import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterError,
  classifyFinalizedRuntimeFailure,
  classifyRuntimeFailure,
  classifyRuntimeFailureFromChannel,
  createEvolutionPrompt,
  createRuntimePatch,
  createSessionRuntimeFiles,
  finalizeSdkRuntime,
  maxModelCallsForOperation,
  modelVisibleInputTokenUpperBound,
  parseFinalJson,
  requestPromptAndWaitForIdle,
  requestSmokeResult,
  requestStrictEvolutionResult,
  sdkChildStdio,
  SdkClient,
  TrustedLocalFailureChannel,
  validateEvolutionResult,
} from "./dsh-sdk-adapter.js";

describe("官方 DSH SDK 私有能力传递", () => {
  it("把凭据 FD 4 与预算账本 FD 5 原位继承给 DSH 子进程", () => {
    expect(sdkChildStdio()).toEqual(["pipe", "pipe", "pipe"]);
    expect(sdkChildStdio(4)).toEqual(["pipe", "pipe", "pipe", "ignore", 4]);
    expect(sdkChildStdio(undefined, 5)).toEqual(["pipe", "pipe", "pipe", "ignore", "ignore", 5]);
    expect(sdkChildStdio(4, 5)).toEqual(["pipe", "pipe", "pipe", "ignore", 4, 5]);
    expect(sdkChildStdio(4, 5, true)).toEqual(["pipe", "pipe", "pipe", "ignore", 4, 5, "pipe"]);
  });

  it("只接受可信旁路中的闭集本地码", () => {
    expect(classifyRuntimeFailure(new Error("provider"), "ARENA_REQUEST_CONTEXT_EXCEEDED"))
      .toEqual({ kind: "protocol", code: "ARENA_REQUEST_CONTEXT_EXCEEDED" });
    expect(classifyRuntimeFailure(new Error("provider"), "PROVIDER_FORGED"))
      .toEqual({ kind: "process", code: "SDK_LOCAL_FAILURE_CHANNEL_INVALID" });
  });

  it("FD6 封口后统一解析 empty、attempt、session 与 invalid", async () => {
    const identity = {
      sessionId: "session-current", provider: "deepseek-official", model: "deepseek-v4-flash",
    };
    const detailedFrame = JSON.stringify({
      type: "maze-arena.local-failure", protocolVersion: 1, scope: "attempt",
      ...identity, attemptId: `${identity.sessionId}:4`, attemptSequence: 4,
      code: "ARENA_AGENT_PRE_STEP_FAILED", stage: "agent-pre-step", errorType: "TypeError",
      messageFingerprint: "0123456789abcdef", stackFingerprint: "fedcba9876543210",
    }) + "\n";
    const attemptFrame = `${JSON.stringify({
      type: "maze-arena.local-failure", protocolVersion: 1, scope: "attempt",
      ...identity, attemptId: `${identity.sessionId}:3`, attemptSequence: 3,
      code: "ARENA_REQUEST_CONTEXT_EXCEEDED",
    })}\n`;
    const read = async (chunks: Array<string | { delayMs: number; value: string }>) => {
      const stream = new PassThrough();
      const channel = new TrustedLocalFailureChannel(stream);
      const result = channel.readResult({ ...identity, deadlineAt: Date.now() + 1_000 });
      for (const chunk of chunks) {
        if (typeof chunk !== "string") {
          await new Promise((resolveWait) => setTimeout(resolveWait, chunk.delayMs));
          stream.write(chunk.value);
        } else stream.write(chunk);
      }
      stream.end();
      return result;
    };

    await expect(read([{ delayMs: 75, value: attemptFrame.slice(0, 19) }, attemptFrame.slice(19)]))
      .resolves.toEqual({ kind: "attempt", attemptSequence: 3, code: "ARENA_REQUEST_CONTEXT_EXCEEDED" });
    await expect(read([])).resolves.toEqual({ kind: "empty" });
    await expect(read([attemptFrame, attemptFrame])).resolves.toEqual({ kind: "invalid" });
    await expect(read([attemptFrame, "malformed-tail"])).resolves.toEqual({ kind: "invalid" });
    await expect(read(["x".repeat(4097)])).resolves.toEqual({ kind: "invalid" });
    await expect(read([attemptFrame.replace(identity.sessionId, "session-other")]))
      .resolves.toEqual({ kind: "invalid" });
    await expect(read([detailedFrame])).resolves.toEqual({
      kind: "attempt", attemptSequence: 4, code: "ARENA_AGENT_PRE_STEP_FAILED",
      stage: "agent-pre-step", errorType: "TypeError",
      messageFingerprint: "0123456789abcdef", stackFingerprint: "fedcba9876543210",
    });
    await expect(read([detailedFrame.replace("agent-pre-step", "Agent-Pre-Step")]))
      .resolves.toEqual({ kind: "invalid" });
    await expect(read([detailedFrame.replace("0123456789abcdef", "not-a-fingerprint")]))
      .resolves.toEqual({ kind: "invalid" });

    const unsealed = new PassThrough();
    const deadlineChannel = new TrustedLocalFailureChannel(unsealed);
    await expect(deadlineChannel.readResult({ ...identity, deadlineAt: Date.now() + 20 }))
      .resolves.toEqual({ kind: "invalid" });
    unsealed.destroy();
  });

  it("FD6 session 事实优先，非匹配 attempt 才保留 Provider 错误", async () => {
    const identity = {
      sessionId: "session-current", provider: "deepseek-official", model: "deepseek-v4-flash",
    };
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    stream.end(`${JSON.stringify({
      type: "maze-arena.local-failure", protocolVersion: 1, scope: "session",
      ...identity,
      code: "ARENA_LEDGER_REJECTED",
    })}\n`);
    const session = await channel.readResult({ ...identity, deadlineAt: Date.now() + 1_000 });
    const providerError = Object.assign(new Error("provider"), { kind: "provider", code: "UNKNOWN" });
    const baseline = classifyRuntimeFailure(providerError);
    expect(classifyRuntimeFailureFromChannel(providerError, session, 2))
      .toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
    expect(classifyRuntimeFailureFromChannel(undefined, session))
      .toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
    expect(classifyRuntimeFailureFromChannel(providerError, {
      kind: "attempt", attemptSequence: 1, code: "ARENA_REQUEST_CONTEXT_EXCEEDED",
    }, 2)).toEqual(baseline);
    expect(classifyRuntimeFailureFromChannel(providerError, {
      kind: "attempt", attemptSequence: 2, code: "ARENA_REQUEST_CONTEXT_EXCEEDED",
    }, 2)).toEqual({ kind: "protocol", code: "ARENA_REQUEST_CONTEXT_EXCEEDED" });
    expect(classifyRuntimeFailureFromChannel(providerError, { kind: "invalid" }, 2))
      .toEqual({ kind: "process", code: "SDK_LOCAL_FAILURE_CHANNEL_INVALID" });
    expect(classifyRuntimeFailureFromChannel(providerError, { kind: "empty" }, 2))
      .toEqual(baseline);
  });

  it("FD6 未匹配、陈旧或不唯一时不能覆盖 Provider 失败", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(turnEndEvent({ kind: "error", error: {
      code: "UNKNOWN", message: "provider-owned-message",
    } })));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));
    const providerError = await idle.catch((error) => error);
    expect(providerError).toMatchObject({ kind: "provider", code: "UNKNOWN" });
    expect(classifyRuntimeFailure(providerError, undefined)).toEqual({ kind: "provider", code: "UNKNOWN" });
  });
});

describe("官方 DSH 操作模型回合预算", () => {
  it("smoke 为官方 readiness 内部回合保留第二次模型调用", () => {
    expect(maxModelCallsForOperation("smoke")).toBe(2);
    expect(maxModelCallsForOperation("evolve", 8)).toBe(8);
  });
});

describe("官方 DSH 模型可见输入上界", () => {
  it("完整覆盖 system、ASCII 工具 schema、CJK 与工具历史", () => {
    const options = {
      system: "ASCII system 指令",
      tools: [{ name: "read", description: "Read one file", inputSchema: {
        type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"],
      } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "读取源码并检查边界" }] },
        { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "read",
          arguments: '{"file_path":"src/index.ts"}' }] },
        { role: "tool", content: [{ type: "tool-result", content: [{ type: "text", text: "const value = 1;" }] }] },
      ],
    };
    const visibleBytes = Buffer.byteLength(JSON.stringify(options), "utf8");
    expect(modelVisibleInputTokenUpperBound(options)).toBe(visibleBytes + 8_192);
    expect(visibleBytes).toBeGreaterThan(JSON.stringify(options).length);
  });
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 2_147_483_647;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function frame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function client(budget?: { maxTokens: number; maxCost: number; maxModelCalls: number }): { child: FakeChild; client: SdkClient } {
  const child = new FakeChild();
  return { child, client: new SdkClient(child as never, "session-1", 1, budget) };
}

async function captureUnhandled<T>(task: () => Promise<T>): Promise<{ value: T; reasons: unknown[] }> {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  try {
    const value = await task();
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    return { value, reasons };
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

describe("官方 DSH SDK prompt 与 idle 联合失败观察", () => {
  it.each(["exit", "error"] as const)(
    "child %s 同时拒绝 prompt 与 idle 时不产生 unhandledRejection，并保留稳定 process code",
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), `maze-sdk-${failure}-`));
      const child = failure === "exit"
        ? spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(17));"], {
          cwd: root, stdio: ["pipe", "pipe", "pipe"],
        })
        : new FakeChild();
      const sdk = new SdkClient(child as ChildProcessWithoutNullStreams, "session-1", 1);
      try {
        const outcome = await captureUnhandled(async () => {
          const pending = requestPromptAndWaitForIdle(sdk, "session-1", "Return one short response.")
            .then(() => undefined, (error: unknown) => error);
          if (failure === "error") child.emit("error", new Error("synthetic child error"));
          return pending;
        });
        expect(outcome.reasons).toEqual([]);
        expect(outcome.value).toEqual(expect.objectContaining({
          message: failure === "exit"
            ? expect.stringContaining("官方 DSH SDK runtime 提前退出") : "synthetic child error",
        }));
        expect(classifyFinalizedRuntimeFailure(outcome.value, { localFailure: { kind: "empty" } }))
          .toEqual({ kind: "process", code: "SDK_RUNTIME_FAILED" });
        if (failure === "exit") {
          await waitForExit(child as ChildProcessWithoutNullStreams);
          expect(child.exitCode).toBe(17);
        }
      } finally {
        if (failure === "exit") {
          const processChild = child as ChildProcessWithoutNullStreams;
          if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL");
          await waitForExit(processChild);
        } else {
          const fakeChild = child as FakeChild;
          fakeChild.exitCode = 0;
          fakeChild.emit("exit", 0, null);
          fakeChild.stdin.destroy();
          fakeChild.stdout.destroy();
          fakeChild.stderr.destroy();
        }
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    },
  );

  it("prompt RPC rejection 后 child 退出时两类拒绝均被观察，保留 AdapterError/code 且无残留", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-prompt-rejection-"));
    const child = spawn(process.execPath, ["-e", [
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  const request = JSON.parse(chunk.split('\\n').find(Boolean));",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 'SERVER', message: 'opaque' } }) + '\\n', () => process.exit(19));",
      "});",
    ].join("\n")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const sdk = new SdkClient(child, "session-1", 1);
    try {
      const outcome = await captureUnhandled(async () => requestPromptAndWaitForIdle(
        sdk, "session-1", "Return one short response.",
      ).then(() => undefined, (error: unknown) => error));
      expect(outcome.reasons).toEqual([]);
      expect(outcome.value).toMatchObject({
        name: "AdapterError", kind: "protocol", code: "SDK_JSONRPC_ERROR",
        facts: { wireCode: "SERVER", messageFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) },
      });
      expect((outcome.value as AdapterError).message).not.toContain("opaque");
      expect(classifyFinalizedRuntimeFailure(outcome.value, { localFailure: { kind: "empty" } }))
        .toEqual({ kind: "protocol", code: "SDK_JSONRPC_ERROR" });
      await waitForExit(child);
      expect(child.exitCode).toBe(19);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    }
  });
});

describe("官方 DSH SDK 请求终态边界", () => {
  it("stdin 同步写入失败时拒绝当前请求而不永久悬挂", async () => {
    const { child, client: sdk } = client();
    vi.spyOn(child.stdin, "write").mockImplementation(() => {
      throw new Error("synthetic stdin write failure");
    });

    await expect(sdk.request("initialize")).rejects.toThrow("synthetic stdin write failure");
    expect(child.killed).toBe(true);
    child.stdout.destroy(); child.stderr.destroy();
  });

  it("stdin 异步 error 事件时拒绝当前请求且不产生未处理拒绝", async () => {
    const { child, client: sdk } = client();
    const outcome = await captureUnhandled(async () => {
      const pending = sdk.request("initialize").then(() => undefined, (error: unknown) => error);
      child.stdin.destroy(new Error("synthetic async stdin failure"));
      return pending;
    });

    expect(outcome.reasons).toEqual([]);
    expect(outcome.value).toEqual(expect.objectContaining({ message: "synthetic async stdin failure" }));
    expect(child.killed).toBe(true);
    child.stdout.destroy(); child.stderr.destroy();
  });

  it("child 已退出但尚未派发 exit 事件时拒绝新请求", async () => {
    const { child, client: sdk } = client();
    child.exitCode = 17;

    await expect(sdk.request("initialize")).rejects.toThrow(/runtime 已退出/);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
});

describe("官方 DSH SDK 有界收尾", () => {
  const identity = { sessionId: "session-1", provider: "deepseek-official", model: "deepseek-v4-flash" };
  const sessionFrame = `${JSON.stringify({
    type: "maze-arena.local-failure", protocolVersion: 1, scope: "session", ...identity,
    code: "ARENA_LEDGER_REJECTED",
  })}\n`;
  const finish = (child: FakeChild, stream: PassThrough, exitCode = 0, signal: NodeJS.Signals | null = null): void => {
    child.exitCode = signal === null ? exitCode : null;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
    stream.end();
  };
  const timeouts = { shutdownMs: 10, exitMs: 10, localFailureCloseMs: 20 };

  it("正常 shutdown、退出与空 FD6 在短截止时间内完成", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    const result = await finalizeSdkRuntime(child as never, channel, identity, {
      shutdown: async () => { setTimeout(() => finish(child, stream), 1); },
      timeouts,
    });
    expect(result).toEqual({ localFailure: { kind: "empty" } });
  });

  it("shutdown 前 exit0 直接完成且不发送 RPC", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    finish(child, stream);
    const shutdown = vi.fn(async () => undefined);
    await expect(finalizeSdkRuntime(child as never, channel, identity, { shutdown, timeouts }))
      .resolves.toEqual({ localFailure: { kind: "empty" } });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("自然非零退出使用稳定错误码，matching session 事实仍优先", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    finish(child, stream, 1);
    const result = await finalizeSdkRuntime(child as never, channel, identity, { timeouts });
    expect(result.cleanupError).toMatchObject({ kind: "process", code: "SDK_EXIT_NONZERO" });
    expect(result.cleanupError?.message).not.toMatch(/stderr|opaque/iu);

    const sessionChild = new FakeChild();
    const sessionStream = new PassThrough();
    const sessionChannel = new TrustedLocalFailureChannel(sessionStream);
    sessionStream.end(sessionFrame);
    sessionChild.exitCode = 1;
    const withSession = await finalizeSdkRuntime(sessionChild as never, sessionChannel, identity, { timeouts });
    expect(classifyRuntimeFailureFromChannel(withSession.cleanupError, withSession.localFailure))
      .toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
  });

  it.each(["SIGTERM", "SIGKILL"] as const)("自然信号退出 %s 使用稳定 process 分类", async (signal) => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    finish(child, stream, 0, signal);
    const result = await finalizeSdkRuntime(child as never, channel, identity, { timeouts });
    expect(result).toMatchObject({ localFailure: { kind: "empty" }, cleanupError: {
      kind: "process", code: "SDK_EXIT_SIGNAL",
    } });
  });

  it.each([
    [0, null, undefined],
    [1, null, "SDK_EXIT_NONZERO"],
    [0, "SIGTERM", "SDK_EXIT_SIGNAL"],
    [0, "SIGKILL", "SDK_EXIT_SIGNAL"],
  ] as const)("shutdown 期间真实退出 code=%s signal=%s 优先于挂起 RPC", async (exitCode, signal, expectedCode) => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    setTimeout(() => finish(child, stream, exitCode, signal), 1);
    const result = await finalizeSdkRuntime(child as never, channel, identity, {
      shutdown: () => new Promise(() => undefined), timeouts,
    });
    if (expectedCode === undefined) expect(result.cleanupError).toBeUndefined();
    else expect(result.cleanupError).toMatchObject({ code: expectedCode });
  });

  it("RPC 拒绝后采用随后到达的真实退出结果", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    setTimeout(() => finish(child, stream, 1), 2);
    const result = await finalizeSdkRuntime(child as never, channel, identity, {
      shutdown: async () => { throw new Error("transport closed"); }, timeouts,
    });
    expect(result.cleanupError).toMatchObject({ code: "SDK_EXIT_NONZERO" });
  });

  it("catch 分类保留 Provider/协议根因，FD6 可信事实仍最高优先", () => {
    const provider = new AdapterError("provider", "provider", "UNKNOWN");
    const protocol = new AdapterError("protocol", "protocol", "RESULT_INVALID");
    const cleanupError = new AdapterError("shutdown", "process", "SDK_SHUTDOWN_FAILED");
    expect(classifyFinalizedRuntimeFailure(provider, { localFailure: { kind: "empty" }, cleanupError }))
      .toEqual({ kind: "provider", code: "UNKNOWN" });
    expect(classifyFinalizedRuntimeFailure(protocol, { localFailure: { kind: "empty" }, cleanupError }))
      .toEqual({ kind: "protocol", code: "RESULT_INVALID" });
    expect(classifyFinalizedRuntimeFailure(provider, {
      localFailure: { kind: "session", code: "ARENA_LEDGER_REJECTED" }, cleanupError,
    })).toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
    expect(classifyFinalizedRuntimeFailure(provider, { localFailure: { kind: "invalid" }, cleanupError }))
      .toEqual({ kind: "process", code: "SDK_LOCAL_FAILURE_CHANNEL_INVALID" });
  });

  it("shutdown 不响应时强杀进程组，并优先保留已有 session 事实", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    stream.end(sessionFrame);
    let terminated = 0;
    const result = await finalizeSdkRuntime(child as never, channel, identity, {
      shutdown: () => new Promise(() => undefined),
      terminate: () => { terminated += 1; finish(child, stream, 0, "SIGKILL"); },
      timeouts,
    });
    expect(terminated).toBe(1);
    expect(result.cleanupError).toMatchObject({ code: "SDK_SHUTDOWN_TIMEOUT" });
    expect(classifyRuntimeFailureFromChannel(result.cleanupError, result.localFailure))
      .toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
  });

  it("shutdown 响应但进程不退出时强杀并报告独立退出超时", async () => {
    const child = new FakeChild();
    const stream = new PassThrough();
    const channel = new TrustedLocalFailureChannel(stream);
    let terminated = 0;
    const result = await finalizeSdkRuntime(child as never, channel, identity, {
      shutdown: async () => undefined,
      terminate: () => { terminated += 1; finish(child, stream); },
      timeouts,
    });
    expect(terminated).toBe(1);
    expect(result).toMatchObject({ localFailure: { kind: "empty" }, cleanupError: { code: "SDK_EXIT_TIMEOUT" } });
  });

  it("等待迟到 FD6 封口，但不封口时稳定返回 invalid", async () => {
    const lateChild = new FakeChild();
    const lateStream = new PassThrough();
    const lateChannel = new TrustedLocalFailureChannel(lateStream);
    lateChild.exitCode = 0;
    setTimeout(() => lateStream.end(sessionFrame), 5);
    await expect(finalizeSdkRuntime(lateChild as never, lateChannel, identity, { timeouts }))
      .resolves.toMatchObject({ localFailure: { kind: "session", code: "ARENA_LEDGER_REJECTED" } });

    const stuckChild = new FakeChild();
    const stuckStream = new PassThrough();
    const stuckChannel = new TrustedLocalFailureChannel(stuckStream);
    stuckChild.exitCode = 0;
    await expect(finalizeSdkRuntime(stuckChild as never, stuckChannel, identity, {
      timeouts: { ...timeouts, localFailureCloseMs: 10 },
    })).resolves.toMatchObject({ localFailure: { kind: "invalid" } });
    stuckStream.destroy();
  });
});

function assistantEvent(inputTokens: number, outputTokens: number, text = "ok"): unknown {
  return {
    jsonrpc: "2.0",
    method: "session.event",
    params: {
      sessionId: "session-1",
      event: {
        type: "assistant/message",
        data: {
          message: { content: [{ type: "text", text }] },
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            totalTokens: inputTokens + outputTokens,
          },
        },
      },
    },
  };
}

function turnStartEvent(turn = 1): unknown {
  return { jsonrpc: "2.0", method: "session.event", params: {
    sessionId: "session-1", event: { type: "turn/start", data: { turn } },
  } };
}

function turnEndEvent(reason: unknown, turn = 1, extra: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", method: "session.event", params: {
    sessionId: "session-1", event: { type: "turn/end", data: { turn, reason, ...extra } },
  } };
}

describe("官方 DSH SDK 有界协议客户端", () => {
  it("诊断文件只保留失败事实与 stderr 字节数，不持久化原始 Provider 文本", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-diagnostic-"));
    const diagnosticPath = join(root, "diagnostic.json");
    const previous = process.env.DSH_DIAGNOSTIC_PATH;
    process.env.DSH_DIAGNOSTIC_PATH = diagnosticPath;
    const child = new FakeChild();
    const sdk = new SdkClient(child as never, "session-1", 1);
    try {
      child.stderr.write("provider-secret-response");
      sdk.writeDiagnostic({ error: {
        code: "UNKNOWN", failureFacts: { status: 503, requestId: "req-1", messageFingerprint: "0123456789abcdef" },
        message: "provider-secret-response",
      } });
      const value = JSON.parse(readFileSync(diagnosticPath, "utf8")) as Record<string, unknown>;
      expect(value).toMatchObject({
        stderrBytes: Buffer.byteLength("provider-secret-response"),
        error: { code: "UNKNOWN", failureFacts: {
          status: 503, requestId: "req-1", messageFingerprint: "0123456789abcdef",
        } },
      });
      expect(readFileSync(diagnosticPath, "utf8")).not.toContain("provider-secret-response");
    } finally {
      if (previous === undefined) delete process.env.DSH_DIAGNOSTIC_PATH;
      else process.env.DSH_DIAGNOSTIC_PATH = previous;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝超过 1 MiB 的单帧并终止 SDK", async () => {
    const { child, client: sdk } = client();
    const pending = sdk.request("initialize");
    child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x61));

    await expect(pending).rejects.toThrow(/单帧超过 1 MiB/);
    expect(child.killed).toBe(true);
  });

  it("拒绝累计超过 64 MiB 的 stdout，即使每帧都低于上限", async () => {
    const { child, client: sdk } = client();
    const pending = sdk.request("initialize");
    const payload = "x".repeat(900_000);
    for (let id = 10; id < 85; id += 1) child.stdout.write(frame({ jsonrpc: "2.0", id, result: payload }));

    await expect(pending).rejects.toThrow(/stdout 累计超过 64 MiB/);
    expect(child.killed).toBe(true);
  }, 15_000);

  it("拒绝累计超过 16 MiB 的保留事件", async () => {
    const accumulated = client();
    const accumulatedPending = accumulated.client.request("initialize");
    const event = frame({
      jsonrpc: "2.0",
      method: "session.event",
      params: { sessionId: "session-1", event: { type: "tool/result", data: { text: "x".repeat(900_000) } } },
    });
    for (let index = 0; index < 19; index += 1) accumulated.child.stdout.write(event);
    await expect(accumulatedPending).rejects.toThrow(/事件超过有界保留限制/);
    expect(accumulated.child.killed).toBe(true);
  }, 10_000);

  it("累计整场 assistant usage 允许精确耗尽但拒绝真实超限", async () => {
    const { child, client: sdk } = client({ maxTokens: 100, maxCost: 1, maxModelCalls: 8 });
    const pending = sdk.request("initialize");
    child.stdout.write(frame(assistantEvent(20, 20)));
    expect(sdk.totalUsage()).toEqual({ tokens: 40, cost: 0.0001 });
    child.stdout.write(frame(assistantEvent(30, 30)));
    expect(sdk.totalUsage()).toEqual({ tokens: 100, cost: 0.00025 });
    child.stdout.write(frame(assistantEvent(1, 0)));

    await expect(pending).rejects.toThrow(/超过本次剩余预算/);
    expect(sdk.totalUsage().tokens).toBe(101);
    expect(sdk.totalUsage().cost).toBeCloseTo(0.000251);
    expect(child.killed).toBe(true);
  });

  it("usage 对账包含 cache-write token 且使用非零成本权重", () => {
    const { child, client: sdk } = client();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "assistant/chunk", data: { chunk: {
        type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 8,
          cacheWriteTokens: 6, totalTokens: 28 },
      } } },
    } }));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "assistant/chunk", data: { chunk: {
        type: "finish", reason: { kind: "stop" },
      } } },
    } }));

    expect(sdk.totalUsage()).toEqual({ tokens: 28, cost: 0.0000355 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it("可信活动可跨过 120 秒等价窗口，但独立总 deadline 仍会关闭", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const sdk = new SdkClient(child as never, "session-1", 1, undefined, undefined,
        { activityMs: 100, totalMs: 260 });
      const idle = sdk.waitForIdle();
      const outcome = idle.then(() => undefined, (error: unknown) => error);
      child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
        sessionId: "session-1", status: "running",
      } }));
      child.stdout.write(frame(turnStartEvent()));
      for (let elapsed = 0; elapsed < 240; elapsed += 80) {
        await vi.advanceTimersByTimeAsync(80);
        child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
          sessionId: "session-1", event: { type: "llm/retry", data: {} },
        } }));
      }
      await vi.advanceTimersByTimeAsync(21);
      await expect(outcome).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/总执行时限/) }));
      expect(child.killed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("未知事件不能刷新活动超时", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const sdk = new SdkClient(child as never, "session-1", 1, undefined, undefined,
        { activityMs: 100, totalMs: 1_000 });
      const idle = sdk.waitForIdle();
      const outcome = idle.then(() => undefined, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(80);
      child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
        sessionId: "session-1", event: { type: "future/noise", data: {} },
      } }));
      await vi.advanceTimersByTimeAsync(21);
      await expect(outcome).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/活动超时/) }));
      expect(child.killed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("拒绝与实验模型配置不一致的 request context", async () => {
    const child = new FakeChild();
    const sdk = new SdkClient(child as never, "session-1", 1, undefined, 2_500);
    const pending = sdk.request("initialize");
    child.stdout.write(frame({
      jsonrpc: "2.0", method: "session.event", params: {
        sessionId: "session-1",
        event: { type: "request/context", data: {
          provider: "deepseek-official", model: "deepseek-v4-flash", contextWindow: 1_000_000,
        } },
      },
    }));

    await expect(pending).rejects.toThrow(/contextWindow 未应用实验约束/);
    expect(child.killed).toBe(true);
  });

  it("官方重试成功的 completed 终态清除中间 Provider 错误", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "assistant/chunk", data: { chunk: {
        type: "finish", reason: { kind: "error", failure: {
          code: "RATE_LIMIT", message: "opaque-first-attempt",
        } },
      } } },
    } }));
    child.stdout.write(frame(assistantEvent(17, 3)));
    child.stdout.write(frame(turnEndEvent({ kind: "completed" })));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).resolves.toBeUndefined();
    expect(sdk.totalUsage()).toEqual({ tokens: 20, cost: 0.000029 });
    expect(sdk.totalModelCalls()).toBe(2);
  });

  it("只使用当前 prompt turn 的最后一条 assistant/message，最终空文本不得回退", async () => {
    const { child, client: sdk } = client();
    const firstIdle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent(1)));
    child.stdout.write(frame(assistantEvent(10, 2, JSON.stringify({
      hypothesis: "早期结果", strategyPlan: "不得回退", submitted: true,
    }))));
    child.stdout.write(frame(assistantEvent(11, 3, "")));
    child.stdout.write(frame(turnEndEvent({ kind: "completed" }, 1)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(firstIdle).resolves.toBeUndefined();
    expect(() => sdk.finalAssistantText()).toThrow(expect.objectContaining({
      name: "AdapterError", kind: "protocol", code: "RESULT_MISSING",
    }));
    expect(sdk.totalUsage()).toEqual({ tokens: 26, cost: 0.000041 });
    expect(sdk.totalModelCalls()).toBe(2);

    const secondIdle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent(2)));
    child.stdout.write(frame(assistantEvent(5, 1, JSON.stringify({
      hypothesis: "第二轮", strategyPlan: "独立边界", submitted: true,
    }))));
    child.stdout.write(frame(turnEndEvent({ kind: "completed" }, 2)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(secondIdle).resolves.toBeUndefined();
    expect(JSON.parse(sdk.finalAssistantText())).toMatchObject({ hypothesis: "第二轮" });
    expect(sdk.totalUsage()).toEqual({ tokens: 32, cost: 0.00005 });
    expect(sdk.totalModelCalls()).toBe(3);
  });

  it("只保留最终 turn/end 的稳定失败分类并丢弃原始敏感响应", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "assistant/chunk", data: { chunk: {
        type: "usage", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 13 },
      } } },
    } }));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "assistant/chunk", data: { chunk: {
        type: "finish", reason: { kind: "error", failure: {
          code: "RATE_LIMIT", message: "opaque-provider-response",
        } },
      } } },
    } }));
    child.stdout.write(frame(turnEndEvent({ kind: "error", error: {
        code: "SERVER", message: "opaque-final-provider-response", status: 503, requestId: "req-opaque-1",
    } })));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "transient-provider", code: "SERVER",
      message: "官方 DSH Provider 调用失败（SERVER）",
      facts: {
        status: 503,
        requestId: "req-opaque-1",
        messageFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    });
    await expect(idle).rejects.not.toThrow(/opaque-provider-response|opaque-final-provider-response/);
    expect(sdk.totalUsage()).toEqual({ tokens: 13, cost: 0.000019 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it("不同 UNKNOWN Provider message 保留不同的去敏指纹", async () => {
    const run = async (message: string) => {
      const { child, client: sdk } = client();
      const idle = sdk.waitForIdle();
      child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
        sessionId: "session-1", status: "running",
      } }));
      child.stdout.write(frame(turnStartEvent()));
      child.stdout.write(frame(turnEndEvent({ kind: "error", error: { code: "UNKNOWN", message } })));
      child.emit("exit", 17, null);
      const error = await idle.catch((value) => value) as AdapterError;
      return { child, error };
    };
    const first = await run("opaque-provider-response-a") as { child: FakeChild; error: AdapterError };
    const second = await run("opaque-provider-response-b") as { child: FakeChild; error: AdapterError };
    expect(first.error).toMatchObject({ kind: "provider", code: "UNKNOWN" });
    expect(second.error).toMatchObject({ kind: "provider", code: "UNKNOWN" });
    expect(first.error.facts?.messageFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first.error.facts?.messageFingerprint).not.toBe(second.error.facts?.messageFingerprint);
    expect(first.error.message).not.toContain("opaque-provider-response");
    expect(second.error.message).not.toContain("opaque-provider-response");
    first.child.stdin.destroy(); first.child.stdout.destroy(); first.child.stderr.destroy();
    second.child.stdin.destroy(); second.child.stdout.destroy(); second.child.stderr.destroy();
  });

  it("turn/end Provider 失败后立即退出仍保留 Provider 根因", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(turnEndEvent({ kind: "error", error: {
      code: "UNKNOWN", message: "opaque-race-provider", requestId: "race-1",
    } })));
    child.emit("exit", 17, null);

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "provider", code: "UNKNOWN", facts: { requestId: "race-1" },
    });
    expect(classifyFinalizedRuntimeFailure(await idle.catch((error) => error), { localFailure: { kind: "empty" } }))
      .toEqual({ kind: "provider", code: "UNKNOWN" });
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });

  it("进程先 exit、stdout 后排空 turn/end 时仍保留 Provider 根因", async () => {
    const { child, client: sdk } = client();
    const invocation = requestPromptAndWaitForIdle(sdk, "session-1", "Return one short response.");
    child.emit("exit", 17, null);
    setTimeout(() => {
      child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
        sessionId: "session-1", status: "running",
      } }));
      child.stdout.write(frame(turnStartEvent()));
      child.stdout.write(frame(turnEndEvent({ kind: "error", error: {
        code: "UNKNOWN", message: "late-provider-failure", requestId: "late-1",
      } })));
      child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
        sessionId: "session-1", status: "idle",
      } }));
    }, 20);

    await expect(invocation).rejects.toMatchObject({
      name: "AdapterError", kind: "provider", code: "UNKNOWN", facts: { requestId: "late-1" },
    });
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });

  it("真实 Node 子进程 exit 先到、恢复 stdout 后仍保留 Provider 根因", async () => {
    const frames = [
      { jsonrpc: "2.0", method: "session.status", params: { sessionId: "session-1", status: "running" } },
      turnStartEvent(),
      turnEndEvent({ kind: "error", error: {
        code: "UNKNOWN", message: "real-child-late-provider", requestId: "real-late-1",
      } }),
      { jsonrpc: "2.0", method: "session.status", params: { sessionId: "session-1", status: "idle" } },
    ];
    const child = spawn(process.execPath, ["-e", [
      `process.stdin.once("data", () => process.stdout.write(${JSON.stringify(frames.map((value) => JSON.stringify(value)).join("\n") + "\n")}, () => process.exit(17)));`,
    ].join("\n")], { stdio: ["pipe", "pipe", "pipe"] });
    const sdk = new SdkClient(child, "session-1", 1);
    child.stdout.pause();
    const invocation = requestPromptAndWaitForIdle(sdk, "session-1", "Return one short response.");
    await new Promise<void>((resolveWait) => child.once("exit", () => resolveWait()));
    setTimeout(() => child.stdout.resume(), 20);

    await expect(invocation).rejects.toMatchObject({
      name: "AdapterError", kind: "provider", code: "UNKNOWN", facts: { requestId: "real-late-1" },
    });
    expect(classifyFinalizedRuntimeFailure(await invocation.catch((error) => error), { localFailure: { kind: "empty" } }))
      .toEqual({ kind: "provider", code: "UNKNOWN" });
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });

  it("idle 先到、迟到 turn/end 仍等待并保留完整终态", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));
    setTimeout(() => child.stdout.write(frame(turnEndEvent({ kind: "completed" }))), 20);

    await expect(idle).resolves.toBeUndefined();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });

  it("JSON-RPC error.data 只保留白名单摘要与稳定指纹", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-jsonrpc-data-"));
    const child = spawn(process.execPath, ["-e", [
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  const request = JSON.parse(chunk.split('\\n').find(Boolean));",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'opaque', data: { code: 'RATE_LIMIT', status: 429, requestId: 'data-1', secret: 'must-not-leak' } } }) + '\\n');",
      "});",
    ].join("\n")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const sdk = new SdkClient(child, "session-1", 1);
    try {
      const request = sdk.request("initialize");
      const error = await request.catch((value) => value) as AdapterError;
      expect(error).toMatchObject({
        name: "AdapterError", code: "SDK_JSONRPC_ERROR", facts: {
          wireCode: -32001,
          dataType: "object",
          dataCode: "RATE_LIMIT",
          dataRequestId: "data-1",
          dataStatus: 429,
          dataFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      });
      expect(error.message).not.toContain("must-not-leak");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Provider 伪造本地门禁文案时仍保持 provider/UNKNOWN", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(turnEndEvent({ kind: "error", error: {
      code: "UNKNOWN", message: "Arena request input upper bound exceeds context capacity",
    } })));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "provider", code: "UNKNOWN",
    });
  });

  it.each([
    [{ kind: "aborted", reason: { kind: "user" } }, "process", "SDK_TURN_ABORTED"],
    [{ kind: "aborted", reason: { kind: "parent" } }, "process", "SDK_TURN_ABORTED"],
    [{ kind: "aborted", reason: { kind: "hook", reason: "cancelled by hook" } }, "process", "SDK_TURN_ABORTED"],
    [{ kind: "aborted", reason: { kind: "disposed" } }, "process", "SDK_TURN_ABORTED"],
    [{ kind: "aborted", reason: { kind: "legacy" } }, "process", "SDK_TURN_ABORTED"],
    [{ kind: "interrupted" }, "process", "SDK_TURN_INTERRUPTED"],
    [{ kind: "blocked" }, "protocol", "SDK_TURN_BLOCKED"],
    [{ kind: "max-tokens" }, "protocol", "SDK_TURN_MAX_TOKENS"],
    [{ kind: "future-terminal" }, "protocol", "SDK_TURN_INVALID_REASON"],
    [{}, "protocol", "SDK_TURN_INVALID_REASON"],
  ] as const)("非成功 turn/end %j 关闭失败并保留可信用量", async (reason, kind, code) => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(assistantEvent(11, 2)));
    child.stdout.write(frame(turnEndEvent(reason)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({ name: "AdapterError", kind, code });
    expect(sdk.totalUsage()).toEqual({ tokens: 13, cost: 0.000019 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it.each([undefined, "completed"])("畸形 turn/end reason %j 关闭失败", async (reason) => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(assistantEvent(5, 1)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "turn/end", data: reason === undefined ? { turn: 1 } : { turn: 1, reason } },
    } }));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "protocol", code: "SDK_TURN_INVALID_REASON",
    });
    expect(sdk.totalUsage()).toEqual({ tokens: 6, cost: 0.000009 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it.each([
    [{ reason: { kind: "completed" } }, "缺少 turn"],
    [{ turn: 1, reason: { kind: "completed" }, extra: true }, "data 含额外字段"],
    [{ turn: 1, reason: { kind: "completed", extra: true } }, "completed 含额外字段"],
    [{ turn: 1, reason: { kind: "error" } }, "error 缺少嵌套 failure"],
    [{ turn: 1, reason: { kind: "error", error: { code: "SERVER" } } }, "error 缺少 message"],
    [{ turn: 1, reason: { kind: "error", error: { code: "SERVER", message: "failure", extra: true } } }, "LlmFailure 含额外字段"],
    [{ turn: 1, reason: { kind: "error", error: { code: "SERVER", message: "failure", status: 99 } } }, "LlmFailure status 越界"],
    [{ turn: 1, reason: { kind: "aborted" } }, "aborted 缺少 reason"],
    [{ turn: 1, reason: { kind: "aborted", reason: { kind: "hook" } } }, "hook 缺少 reason"],
    [{ turn: 1, reason: { kind: "aborted", reason: { kind: "user", extra: true } } }, "取消原因含额外字段"],
    [{ turn: 0, reason: { kind: "completed" } }, "turn 不是正整数"],
    [{ turn: 1.5, reason: { kind: "completed" } }, "turn 不是安全整数"],
    [{ turn: Number.MAX_SAFE_INTEGER + 1, reason: { kind: "completed" } }, "turn 超过安全整数"],
    [{ turn: 2, reason: { kind: "completed" } }, "turn 与当前 prompt 不匹配"],
  ] as const)("严格拒绝畸形 turn/end %j：%s", async (data, _label) => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(assistantEvent(5, 1)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.event", params: {
      sessionId: "session-1", event: { type: "turn/end", data },
    } }));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "protocol", code: "SDK_TURN_INVALID_REASON",
    });
    expect(sdk.totalUsage()).toEqual({ tokens: 6, cost: 0.000009 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it.each([
    { kind: "error", error: { code: "SERVER", message: "opaque-first-terminal" } },
    { kind: "future-terminal" },
  ])("重复 turn/end 在首个终态为 $kind 后永久协议失败", async (firstReason) => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(turnEndEvent(firstReason)));
    child.stdout.write(frame(turnEndEvent({ kind: "completed" })));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "protocol", code: "SDK_TURN_END_DUPLICATE",
    });
    await expect(idle).rejects.not.toThrow(/opaque-first-terminal/);
  });

  it("进入 idle 前缺少 turn/end 时关闭失败并保留可信用量", async () => {
    const { child, client: sdk } = client();
    const idle = sdk.waitForIdle();
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "running",
    } }));
    child.stdout.write(frame(turnStartEvent()));
    child.stdout.write(frame(assistantEvent(5, 1)));
    child.stdout.write(frame({ jsonrpc: "2.0", method: "session.status", params: {
      sessionId: "session-1", status: "idle",
    } }));

    await expect(idle).rejects.toMatchObject({
      name: "AdapterError", kind: "protocol", code: "SDK_TURN_END_MISSING",
    });
    expect(sdk.totalUsage()).toEqual({ tokens: 6, cost: 0.000009 });
    expect(sdk.totalModelCalls()).toBe(1);
  });

  it("超过八次模型调用时拒绝继续父 Session", async () => {
    const { child, client: sdk } = client();
    const pending = sdk.request("initialize");
    for (let index = 0; index < 9; index += 1) child.stdout.write(frame(assistantEvent(1, 1)));

    await expect(pending).rejects.toThrow(/模型调用次数超过上限/);
    expect(child.killed).toBe(true);
  });
});

describe("官方 DSH 最终结果提取", () => {
  const result = { hypothesis: "修复假设", strategyPlan: "验证计划", submitted: true };

  it.each([
    JSON.stringify(result),
  ])("提取唯一完整 JSON 对象：%s", (text) => {
    expect(parseFinalJson(text)).toMatchObject(result);
  });

  it("拒绝多个合法 JSON 对象，避免猜测模型意图", () => {
    expect(() => parseFinalJson(`${JSON.stringify(result)}\n${JSON.stringify({ ...result, submitted: false })}`))
      .toThrow(expect.objectContaining({ code: "RESULT_JSON_INVALID" }));
  });

  it("最终 JSON 总量允许精确 8 KiB 并拒绝多一个 UTF-8 字节", () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const exact = `${prefix}${"x".repeat(8 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(8 * 1024);
    expect(parseFinalJson(exact)).toHaveProperty("value");
    expect(() => parseFinalJson(`${exact} `)).not.toThrow();
    expect(() => parseFinalJson(`${exact.slice(0, -2)}x"}`))
      .toThrow(expect.objectContaining({ code: "RESULT_TOO_LARGE" }));
  });

  it.each([
    ["hypothesis", 2 * 1024],
    ["strategyPlan", 4 * 1024],
    ["reasoning", 2 * 1024],
  ] as const)("%s 字段独立允许精确 UTF-8 上限并拒绝超限", (field, byteLimit) => {
    const base = { hypothesis: "h", strategyPlan: "p", submitted: true, reasoning: "r" };
    const exact = { ...base, [field]: "x".repeat(byteLimit) };
    expect(() => validateEvolutionResult(exact)).not.toThrow();
    expect(() => validateEvolutionResult({ ...exact, [field]: `${exact[field]}界` }))
      .toThrow(expect.objectContaining({ code: "RESULT_SCHEMA_INVALID" }));
  });

  it.each([
    ["", "RESULT_MISSING"],
    ["完成但没有 JSON", "RESULT_JSON_INVALID"],
    [`完成。\n${JSON.stringify(result)}`, "RESULT_JSON_INVALID"],
    [`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``, "RESULT_JSON_INVALID"],
    ['{"hypothesis":"未闭合"', "RESULT_JSON_INVALID"],
    [`[${JSON.stringify(result)}]`, "RESULT_JSON_INVALID"],
  ])("以稳定错误码拒绝无效结果", (text, code) => {
    expect(() => parseFinalJson(text)).toThrow(expect.objectContaining({ code }));
  });
});

describe("官方 DSH 有界进化 prompt", () => {
  it("smoke 先等待完整 prompt 终态再读取最终文本", async () => {
    const calls: string[] = [];
    let settled = false;
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        calls.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => { settled = true; },
      finalAssistantText: () => {
        if (!settled) throw new Error("final text read before idle");
        return "ready";
      },
    };

    await expect(requestSmokeResult(client, "session-1", "readiness prompt")).resolves.toBe("ready");
    expect(calls).toEqual(["readiness prompt"]);
  });

  it("严格结果无效但仍有调用预算时只重述一次裸 JSON", async () => {
    const prompts: string[] = [];
    const result = { hypothesis: "h", strategyPlan: "p", submitted: true };
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        prompts.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => undefined,
      finalAssistantText: () => prompts.length === 1 ? "说明文字" : JSON.stringify(result),
      totalModelCalls: () => prompts.length,
    };

    await expect(requestStrictEvolutionResult(client, "session-1", "原始 prompt", 2)).resolves.toEqual(result);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Return exactly one raw JSON object and nothing else");
  });

  it("模型返回 submitted=false 且仍有预算时要求真实源码编辑后再提交", async () => {
    const prompts: string[] = [];
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        prompts.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => undefined,
      finalAssistantText: () => prompts.length === 1
        ? JSON.stringify({ hypothesis: "暂不提交", strategyPlan: "只完成分析", submitted: false })
        : JSON.stringify({ hypothesis: "已完成最小编辑", strategyPlan: "编辑 src/index.ts 后提交", submitted: true }),
      totalModelCalls: () => prompts.length,
    };

    await expect(requestStrictEvolutionResult(client, "session-1", "原始 prompt", 2)).resolves.toMatchObject({
      submitted: true,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("make one small, behavior-preserving edit to src/index.ts");
  });

  it("submitted=false 且调用预算已耗尽时保留真实未提交结果", async () => {
    const prompts: string[] = [];
    const result = { hypothesis: "未提交", strategyPlan: "没有剩余调用", submitted: false };
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        prompts.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => undefined,
      finalAssistantText: () => JSON.stringify(result),
      totalModelCalls: () => prompts.length,
    };

    await expect(requestStrictEvolutionResult(client, "session-1", "原始 prompt", 1)).resolves.toEqual(result);
    expect(prompts).toHaveLength(1);
  });

  it("八次调用预算在工具预算耗尽后仍保留一次严格 JSON 修复回合", async () => {
    const prompts: string[] = [];
    const result = { hypothesis: "h", strategyPlan: "p", submitted: true };
    let modelCalls = 6;
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        modelCalls += 1;
        prompts.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => undefined,
      finalAssistantText: () => modelCalls === 7 ? "说明文字" : JSON.stringify(result),
      totalModelCalls: () => modelCalls,
    };

    await expect(requestStrictEvolutionResult(client, "session-1", "原始 prompt", 8)).resolves.toEqual(result);
    expect(modelCalls).toBe(8);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Return exactly one raw JSON object and nothing else");
  });

  it("调用预算耗尽时不绕过严格结果协议", async () => {
    const prompts: string[] = [];
    const client = {
      request: async (_method: string, params: { contentBlocks?: Array<{ text?: string }> }) => {
        prompts.push(params.contentBlocks?.[0]?.text ?? "");
        return {};
      },
      waitForIdle: async () => undefined,
      finalAssistantText: () => "说明文字",
      totalModelCalls: () => prompts.length,
    };

    await expect(requestStrictEvolutionResult(client, "session-1", "原始 prompt", 1))
      .rejects.toMatchObject({ code: "RESULT_JSON_INVALID" });
    expect(prompts).toHaveLength(1);
  });

  it("诊断摘要只保留总数与稳定 TypeScript 错误码计数", () => {
    const diagnostics = [
      "C:/Users/private/App Data/maze-sdk-abc/src/index.ts(1,2): error TS1000: provider message",
      String.raw`\\server\share\private\src\index.ts(3,4): error TS1001: secret`,
      "../../tmp/maze-candidate-build-abcdef/src/index.ts(5,6): error TS1000: nonce",
      String.raw`..\..\tmp\maze-dsh-123456\src\index.ts(7,8): error TS2322: hidden`,
      "Cannot find module '@scope/maze-sdk-client-ab12cd/runtime'. TS2307",
      "failure '/tmp/private/a\\'b/src/index.ts' with provider-secret",
      String.raw`failure "/tmp/private/a\"b/src/index.ts" with session-secret`,
      ["failure `", "/tmp/private/a", "\\", "`", "b/src/index.ts", "` with credential-secret"].join(""),
    ];
    const prompt = createEvolutionPrompt({ attempt: { diagnostics } }, 2);
    const data = JSON.parse(prompt.split("\n\n").at(-2)!) as {
      attempt: { diagnostics: { available: number; codes: Record<string, number> } };
    };

    expect(data.attempt.diagnostics).toEqual({
      available: diagnostics.length,
      codes: { TS1000: 2, TS1001: 1, TS2322: 1 },
    });
    expect(data.attempt.diagnostics).not.toHaveProperty("values");
    for (const secret of [
      "C:/Users", "App Data", "\\\\server", "../../tmp", "..\\..\\tmp",
      "maze-candidate-build-abcdef", "maze-dsh-123456", "@scope/maze-sdk-client-ab12cd/runtime",
      "/tmp/private", "provider message", "provider-secret", "session-secret", "credential-secret",
    ]) expect(prompt).not.toContain(secret);
  });

  it("稳定错误码种类有界且不接受任意相似文本", () => {
    const codes = Array.from({ length: 20 }, (_, index) => `TS${1000 + index}`);
    const diagnostics = [
      codes.map((code) => `error ${code}: compiler diagnostic`).join("\n"),
      "TS1234567 ts1000 XTS1000 TS-1000 PROVIDER_FAILURE credential-secret",
    ];
    const prompt = createEvolutionPrompt({ attempt: { diagnostics } }, 2);
    const data = JSON.parse(prompt.split("\n\n").at(-2)!) as {
      attempt: { diagnostics: { available: number; codes: Record<string, number> } };
    };

    expect(data.attempt.diagnostics.available).toBe(2);
    expect(Object.keys(data.attempt.diagnostics.codes)).toEqual(codes.slice(0, 16));
    expect(prompt).not.toMatch(/TS1234567|ts1000|XTS1000|TS-1000|PROVIDER_FAILURE|credential-secret/u);
  });

  it("明确由 Arena 统一写入唯一策略记录，避免模型在修复回合预写冲突文件", () => {
    const prompt = createEvolutionPrompt({}, 3);
    expect(prompt).toContain("Do not create, edit, or delete any lineage files");
    expect(prompt).toContain("the JSON strategyPlan is the sole canonical strategy record");
  });

  it("只聚合标准 TypeScript error 行并拒绝正文、秘密和非规范错误码", () => {
    const diagnostics = [
      "src/index.ts(1,2): error TS2307: Cannot find module 'safe-module'\r\nlib/value.ts(3,4): error TS2307: duplicate count",
      "/workspace/private source/main.tsx(5,6): error TS2345: POSIX path",
      String.raw`C:\Users\private\project\main.mts(7,8): error TS2353: Windows path`,
      String.raw`\\server\share\private project\main.cts(9,10): error TS2367: UNC path`,
      "../relative project/source.mjs(11,12): error TS2552: relative path",
      "./src/config.json(13,14): error TS2732: JSON source",
      "error TS2322: Type mismatch",
      "tsc: error TS7006: Parameter implicitly has an any type",
      "tsc.js: error TS6133: Value is never read",
      "typescript: error TS18003: No inputs were found",
      "正文内容(1,2): error TS123456: forged prose location",
      "package-name(3,4): error TS999999: forged package location",
      "src/index.TS(5,6): error TS654320: unsupported uppercase extension",
      "provider-TS654321 failed",
      "credential TS123456 secret",
      "凭据TS123456秘密",
      "正文 error TS654321: 不是标准诊断行",
      "error TS000001: leading zero",
      "error TS0: zero",
      "error TS1234567: too many digits",
      "error TS2307秘密: unicode suffix",
      "error ＴＳ2307: full-width letters",
    ];
    const prompt = createEvolutionPrompt({ attempt: { diagnostics } }, 2);
    const data = JSON.parse(prompt.split("\n\n").at(-2) ?? "{}") as {
      attempt: { diagnostics: { available: number; codes: Record<string, number> } };
    };

    expect(data.attempt.diagnostics).toEqual({
      available: diagnostics.length,
      codes: {
        TS18003: 1, TS2307: 2, TS2322: 1, TS2345: 1, TS2353: 1,
        TS2367: 1, TS2552: 1, TS2732: 1, TS6133: 1, TS7006: 1,
      },
    });
    expect(prompt).not.toMatch(/TS654321|TS654320|TS123456|TS999999|TS000001|TS1234567|ＴＳ2307/u);
  });

  it("近线性处理含十万组引号与大量路径的接近 1 MiB 诊断", () => {
    const quoteGroups = ["''", '\"\"', "``"].join("").repeat(100_000);
    const pathNoise = String.raw` C:\Users\private \\server\share ../../tmp maze-sdk-abcdef/src/index.ts `.repeat(4_500);
    const diagnostic = quoteGroups + pathNoise + "\nerror TS9999: bounded diagnostic";
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeGreaterThan(900 * 1024);
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThan(1024 * 1024);
    const started = Date.now();
    const prompt = createEvolutionPrompt({ attempt: { diagnostics: [diagnostic] } }, 2);
    const data = JSON.parse(prompt.split("\n\n").at(-2)!) as {
      attempt: { diagnostics: { available: number; codes: Record<string, number> } };
    };

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(data.attempt.diagnostics).toEqual({ available: 1, codes: { TS9999: 1 } });
    expect(prompt).not.toMatch(/Users|private|server|share|\.\.\/tmp|maze-sdk-abcdef/u);
    expect(Buffer.byteLength(prompt.split("\n\n").at(-2)!, "utf8")).toBeLessThanOrEqual(8 * 1024);
  }, 3_000);

  it("只发送任务所需摘要并明确八次调用内的直接工具路径", () => {
    const metrics = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
      `metric${index}${"x".repeat(55 - String(index).length)}`, index,
    ]));
    const request = {
      type: "maze-arena.harness-evolution.request",
      protocolVersion: 1,
      session: {
        id: "session-secret-id",
        home: "/private/session/home",
        workspace: "/private/workspace",
        role: "generator",
        roleConstraint: "只修改生成器",
        allowedTools: ["read", "edit", "search", "shell", "test", "public-check", "submit"],
      },
      attempt: {
        experimentId: "exp-1",
        generation: 9,
        attemptId: "g0009-generator",
        repairAttempt: 1,
        diagnostics: Array.from({ length: 12 }, (_, index) => index === 8
          ? `/tmp/maze-sdk-real-overlay-r4nd0m/src/index.ts(8,1): error TS1000: absolute host path`
          : index === 9
            ? String.raw`C:\tmp\maze-dsh-session-r4nd0m\src\index.ts(9,2): error TS1001: windows host path`
            : index === 10
              ? `maze-candidate-build-relative-r4nd0m/src/index.ts(10,3): error TS1002: random session path`
              : index === 11
                ? `../../../../../../tmp/maze-candidate-build-a1b2c3/src/index.ts(17,9): error TS2322: ${"\\\"\u0000\n".repeat(400)}Type mismatch`
                : `${index}: ${"\\\"\u0000\n".repeat(400)}`),
      },
      modelProfile: {
        providerId: "provider-must-not-enter-prompt",
        modelId: "model-must-not-enter-prompt",
        credentialRef: "dsh-credential://SECRET_NAME_MUST_NOT_ENTER_PROMPT",
        providerLabel: "provider label",
        modelLabel: "model label",
        contextTokens: 2_500,
        outputTokens: 500,
        totalTokenLimit: 3_000,
      },
      budget: { maxTokens: 24_000, maxCost: 1, maxModelCalls: 8 },
      input: {
        role: "generator",
        championRoot: "/private/workspace",
        lineagePlans: Array.from({ length: 16 }, (_, index) => ({
          attemptId: `g${String(index + 1).padStart(4, "0")}-generator`,
          strategyPlan: `${"\\\"\u0000\n".repeat(1_000)} ${index}`,
        })),
        trustedResults: Array.from({ length: 64 }, (_, index) => ({
          attemptId: `g${String(index + 1).padStart(4, "0")}-generator`,
          generation: index + 1,
          role: "generator",
          outcome: index === 63 ? "failed" : "tie",
          publicCaseCount: 8,
          hiddenCaseCount: 24,
          totalCandidateAggregate: { ...metrics, gateFailures: index + 1 },
          hiddenCandidateAggregate: { ...metrics, failedCases: index + 1 },
        })),
        publicTraces: Array.from({ length: 16 }, (_, index) => ({
          attemptId: `g${String(index + 49).padStart(4, "0")}-generator`,
          generation: index + 49,
          traceId: `trace-${index}-${"x".repeat(110)}`,
          outcome: index === 15 ? "failure" : "tie",
          metrics: { ...metrics, illegalActions: index + 1 },
          events: Array.from({ length: 128 }, () => ({
            type: "solver.decision", position: { x: 1, y: 2 }, openDirections: ["north"],
            remainingSteps: 3, direction: "north", kind: "backtrack",
          })),
        })),
        hiddenAggregate: {
          completedAttemptCount: 64,
          metricAvailableAttemptCount: 64,
          metricUnavailableAttemptCount: 0,
          promotedAttemptCount: 0,
          failedAttemptCount: 1,
          tieAttemptCount: 63,
          evaluatedHiddenCaseCount: 1_536,
          metricTotals: { ...metrics, failedCases: 24 },
        },
      },
    };

    const prompt = createEvolutionPrompt(request, 8);
    const encodedData = prompt.split("\n\n").at(-2)!;

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(10 * 1024);
    expect(Buffer.byteLength(encodedData, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(prompt).toContain("at most 8 total model calls");
    expect(prompt).toContain("at most 7 tool calls");
    expect(prompt).toContain("independent generation budget");
    expect(prompt).toContain("parent Arena ledger enforces that cumulative limit across repair Sessions");
    expect(prompt).toContain("must make at least one concrete edit to the current plugin source");
    expect(prompt).toContain("primary source file is exactly src/index.ts");
    expect(prompt).toContain("first assistant action must be exactly read(file_path=src/index.ts)");
    expect(prompt).toContain("second assistant action must be exactly edit(file_path=src/index.ts, old_string, new_string)");
    expect(prompt).toContain("broad exploration that exhausts the tool budget before editing is a failed attempt");
    expect(prompt).toContain("current plugin's primary source file is exactly src/index.ts");
    expect(prompt).toContain("edit(file_path=src/index.ts, old_string, new_string)");
    expect(prompt).toContain("bash(command, description)");
    expect(prompt).toContain("Set submitted=true only after the plugin source was actually edited");
    expect(prompt).toContain('"gateFailures":64');
    expect(prompt).toContain('"failedCases":24');
    expect(prompt).toContain('"solver.decision:backtrack:north":128');
    expect(prompt).toContain('"diagnostics":{"available":12,"codes":{"TS1000":1,"TS1001":1,"TS1002":1,"TS2322":1}}');
    expect(prompt).not.toMatch(/Type mismatch|absolute host path|windows host path|random session path|<path>/u);
    expect(prompt).not.toMatch(/private\/workspace|session-secret-id|credentialRef|provider-must-not-enter-prompt|exp-1|g0009-generator/);
    expect(prompt).not.toMatch(/\.\.\/|\/tmp\/maze-|a1b2c3|r4nd0m|C:\\\\tmp|\\u0000|\\n/);
    expect(encodedData).not.toContain("\\\\\\\"".repeat(100));
  });

  it("拒绝无效或超过冻结上界的模型调用预算", () => {
    expect(() => createEvolutionPrompt({}, 0)).toThrow(/有效模型调用上限/);
    expect(() => createEvolutionPrompt({}, 9)).toThrow(/有效模型调用上限/);
    expect(createEvolutionPrompt({}, 2)).toContain("at most 7 tool calls");
  });
});

describe("官方 DSH SDK 版本锁定 patch", () => {
  const realRuntimeRoot = process.env.MAZE_REAL_DSH_RUNTIME_ROOT;
  const realDshTest = realRuntimeRoot ? it : it.skip;

  it("在官方 agent-loop 三个前置边界保留受控本地失败码", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-stage-boundary-"));
    chmodSync(root, 0o700);
    const runtimeRoot = join(root, "runtime");
    const assemblerRoot = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh-llm", "lib");
    mkdirSync(assemblerRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(assemblerRoot, "index.js"), [
      'export class LlmError extends Error { constructor(message, code) { super(message); this.name = "LlmError"; this.code = code; } }',
      'export class BlockAssembler {}',
    ].join("\n"));
    const settingsPath = join(root, "immutable-settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{
        id: "deepseek-v4-flash", name: "Flash", contextWindow: 100_000, maxTokens: 8_000,
      }] },
    }));
    const previous = {
      home: process.env.DSH_HOME,
      settingsPath: process.env.DSH_MODEL_SETTINGS_PATH,
      runtimeRoot: process.env.DSH_HARNESS_RUNTIME_ROOT,
      failureFd: process.env.DSH_LOCAL_FAILURE_FD,
    };
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    process.env.DSH_HARNESS_RUNTIME_ROOT = runtimeRoot;
    delete process.env.DSH_LOCAL_FAILURE_FD;
    try {
      const files = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 10_000, outputTokens: 1_000, totalTokenLimit: 11_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-stage-boundary", 1);
      const { LlmError } = await import(pathToFileURL(join(assemblerRoot, "index.js")).href);
      const RuntimeLlmError = LlmError as unknown as new (message: string, code: string) => Error & { code: string };
      const module = await import(`${files.budgetPluginPath}?stage-boundary=${Date.now()}`) as {
        apply(ctx: Record<string, unknown>, config: Record<string, unknown>): void;
      };
      let assembleMode: "ok" | "error" | "arena" = "error";
      let prepareMode: "ok" | "error" | "no-adapter" | "arena" = "error";
      const listeners = new Map<string, (...args: unknown[]) => unknown>();
      const listenerOptions = new Map<string, Record<string, unknown> | undefined>();
      const targetAgent = { id: "session-stage-boundary" };
      const systemPrompt = {
        assemble: async (_context: Record<string, unknown>) => {
          if (assembleMode === "arena") throw new RuntimeLlmError("existing", "ARENA_EXISTING_FAILURE");
          if (assembleMode === "error") throw new Error("assembly boom");
          return { sections: [], contexts: [], tools: [], variables: {} };
        },
      };
      const llm = {
        prepareCall: async (..._args: unknown[]) => {
          if (prepareMode === "arena") throw new RuntimeLlmError("existing", "ARENA_EXISTING_FAILURE");
          if (prepareMode === "no-adapter") throw new RuntimeLlmError("no adapter", "NO_ADAPTER");
          if (prepareMode === "error") throw new Error("prepare boom");
          return { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
        },
      };
      const context = {
        llm,
        systemPrompt,
        on(name: string, listener: (...args: unknown[]) => unknown, options?: Record<string, unknown>) {
          listeners.set(name, listener);
          listenerOptions.set(name, options);
          return () => undefined;
        },
      };
      module.apply(context, {
        sessionId: "session-stage-boundary", provider: "deepseek-official", model: "deepseek-v4-flash",
        maxModelCalls: 1, maxToolCalls: 0, maxTokens: 100_000, maxCost: 1,
        contextTokens: 10_000, maxOutputTokens: 1_000, costMultiplier: 1, maxStreamBytes: 1_000_000,
        attemptsPath: files.attemptsPath,
      });
      expect(listenerOptions.get("agent/pre-step")).toMatchObject({ prepend: true });

      await expect(systemPrompt.assemble({ agent: targetAgent })).rejects.toMatchObject({ code: "ARENA_SYSTEM_PROMPT_ASSEMBLE_FAILED" });
      assembleMode = "arena";
      await expect(systemPrompt.assemble({ agent: targetAgent })).rejects.toMatchObject({ code: "ARENA_EXISTING_FAILURE" });

      const preStep = listeners.get("agent/pre-step")!;
      await expect(preStep({ agent: targetAgent }, async () => { throw new Error("pre-step boom"); })).rejects
        .toMatchObject({ code: "ARENA_AGENT_PRE_STEP_FAILED" });

      await expect(llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" })).rejects
        .toMatchObject({ code: "ARENA_LLM_PREPARE_CALL_FAILED" });
      prepareMode = "no-adapter";
      await expect(llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" })).rejects
        .toMatchObject({ code: "NO_ADAPTER" });
      prepareMode = "arena";
      await expect(llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" })).rejects
        .toMatchObject({ code: "ARENA_EXISTING_FAILURE" });
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      if (previous.runtimeRoot === undefined) delete process.env.DSH_HARNESS_RUNTIME_ROOT;
      else process.env.DSH_HARNESS_RUNTIME_ROOT = previous.runtimeRoot;
      if (previous.failureFd === undefined) delete process.env.DSH_LOCAL_FAILURE_FD;
      else process.env.DSH_LOCAL_FAILURE_FD = previous.failureFd;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("模型预算与工具预算独立且保留 agent-pre-step 到工具执行的事件顺序", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-budget-order-"));
    chmodSync(root, 0o700);
    const runtimeRoot = join(root, "runtime");
    const assemblerRoot = join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh-llm", "lib");
    mkdirSync(assemblerRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(assemblerRoot, "index.js"), [
      "export class LlmError extends Error { constructor(message, code) { super(message); this.name = 'LlmError'; this.code = code; } }",
      "export class BlockAssembler { constructor() { this.items = []; } push(chunk) { if (chunk?.type === 'block-end') this.items.push(chunk.block); } blocks() { return this.items; } }",
      "",
    ].join("\n"));
    const settingsPath = join(root, "immutable-settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": { models: [{ id: "deepseek-v4-flash", contextWindow: 10_000, maxTokens: 1_000 }] },
    }));
    const previous = {
      home: process.env.DSH_HOME,
      settingsPath: process.env.DSH_MODEL_SETTINGS_PATH,
      runtimeRoot: process.env.DSH_HARNESS_RUNTIME_ROOT,
      budgetFd: process.env.DSH_BUDGET_LEDGER_FD,
      failureFd: process.env.DSH_LOCAL_FAILURE_FD,
    };
    Object.assign(process.env, {
      DSH_HOME: root,
      DSH_MODEL_SETTINGS_PATH: settingsPath,
      DSH_HARNESS_RUNTIME_ROOT: runtimeRoot,
    });
    delete process.env.DSH_BUDGET_LEDGER_FD;
    delete process.env.DSH_LOCAL_FAILURE_FD;
    try {
      const files = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 2_500, outputTokens: 500, totalTokenLimit: 3_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-budget-order", 2);
      const module = await import(`${files.budgetPluginPath}?budget-order=${Date.now()}`) as {
        apply(ctx: Record<string, unknown>, config: Record<string, unknown>): void;
      };
      const listeners = new Map<string, (...args: unknown[]) => unknown>();
      const context = {
        on(name: string, listener: (...args: unknown[]) => unknown) {
          listeners.set(name, listener);
        },
      };
      module.apply(context, {
        sessionId: "session-budget-order", provider: "deepseek-official", model: "deepseek-v4-flash",
        maxModelCalls: 2, maxToolCalls: 7, maxTokens: 20_000, maxCost: 1,
        contextTokens: 10_000, maxOutputTokens: 500, costMultiplier: 1, maxStreamBytes: 1_000_000,
        attemptsPath: files.attemptsPath,
      });
      const order: string[] = [];
      const targetAgent = { id: "session-budget-order" };
      const preStep = listeners.get("agent/pre-step")!;
      await preStep({ agent: targetAgent }, async () => {
        order.push("agent/pre-step");
        return undefined;
      });
      expect(readFileSync(files.attemptsPath, "utf8").trim()).toBe("0");

      const stream = listeners.get("llm/stream")!({
        sessionId: "session-budget-order", provider: "deepseek-official", model: "deepseek-v4-flash",
        messages: [], maxTokens: 500,
      }, () => {
        order.push("llm/stream");
        return (async function* () {
          yield { type: "block-end", index: 0, block: { type: "text", text: "ready" } };
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
            cacheWriteTokens: 0, totalTokens: 15 } };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      });
      await expect(collect(stream as AsyncIterable<unknown>)).resolves.toHaveLength(3);
      expect(readFileSync(files.attemptsPath, "utf8").trim()).toBe("1");

      const preExecute = listeners.get("tools/pre-execute")!;
      await expect(preExecute({ agent: targetAgent }, async () => {
        order.push("tools/pre-execute");
        return { kind: "allow" };
      })).resolves.toEqual({ kind: "allow" });
      expect(order).toEqual(["agent/pre-step", "llm/stream", "tools/pre-execute"]);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      if (previous.runtimeRoot === undefined) delete process.env.DSH_HARNESS_RUNTIME_ROOT;
      else process.env.DSH_HARNESS_RUNTIME_ROOT = previous.runtimeRoot;
      if (previous.budgetFd === undefined) delete process.env.DSH_BUDGET_LEDGER_FD;
      else process.env.DSH_BUDGET_LEDGER_FD = previous.budgetFd;
      if (previous.failureFd === undefined) delete process.env.DSH_LOCAL_FAILURE_FD;
      else process.env.DSH_LOCAL_FAILURE_FD = previous.failureFd;
      rmSync(root, { recursive: true, force: true });
    }
  });

  realDshTest("派生 Session 私有模型设置并在预算不足时阻止下一次 provider 调用", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-session-settings-"));
    const settingsPath = join(root, "immutable-settings.json");
    const previous = { home: process.env.DSH_HOME, settingsPath: process.env.DSH_MODEL_SETTINGS_PATH };
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-v4-flash", name: "Flash", contextWindow: 1_000_000, maxTokens: 256_000 }],
      },
    }));
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    try {
      const files = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 2_500, outputTokens: 500, totalTokenLimit: 3_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-1", 2);
      const sessionModel = JSON.parse(readFileSync(files.settingsPath, "utf8"))["llm-deepseek"].models[0];
      expect(sessionModel).toMatchObject({ contextWindow: 2_500, maxTokens: 500 });
      expect(statSync(files.settingsPath).mode & 0o777).toBe(0o600);
      expect(statSync(files.budgetPluginPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))["llm-deepseek"].models[0])
        .toMatchObject({ contextWindow: 1_000_000, maxTokens: 256_000 });

      const listeners = new Map<string, (...args: unknown[]) => unknown>();
      const module = await import(`${files.budgetPluginPath}?test=${Date.now()}`);
      module.apply({
        sessions: { get: () => ({}) },
        tokenMeter: { measure: () => ({ surfaceTokens: 100 }) },
        on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); },
      }, {
        sessionId: "session-1", provider: "deepseek-official", model: "deepseek-v4-flash",
        maxModelCalls: 2, maxToolCalls: 5, maxTokens: 20_000, maxCost: 1,
        contextTokens: 10_000, maxOutputTokens: 500, costMultiplier: 1, maxStreamBytes: 1_000_000,
        attemptsPath: files.attemptsPath,
      });
      let providerCalls = 0;
      const runModelStep = async (sessionId = "session-1") => collect(listeners.get("llm/stream")!({
        sessionId, provider: "deepseek-official", model: "deepseek-v4-flash",
        messages: [], maxTokens: 500,
      }, () => (async function* () {
        providerCalls += 1;
        yield { type: "block-end", index: 0, block: { type: "text", text: "assistant-tool-call" } };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
          cacheWriteTokens: 0, totalTokens: 15 } };
        yield { type: "finish", reason: { kind: "stop" } };
      })()) as AsyncIterable<unknown>);

      // 模拟两轮“模型请求 -> 工具执行 -> 下一轮模型请求”，预算只在 Provider 边界消费。
      expect(await runModelStep()).toHaveLength(3);
      const toolResults = ["tool-result-1"];
      expect(await runModelStep()).toHaveLength(3);
      toolResults.push("tool-result-2");
      expect(toolResults).toHaveLength(2);
      await expect(runModelStep()).rejects.toThrow(/budget exhausted/);
      expect(providerCalls).toBe(2);

      // 同进程中的 smoke/其他 Session 不应消耗目标演化 Session 的私有预算。
      expect(await runModelStep("smoke-session")).toHaveLength(3);
      expect(providerCalls).toBe(3);

      const preExecute = listeners.get("tools/pre-execute")!;
      const target = { agent: { id: "session-1" } };
      const allow = async () => ({ kind: "allow" });
      let actualExecutions = 0;
      const runTool = async (exec: Record<string, unknown>, next = allow) => {
        const decision = await preExecute(exec, next) as { kind: string; reason?: string };
        if (decision.kind === "allow") actualExecutions += 1;
        return decision;
      };
      await expect(runTool(target, async () => ({ kind: "deny", reason: "another policy" })))
        .resolves.toEqual({ kind: "deny", reason: "another policy" });
      for (let index = 0; index < 5; index += 1) {
        await expect(runTool({ ...target, callId: `call-${index}` })).resolves.toEqual({ kind: "allow" });
      }
      await expect(runTool({ ...target, callId: "call-5" })).resolves.toEqual(expect.objectContaining({
        kind: "deny", reason: expect.stringContaining("tool-call budget exhausted"),
      }));
      expect(actualExecutions).toBe(5);
      await expect(runTool({ agent: { id: "another-session" }, callId: "other" })).resolves.toEqual({ kind: "allow" });
      await expect(runTool({ ...target, callId: "nested", parent: Symbol("nested") })).resolves.toEqual({ kind: "allow" });
      expect(actualExecutions).toBe(7);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  realDshTest("max-tokens 工具旁路与冻结 BlockAssembler 的 first-close 语义一致", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-first-close-"));
    chmodSync(root, 0o700);
    const settingsPath = join(root, "immutable-settings.json");
    const previous = { home: process.env.DSH_HOME, settingsPath: process.env.DSH_MODEL_SETTINGS_PATH };
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{
        id: "deepseek-v4-flash", name: "Flash", contextWindow: 1_000_000, maxTokens: 256_000,
      }] },
    }));
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    try {
      const files = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 10_000, outputTokens: 1_000, totalTokenLimit: 11_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-first-close", 1);
      const listeners = new Map<string, (...args: unknown[]) => unknown>();
      const module = await import(`${files.budgetPluginPath}?first-close=${Date.now()}`);
      module.apply({
        sessions: { get: () => ({}) },
        tokenMeter: { measure: () => ({ surfaceTokens: 100 }) },
        on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); },
      }, {
        sessionId: "session-first-close", provider: "deepseek-official", model: "deepseek-v4-flash",
        maxModelCalls: 1, maxToolCalls: 0, maxTokens: 20_000, maxCost: 1,
        contextTokens: 10_000, maxOutputTokens: 1_000, costMultiplier: 1, maxStreamBytes: 1_000_000,
        attemptsPath: files.attemptsPath,
      });
      const output = await collect(listeners.get("llm/stream")!({
        sessionId: "session-first-close", provider: "deepseek-official", model: "deepseek-v4-flash",
        messages: [], maxTokens: 1_000,
      }, () => (async function* () {
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "tool-call-delta", index: 0, id: "call-first", name: "read", argumentsDelta: '{"file_path":"x"}' };
        yield { type: "block-end", index: 0, block: {
          type: "tool-call", id: "call-first", name: "read", arguments: '{"file_path":"x"}',
        } };
        yield { type: "tool-call-delta", index: 0, id: "ignored", name: "bash", argumentsDelta: "not-json" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "ignored re-close" } };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
          cacheWriteTokens: 0, totalTokens: 15 } };
        yield { type: "finish", reason: { kind: "max-tokens" } };
      })()) as AsyncIterable<Record<string, unknown>>);
      expect(output.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  realDshTest("Provider 分片与 BlockAssembler 普通异常不会落成 UNKNOWN", async () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-stream-boundary-"));
    chmodSync(root, 0o700);
    const settingsPath = join(root, "immutable-settings.json");
    const previous = { home: process.env.DSH_HOME, settingsPath: process.env.DSH_MODEL_SETTINGS_PATH };
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{
        id: "deepseek-v4-flash", name: "Flash", contextWindow: 1_000_000, maxTokens: 256_000,
      }] },
    }));
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    try {
      const files = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 10_000, outputTokens: 1_000, totalTokenLimit: 11_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-stream-boundary", 4);
      const listeners = new Map<string, (...args: unknown[]) => unknown>();
      const module = await import(`${files.budgetPluginPath}?stream-boundary=${Date.now()}`);
      module.apply({
        sessions: { get: () => ({}) },
        tokenMeter: { measure: () => ({ surfaceTokens: 100 }) },
        on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); },
      }, {
        sessionId: "session-stream-boundary", provider: "deepseek-official", model: "deepseek-v4-flash",
        maxModelCalls: 4, maxToolCalls: 0, maxTokens: 100_000, maxCost: 1,
        contextTokens: 10_000, maxOutputTokens: 1_000, costMultiplier: 1, maxStreamBytes: 1_000_000,
        attemptsPath: files.attemptsPath,
      });
      const invoke = (chunks: unknown[]) => collect(listeners.get("llm/stream")!({
        sessionId: "session-stream-boundary", provider: "deepseek-official", model: "deepseek-v4-flash",
        messages: [], maxTokens: 1_000,
      }, () => (async function* () {
        for (const chunk of chunks) yield chunk;
      })()) as AsyncIterable<unknown>);

      for (const chunks of [
        [{ type: "provider-extension" }],
        [{ type: "block-start", index: 0, blockType: "provider-extension" },
          { type: "finish", reason: { kind: "max-tokens" } }],
        [undefined],
        [{ type: "block-end", index: 0, block: null },
          { type: "finish", reason: { kind: "stop" } }],
      ]) {
        await expect(invoke(chunks)).rejects.toMatchObject({
          name: "LlmError", code: "ARENA_PROVIDER_STREAM_INVALID",
        });
      }
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝在非私有 home 中落盘 Session 运行文件", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-public-home-"));
    const settingsPath = join(root, "immutable-settings.json");
    const previous = { home: process.env.DSH_HOME, settingsPath: process.env.DSH_MODEL_SETTINGS_PATH };
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [{ id: "deepseek-v4-flash", contextWindow: 10_000, maxTokens: 1_000 }],
      },
    }));
    chmodSync(root, 0o755);
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    try {
      expect(() => createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 2_500, outputTokens: 500, totalTokenLimit: 3_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-1", 1)).toThrow(/0700 home/);
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("仅接受闭合凭据名并拒绝非法别名与保留运行命名空间", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-credential-"));
    const exportPath = join(root, "model-export.json");
    const base = {
      schemaVersion: 1,
      harnessVersion: "0.1.2-rc.1",
      providers: [{ id: "deepseek-official", label: "DeepSeek", models: [{
        id: "deepseek-v4-flash", label: "Flash", capabilities: {
          reasoningEfforts: ["off", "low", "high", "max"], maxContextTokens: 1_000_000,
          maxOutputTokens: 256_000, maxTotalTokens: 1_256_000, providerOptions: {},
        },
      }] }],
    };
    const previous = process.env.DSH_MODEL_EXPORT_PATH;
    const previousTools = process.env.DSH_HARNESS_ALLOWED_TOOLS;
    const previousSettings = process.env.DSH_MODEL_SETTINGS_PATH;
    process.env.DSH_MODEL_EXPORT_PATH = exportPath;
    process.env.DSH_MODEL_SETTINGS_PATH = exportPath;
    process.env.DSH_HARNESS_ALLOWED_TOOLS = "read,edit,search,shell,test,public-check,submit";
    try {
      writeFileSync(exportPath, JSON.stringify({ ...base,
        credentialRefs: ["dsh-credential://DEEPSEEK_API_KEY"],
        runtimeProviders: [{ id: "deepseek-official", adapter: "deepseek",
          credentialRef: "dsh-credential://DEEPSEEK_API_KEY", models: ["deepseek-v4-flash"],
          costMultipliers: { "deepseek-v4-flash": 1 } }],
      }));
      expect(() => createRuntimePatch("0.1.2-rc.1", {
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"])).toThrow(/FD 4/);

      writeFileSync(exportPath, JSON.stringify({ ...base,
        credentialRefs: ["dsh-credential://vendor-a"],
        runtimeProviders: [{ id: "deepseek-official", adapter: "deepseek",
          credentialRef: "dsh-credential://vendor-a", models: ["deepseek-v4-flash"],
          costMultipliers: { "deepseek-v4-flash": 1 } }],
      }));
      expect(() => createRuntimePatch("0.1.2-rc.1", {
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://vendor-a",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"])).toThrow(/POSIX/);

      for (const name of [
        "OPENSSL_MODULES", "UV_THREADPOOL_SIZE", "NPM_TOKEN", "YARN_ENABLE_SCRIPTS", "CURL_CA_BUNDLE",
        "REQUESTS_CA_BUNDLE",
      ]) {
        writeFileSync(exportPath, JSON.stringify({ ...base,
          credentialRefs: [`dsh-credential://${name}`],
          runtimeProviders: [{ id: "deepseek-official", adapter: "deepseek",
            credentialRef: `dsh-credential://${name}`, models: ["deepseek-v4-flash"],
            costMultipliers: { "deepseek-v4-flash": 1 } }],
        }));
        expect(() => createRuntimePatch("0.1.2-rc.1", {
          providerId: "deepseek-official", modelId: "deepseek-v4-flash",
          credentialRef: `dsh-credential://${name}`,
        }, ["read", "edit", "search", "shell", "test", "public-check", "submit"])).toThrow();
      }
    } finally {
      if (previous === undefined) delete process.env.DSH_MODEL_EXPORT_PATH;
      else process.env.DSH_MODEL_EXPORT_PATH = previous;
      if (previousTools === undefined) delete process.env.DSH_HARNESS_ALLOWED_TOOLS;
      else process.env.DSH_HARNESS_ALLOWED_TOOLS = previousTools;
      if (previousSettings === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previousSettings;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("把自定义 provider、model 与 endpoint 写入 pi-ai，并精确移除非 Arena 工具", () => {
    const root = mkdtempSync(join(tmpdir(), "maze-sdk-patch-"));
    const exportPath = join(root, "model-export.json");
    const settingsPath = join(root, "settings.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "0.1.2-rc.1",
      credentialRefs: ["dsh-credential://CUSTOM_API_KEY"],
      providers: [{
        id: "custom-provider",
        label: "Custom Provider",
        models: [{
          id: "custom-model",
          label: "Custom Model",
          capabilities: {
            reasoningEfforts: [],
            maxContextTokens: 32_000,
            maxOutputTokens: 4_000,
            maxTotalTokens: 36_000,
            providerOptions: {},
          },
        }],
      }],
      runtimeProviders: [{
        id: "custom-provider",
        adapter: "pi-ai",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
        baseURL: "https://gateway.example/v1",
        api: "openai-completions",
        models: ["custom-model"],
        costMultipliers: { "custom-model": 1.5 },
      }],
    }));
    writeFileSync(settingsPath, JSON.stringify({
      "llm-pi-ai": { providers: {
        "custom-provider": {
          displayName: "Custom Provider", apiKeyEnv: "CUSTOM_API_KEY",
          baseURL: "https://gateway.example/v1", api: "openai-completions",
          models: [{ id: "custom-model", name: "Custom Model", contextWindow: 32_000, maxTokens: 4_000 }],
        },
      } },
      "maze-arena-cost-policy": { id: "pi-ai-configured-cost-v1", multipliers: { "custom-provider/custom-model": 1.5 } },
    }));
    const previous = {
      home: process.env.DSH_HOME,
      exportPath: process.env.DSH_MODEL_EXPORT_PATH,
      credentialFd: process.env.DSH_CREDENTIAL_FD,
      allowedTools: process.env.DSH_HARNESS_ALLOWED_TOOLS,
      settingsPath: process.env.DSH_MODEL_SETTINGS_PATH,
      credentialValue: process.env.CUSTOM_API_KEY,
    };
    process.env.DSH_HOME = root;
    process.env.DSH_MODEL_EXPORT_PATH = exportPath;
    process.env.DSH_MODEL_SETTINGS_PATH = settingsPath;
    process.env.DSH_CREDENTIAL_FD = "4";
    process.env.DSH_HARNESS_ALLOWED_TOOLS = "read,edit,search,shell,test,public-check,submit";
    try {
      process.env.CUSTOM_API_KEY = "s3cr3t";
      expect(() => createRuntimePatch("0.1.2-rc.1", {
        providerId: "custom-provider",
        modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"])).toThrow(/只能通过 FD 4/);
      delete process.env.CUSTOM_API_KEY;
      const runtimeFiles = createSessionRuntimeFiles({
        providerId: "custom-provider", modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
        contextTokens: 3_000, outputTokens: 750, totalTokenLimit: 4_000,
      }, {
        id: "custom-provider", adapter: "pi-ai", credentialRef: "dsh-credential://CUSTOM_API_KEY",
        baseURL: "https://gateway.example/v1", api: "openai-completions",
        models: ["custom-model"], costMultipliers: { "custom-model": 1.5 },
      }, "session-custom", 1);
      const runtimeSettings = JSON.parse(readFileSync(runtimeFiles.settingsPath, "utf8"));
      expect(runtimeSettings["llm-pi-ai"].providers["custom-provider"].models[0])
        .toMatchObject({ contextWindow: 3_000, maxTokens: 750 });
      const path = createRuntimePatch("0.1.2-rc.1", {
        providerId: "custom-provider",
        modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"]);
      const patch = readFileSync(path, "utf8");
      expect(patch).toContain("- id: settings");
      expect(patch).toContain(`path: ${JSON.stringify(settingsPath)}`);
      expect(patch).not.toContain("baseURL: \"https://gateway.example/v1\"");
      expect(patch).not.toContain("apiKeyEnv: \"CUSTOM_API_KEY\"");
      for (const id of ["tool-jobs", "tool-skill", "tool-ask-user", "tool-subagent", "tool-workflow", "tool-goal", "tool-web"]) {
        expect(patch).toContain(`- id: ${id}\n  disabled: true`);
      }
      expect(patch).toContain("enableRunInBackground: false");
      expect(patch).toContain("maxParallelToolCalls: 1");
      const boundedPath = createRuntimePatch("0.1.2-rc.1", {
        providerId: "custom-provider", modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
        ...runtimeFiles, maxModelCalls: 1,
      });
      const boundedPatch = readFileSync(boundedPath, "utf8");
      expect(boundedPatch).toContain("- insert:\n    - id: maze-arena-model-call-budget");
      expect(boundedPatch).toContain(`name: ${JSON.stringify(runtimeFiles.budgetPluginPath)}`);
      expect(boundedPatch).toContain("sessionId: \"session-custom\"");
      expect(boundedPatch).toContain("provider: \"custom-provider\"");
      expect(boundedPatch).toContain("model: \"custom-model\"");
      expect(boundedPatch).toContain("maxModelCalls: 1");
      expect(boundedPatch).toContain("maxToolCalls: 7");
      const repairPath = createRuntimePatch("0.1.2-rc.1", {
        providerId: "custom-provider", modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
        ...runtimeFiles, maxModelCalls: 2,
      });
      const repairPatch = readFileSync(repairPath, "utf8");
      expect(repairPatch).toContain("maxModelCalls: 2");
      expect(repairPatch).toContain("maxToolCalls: 7");
      const smokePath = createRuntimePatch("0.1.2-rc.1", {
        providerId: "custom-provider", modelId: "custom-model",
        credentialRef: "dsh-credential://CUSTOM_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
        ...runtimeFiles, maxModelCalls: 2, maxToolCalls: 0,
      });
      expect(readFileSync(smokePath, "utf8")).toContain("maxToolCalls: 0");
    } finally {
      if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
      if (previous.exportPath === undefined) delete process.env.DSH_MODEL_EXPORT_PATH;
      else process.env.DSH_MODEL_EXPORT_PATH = previous.exportPath;
      if (previous.credentialFd === undefined) delete process.env.DSH_CREDENTIAL_FD;
      else process.env.DSH_CREDENTIAL_FD = previous.credentialFd;
      if (previous.allowedTools === undefined) delete process.env.DSH_HARNESS_ALLOWED_TOOLS;
      else process.env.DSH_HARNESS_ALLOWED_TOOLS = previous.allowedTools;
      if (previous.settingsPath === undefined) delete process.env.DSH_MODEL_SETTINGS_PATH;
      else process.env.DSH_MODEL_SETTINGS_PATH = previous.settingsPath;
      if (previous.credentialValue === undefined) delete process.env.CUSTOM_API_KEY;
      else process.env.CUSTOM_API_KEY = previous.credentialValue;
      rmSync(root, { recursive: true, force: true });
    }
  });

  realDshTest("冻结 DSH 经私有设置与预算插件完成真实 prompt 到 idle", async () => {
    const runtimeRoot = resolve(realRuntimeRoot!);
    const dsh = join(runtimeRoot, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    const dshManifest = join(runtimeRoot, "node_modules/@deepseek-ai/dsh/package.json");
    const cordisManifest = join(runtimeRoot, "node_modules/@deepseek-ai/cordis/package.json");
    expect(existsSync(dsh)).toBe(true);
    expect(JSON.parse(readFileSync(dshManifest, "utf8")).version).toBe("0.1.2-rc.1");
    expect(JSON.parse(readFileSync(cordisManifest, "utf8")).version).toBe("4.0.2");

    const root = mkdtempSync(join(tmpdir(), "maze-sdk-real-overlay-"));
    chmodSync(root, 0o700);
    const exportPath = join(root, "model-export.json");
    const settingsPath = join(root, "settings.json");
    writeFileSync(exportPath, JSON.stringify({
      schemaVersion: 1,
      harnessVersion: "0.1.2-rc.1",
      credentialRefs: ["dsh-credential://DEEPSEEK_API_KEY"],
      providers: [{ id: "deepseek-official", label: "DeepSeek", models: [{
        id: "deepseek-v4-flash", label: "Flash", capabilities: {
          reasoningEfforts: ["off", "low", "high", "max"], maxContextTokens: 1_000_000,
          maxOutputTokens: 256_000, maxTotalTokens: 1_256_000, providerOptions: {},
        },
      }] }],
      runtimeProviders: [{ id: "deepseek-official", adapter: "deepseek",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY", models: ["deepseek-v4-flash"],
        costMultipliers: { "deepseek-v4-flash": 1 } }],
    }));
    writeFileSync(settingsPath, JSON.stringify({
      "llm-deepseek": { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{
        id: "deepseek-v4-flash", name: "Flash", contextWindow: 1_000_000, maxTokens: 256_000,
      }] },
    }));
    const previous = {
      home: process.env.DSH_HOME, exportPath: process.env.DSH_MODEL_EXPORT_PATH,
      settingsPath: process.env.DSH_MODEL_SETTINGS_PATH, credentialFd: process.env.DSH_CREDENTIAL_FD,
      allowedTools: process.env.DSH_HARNESS_ALLOWED_TOOLS,
    };
    Object.assign(process.env, {
      DSH_HOME: root,
      DSH_MODEL_EXPORT_PATH: exportPath,
      DSH_MODEL_SETTINGS_PATH: settingsPath,
      DSH_CREDENTIAL_FD: "4",
      DSH_HARNESS_ALLOWED_TOOLS: "read,edit,search,shell,test,public-check,submit",
    });
    let providerCalls = 0;
    const evolvedMarkerPath = join(root, "evolved-marker.txt");
    const missingResultMarkerPath = join(root, "missing-result-marker.txt");
    const boundedMarkerPath = join(root, "bounded-marker.txt");
    const toolBudgetSourcePath = join(root, "tool-budget-source.txt");
    const requestCapturePath = join(root, "request-capture.json");
    const requestObserverPath = join(root, "request-observer.mjs");
    const providerUnknownPath = join(root, "provider-unknown.mjs");
    writeFileSync(toolBudgetSourcePath, "bounded tool source\n");
    writeFileSync(boundedMarkerPath, "before\n");
    writeFileSync(requestObserverPath, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'export const name = "maze-arena-request-observer";',
      'export const inject = ["llm", "sessions", "tokenMeter"];',
      'export function apply(ctx, config) {',
      '  ctx.on("llm/stream", (options, next) => {',
      '    if (options.sessionId !== config.sessionId) return next();',
      '    if (existsSync(config.path)) return next();',
      '    const session = ctx.sessions.get(options.sessionId);',
      '    const request = { provider: options.provider, model: options.model, messages: options.messages,',
      '      system: options.system, tools: options.tools, reasoningEffort: options.reasoningEffort,',
      '      temperature: options.temperature, maxTokens: options.maxTokens };',
      '    writeFileSync(config.path, JSON.stringify({ keys: Object.keys(options).sort(),',
      '      requestBytes: Buffer.byteLength(JSON.stringify(request)),',
      '      modelVisibleBytes: Buffer.byteLength(JSON.stringify({ system: options.system ?? null,',
      '        tools: options.tools ?? [], messages: options.messages ?? [] })),',
      '      systemBytes: Buffer.byteLength(options.system ?? ""),',
      '      toolsBytes: Buffer.byteLength(JSON.stringify(options.tools ?? [])),',
      '      messagesBytes: Buffer.byteLength(JSON.stringify(options.messages ?? [])),',
      '      toolNames: (options.tools ?? []).map((tool) => tool.name).sort(),',
      '      toolCount: options.tools?.length ?? 0, messageCount: options.messages?.length ?? 0,',
      '      surfaceTokens: ctx.tokenMeter.measure(session).surfaceTokens }), { mode: 0o600 });',
      '    return next();',
      '  });',
      '}',
      '',
    ].join("\n"), { mode: 0o600 });
    writeFileSync(providerUnknownPath, [
      'export const name = "maze-provider-unknown";',
      'export function apply(ctx, config) {',
      '  let attempts = 0;',
      '  ctx.on("llm/stream", (options, next) => {',
      '    if (options.sessionId !== config.sessionId) return next();',
      '    attempts += 1;',
      '    if (attempts === 2) throw new Error("provider-owned-unknown");',
      '    return next();',
      '  });',
      '}',
      '',
    ].join("\n"), { mode: 0o600 });
    let observedEvolutionPrompt = "";
    let providerMode: "complete" | "tool" | "edit-evolve" | "edit-empty" | "bounded-evolve" | "always-tool"
      | "tool-budget-final" | "tool-budget-repair" | "multi-tool-budget-final"
      | "retry-success" | "retry-fail" | "max-tokens" | "max-token-tool" | "max-token-partial-tool"
      | "max-token-mixed-tool" | "max-token-final-json" | "max-token-partial-json"
      | "tool-ledger-error-provider-unknown" | "tool-ledger-error-final" = "complete";
    const providerServer = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      providerCalls += 1;
      const requestChunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => requestChunks.push(chunk));
      request.once("end", () => {
        if (providerMode === "bounded-evolve" && providerCalls === 1) {
          const body = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
          observedEvolutionPrompt = body.messages?.map((message: { content?: unknown }) => message.content)
            .find((content: unknown) => typeof content === "string" && content.includes("Maze Arena plugin evolution worker")) ?? "";
        }
        if ((providerMode === "retry-success" || providerMode === "retry-fail") && providerCalls === 1) {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "RATE_LIMIT", message: "opaque-first-attempt" } }));
          return;
        }
        if (providerMode === "retry-fail") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "SERVER", message: "opaque-final-attempt" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const requestsTool = providerMode === "tool" || providerMode === "always-tool"
          || (["tool-ledger-error-provider-unknown", "tool-ledger-error-final"].includes(providerMode)
            && providerCalls === 1)
          || (providerMode === "tool-budget-final" && providerCalls <= 6)
          || (providerMode === "tool-budget-repair" && providerCalls <= 6)
          || (providerMode === "multi-tool-budget-final" && providerCalls === 1)
          || (providerMode === "max-token-tool" && providerCalls <= 3)
          || providerMode === "max-token-partial-tool" || providerMode === "max-token-mixed-tool"
          || ((providerMode === "edit-evolve" || providerMode === "edit-empty") && providerCalls === 1)
          || (providerMode === "bounded-evolve" && providerCalls <= 3);
        const boundedTool = ["tool-budget-final", "tool-budget-repair", "multi-tool-budget-final", "max-token-tool", "max-token-mixed-tool"]
          .includes(providerMode)
          ? { name: "read", arguments: JSON.stringify({ file_path: toolBudgetSourcePath }) }
          : providerMode === "max-token-partial-tool"
            ? { name: "read", arguments: '{"file_path":' }
          : providerMode === "bounded-evolve" && providerCalls === 1
            ? { name: "read", arguments: JSON.stringify({ file_path: boundedMarkerPath }) }
          : providerMode === "bounded-evolve" && providerCalls === 2
            ? { name: "edit", arguments: JSON.stringify({
              file_path: boundedMarkerPath, old_string: "before\n", new_string: "after\n",
            }) }
            : providerMode === "bounded-evolve" && providerCalls === 3
              ? { name: "bash", arguments: JSON.stringify({
                command: `grep -q '^after$' ${JSON.stringify(boundedMarkerPath)}`,
                description: "Verify focused marker edit",
              }) }
              : undefined;
        const delta = requestsTool
          ? { role: "assistant",
            ...((providerMode === "edit-empty" || providerMode === "max-token-mixed-tool") ? {
              content: providerMode === "max-token-mixed-tool" ? "mixed truncated text" : JSON.stringify({
                hypothesis: "早期合法结果", strategyPlan: "不得替代最终消息", submitted: true,
              }),
            } : {}),
            tool_calls: Array.from({ length: providerMode === "multi-tool-budget-final" ? 7 : 1 }, (_, index) => ({
            index, id: `call-${providerCalls}-${index}`, type: "function",
            function: boundedTool ?? (providerMode === "edit-evolve" || providerMode === "edit-empty"
              ? { name: "write", arguments: JSON.stringify({
                file_path: providerMode === "edit-empty" ? missingResultMarkerPath : evolvedMarkerPath,
                content: "evolved\n",
              }) }
              : { name: "bash", arguments: JSON.stringify({ command: "printf ready", description: "Print readiness marker" }) }),
          })) }
          : { role: "assistant", content: providerMode === "max-tokens" || providerMode === "max-token-final-json"
            ? JSON.stringify({ hypothesis: "complete", strategyPlan: "complete", submitted: true })
            : providerMode === "max-token-partial-json" ? '{"hypothesis":"partial"'
            : providerMode === "edit-evolve"
              ? JSON.stringify({ hypothesis: "写入验证标记", strategyPlan: "由 Arena 验证工作区差异", submitted: true })
              : providerMode === "bounded-evolve"
                ? JSON.stringify({ hypothesis: "有界调用内完成修改", strategyPlan: "读取、编辑并运行聚焦验证", submitted: true })
              : providerMode === "tool-budget-repair" && providerCalls === 7 ? "说明文字"
              : providerMode === "tool-budget-repair" && providerCalls === 8
                ? JSON.stringify({ hypothesis: "工具门禁后修复", strategyPlan: "严格 JSON 修复回合可达", submitted: true })
              : providerMode === "tool-budget-final"
                ? JSON.stringify({ hypothesis: "工具门禁生效", strategyPlan: "停止工具调用并提交结果", submitted: true })
              : providerMode === "multi-tool-budget-final"
                ? JSON.stringify({ hypothesis: "同一步工具门禁生效", strategyPlan: "停止工具调用并提交结果", submitted: true })
              : providerMode === "max-token-tool"
                ? JSON.stringify({ hypothesis: "完整截断工具继续执行", strategyPlan: "工具完成后提交结果", submitted: true })
              : providerMode === "tool-ledger-error-final"
                ? JSON.stringify({ hypothesis: "不应接受", strategyPlan: "账本已失败", submitted: true })
              : providerMode === "edit-empty" ? " " : "ready" };
        response.write(`data: ${JSON.stringify({
          id: "maze-local-replay", object: "chat.completion.chunk", created: 1,
          model: "deepseek-v4-flash", choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: "maze-local-replay", object: "chat.completion.chunk", created: 1,
          model: "deepseek-v4-flash", choices: [{
            index: 0, delta: {}, finish_reason: providerMode === "max-tokens"
              || (providerMode.startsWith("max-token-") && providerMode !== "max-token-tool")
              || (providerMode === "max-token-tool" && providerCalls === 3)
              ? "length" : requestsTool ? "tool_calls" : "stop",
          }],
          usage: { prompt_tokens: 120, completion_tokens: 1, total_tokens: 121 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolveListen) => providerServer.listen(0, "127.0.0.1", resolveListen));
    const providerPort = (providerServer.address() as AddressInfo).port;
    let child: ReturnType<typeof spawn> | undefined;
    let credentialFd: number | undefined;
    try {
      const runtimeFiles = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 256_000, outputTokens: 64_000, totalTokenLimit: 320_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-real-overlay", 2);
      const patchPath = createRuntimePatch("0.1.2-rc.1", {
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
        ...runtimeFiles, maxModelCalls: 2,
      });
      const environment = {
        ...process.env,
        HOME: root,
        DSH_TELEMETRY_MODE: "DISABLED",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      };
      const dump = spawnSync(dsh, ["--profile", "sdk", "--patch", patchPath, "--dump-config"], {
        cwd: root, env: environment, encoding: "utf8", timeout: 15_000,
      });
      expect(dump.status, dump.stderr).toBe(0);
      expect(dump.stderr).not.toContain('entry "maze-arena-model-call-budget" not found');
      expect(dump.stdout.match(/^- id: maze-arena-model-call-budget$/gmu)).toHaveLength(1);
      expect(dump.stdout).toContain(runtimeFiles.budgetPluginPath);
      expect(dump.stdout).toContain(`- id: settings\n  name: '@deepseek-ai/dsh-settings-file'`);
      expect(dump.stdout).toContain(runtimeFiles.settingsPath);

      const credentialPath = join(root, "credentials.yml");
      writeFileSync(credentialPath, [
        "version: 1",
        "refs:",
        "  DEEPSEEK_API_KEY: test-only-not-a-real-secret",
        "records: {}",
        "",
      ].join("\n"), { mode: 0o600 });
      credentialFd = openSync(credentialPath, "r");
      child = spawn(dsh, ["--profile", "sdk", "--patch", patchPath], {
        cwd: root, env: environment, detached: true,
        stdio: ["pipe", "pipe", "pipe", "ignore", credentialFd],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.stdout?.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      const client = new SdkClient(child as never, "session-real-overlay", 1, {
        maxTokens: 640_000, maxCost: 5, maxModelCalls: 2,
      }, 256_000);
      const initialized = await client.request("initialize", {
        cwd: root, provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 500,
      }).catch((error) => { throw new Error(`${String(error)}\n${stderr}`); });
      expect(initialized).toMatchObject({ serverInfo: { name: "deepseek-harness-sdk-runtime" } });
      const idle = client.waitForIdle();
      await client.request("session/prompt", {
        sessionId: "session-real-overlay",
        contentBlocks: [{ type: "text", text: "Return one short readiness response." }],
      });
      await idle.catch((error) => { throw new Error(`${String(error)}\n${stderr}`); });
      expect(providerCalls).toBe(1);
      expect(client.events).toContainEqual(expect.objectContaining({
        type: "request/context",
        data: expect.objectContaining({
          provider: "deepseek-official", model: "deepseek-v4-flash", contextWindow: 256_000,
        }),
      }));
      expect(client.finalAssistantText()).toBe("ready");
      expect(client.totalUsage()).toEqual({ tokens: 121, cost: 0.000124 });
      expect(client.totalModelCalls()).toBe(1);
      await client.request("shutdown", {});
      if (child.exitCode === null && child.pid) {
        const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
      }

      const runRetrySession = async (
        sessionId: string,
        mode: "retry-success" | "retry-fail" | "max-tokens" | "edit-evolve" | "edit-empty"
          | "bounded-evolve" | "always-tool" | "tool-budget-final" | "tool-budget-repair" | "multi-tool-budget-final"
          | "max-token-tool" | "max-token-partial-tool" | "max-token-mixed-tool"
          | "max-token-final-json" | "max-token-partial-json" | "tool-ledger-error-provider-unknown"
          | "tool-ledger-error-final",
        maxModelCalls = 2,
        prompt = "Return one short readiness response.",
        contextTokens = 256_000,
        useBudgetLedger = false,
        strictEvolution = false,
      ) => {
        providerMode = mode;
        providerCalls = 0;
        const retryRuntime = createSessionRuntimeFiles({
          providerId: "deepseek-official", modelId: "deepseek-v4-flash",
          credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
          contextTokens, outputTokens: 64_000, totalTokenLimit: contextTokens + 64_000,
        }, {
          id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
          models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
        }, sessionId, maxModelCalls);
        const settings = JSON.parse(readFileSync(retryRuntime.settingsPath, "utf8"));
        settings["llm-deepseek"].retryPolicy = {
          mode: "normal", maxRetries: 1, retryableCodes: ["RATE_LIMIT", "SERVER"],
          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        };
        writeFileSync(retryRuntime.settingsPath, JSON.stringify(settings), { mode: 0o600 });
        const retryPatch = createRuntimePatch("0.1.2-rc.1", {
          providerId: "deepseek-official", modelId: "deepseek-v4-flash",
          credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
          ...retryRuntime, maxModelCalls,
        });
        if (mode === "bounded-evolve") writeFileSync(retryPatch, `${readFileSync(retryPatch, "utf8")}- insert:\n`
          + `    - id: maze-arena-request-observer\n      name: ${JSON.stringify(requestObserverPath)}\n      config:\n`
          + `        sessionId: ${JSON.stringify(sessionId)}\n        path: ${JSON.stringify(requestCapturePath)}\n`);
        if (mode === "tool-ledger-error-provider-unknown") writeFileSync(retryPatch,
          `${readFileSync(retryPatch, "utf8")}- insert:\n`
          + `    - id: maze-provider-unknown\n      name: ${JSON.stringify(providerUnknownPath)}\n      config:\n`
          + `        sessionId: ${JSON.stringify(sessionId)}\n`);
        const ledgerRequests: Array<{ operation?: string }> = [];
        const localFailureFrames: Array<{ scope?: string; code?: string }> = [];
        child = spawn(dsh, ["--profile", "sdk", "--patch", retryPatch], {
          cwd: root,
          env: { ...environment, DSH_LOCAL_FAILURE_FD: "6",
            ...(useBudgetLedger ? { DSH_BUDGET_LEDGER_FD: "5" } : {}) },
          detached: true,
          stdio: useBudgetLedger
            ? ["pipe", "pipe", "pipe", "ignore", credentialFd, "pipe", "pipe"]
            : ["pipe", "pipe", "pipe", "ignore", credentialFd, "ignore", "pipe"],
        });
        let retryStderr = "";
        child.stderr?.on("data", (chunk: Buffer) => { retryStderr += chunk.toString("utf8"); });
        if (useBudgetLedger) {
          const ledger = (child.stdio as unknown as Array<Duplex | null>)[5];
          let ledgerBuffer = "";
          ledger?.on("data", (chunk: Buffer) => {
            ledgerBuffer += chunk.toString("utf8");
            while (ledgerBuffer.includes("\n")) {
              const newline = ledgerBuffer.indexOf("\n");
              const request = JSON.parse(ledgerBuffer.slice(0, newline));
              ledgerBuffer = ledgerBuffer.slice(newline + 1);
              ledgerRequests.push(request);
              if (["tool-ledger-error-provider-unknown", "tool-ledger-error-final"].includes(mode)
                && request.operation === "reserve-tool") {
                ledger.write(`${JSON.stringify({ ok: false })}\n`);
              } else {
                const value = request.operation === "reserve-provider"
                  ? `reservation-${ledgerRequests.length}` : true;
                ledger.write(`${JSON.stringify({ ok: true, value })}\n`);
              }
            }
          });
        }
        const localFailures = (child.stdio as unknown as Array<Duplex | null>)[6];
        localFailures?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").trim().split("\n")) {
            if (line) localFailureFrames.push(JSON.parse(line));
          }
        });
        const retryClient = new SdkClient(child as never, sessionId, 1, {
          maxTokens: 640_000, maxCost: 5, maxModelCalls,
        }, contextTokens);
        await retryClient.request("initialize", {
          cwd: root, provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 500,
        }).catch((error) => { throw new Error(`${String(error)}\n${retryStderr}`); });
        if (strictEvolution) {
          const strictResult = requestStrictEvolutionResult(retryClient, sessionId, prompt, maxModelCalls);
          return { retryClient, retryIdle: strictResult.then(() => undefined), strictResult,
            retryStderr, ledgerRequests, localFailureFrames };
        }
        const retryIdle = retryClient.waitForIdle();
        await retryClient.request("session/prompt", {
          sessionId, contentBlocks: [{ type: "text", text: prompt }],
        });
        return { retryClient, retryIdle, strictResult: undefined, retryStderr, ledgerRequests, localFailureFrames };
      };

      const recovered = await runRetrySession("session-retry-success", "retry-success");
      await expect(recovered.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(2);
      expect(recovered.retryClient.totalUsage()).toEqual({ tokens: 121, cost: 0.000124 });
      expect(recovered.retryClient.totalModelCalls()).toBe(2);
      expect(recovered.retryClient.events.filter(({ type }) => type === "llm/retry")).toHaveLength(1);
      await recovered.retryClient.request("shutdown", {});

      const evolved = await runRetrySession("session-edit-evolve", "edit-evolve", 4);
      await expect(evolved.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(2);
      expect(readFileSync(evolvedMarkerPath, "utf8")).toBe("evolved\n");
      expect(parseFinalJson(evolved.retryClient.finalAssistantText())).toEqual({
        hypothesis: "写入验证标记", strategyPlan: "由 Arena 验证工作区差异", submitted: true,
      });
      expect(evolved.retryClient.totalUsage()).toEqual({ tokens: 242, cost: 0.000248 });
      expect(evolved.retryClient.totalModelCalls()).toBe(2);
      await evolved.retryClient.request("shutdown", {});

      const missingResult = await runRetrySession("session-edit-empty", "edit-empty", 4);
      await expect(missingResult.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(2);
      expect(readFileSync(missingResultMarkerPath, "utf8")).toBe("evolved\n");
      expect(() => missingResult.retryClient.finalAssistantText()).toThrow(expect.objectContaining({
        name: "AdapterError", kind: "protocol", code: "RESULT_MISSING",
      }));
      expect(missingResult.retryClient.totalUsage()).toEqual({ tokens: 242, cost: 0.000248 });
      expect(missingResult.retryClient.totalModelCalls()).toBe(2);
      await missingResult.retryClient.request("shutdown", {});

      const boundedPrompt = createEvolutionPrompt({
        session: { role: "generator", roleConstraint: "只修改当前生成器" },
        attempt: { experimentId: "exp", generation: 1, attemptId: "g0001-generator", repairAttempt: 0, diagnostics: [] },
        input: { lineagePlans: [], trustedResults: [], publicTraces: [], hiddenAggregate: {
          completedAttemptCount: 0, metricAvailableAttemptCount: 0, metricUnavailableAttemptCount: 0,
          promotedAttemptCount: 0, failedAttemptCount: 0, tieAttemptCount: 0,
          evaluatedHiddenCaseCount: 0, metricTotals: {},
        } },
      }, 8);
      const bounded = await runRetrySession(
        "session-bounded-evolve", "bounded-evolve", 8, boundedPrompt, 256_000, true,
      );
      await expect(bounded.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(4);
      expect(readFileSync(boundedMarkerPath, "utf8")).toBe("after\n");
      expect(observedEvolutionPrompt).toContain("at most 8 total model calls");
      expect(observedEvolutionPrompt).toContain("at most 7 tool calls");
      expect(observedEvolutionPrompt).toContain("independent generation budget");
      expect(parseFinalJson(bounded.retryClient.finalAssistantText())).toEqual({
        hypothesis: "有界调用内完成修改", strategyPlan: "读取、编辑并运行聚焦验证", submitted: true,
      });
      expect(bounded.retryClient.totalModelCalls()).toBe(4);
      expect(bounded.ledgerRequests.filter(({ operation }) => operation === "reserve-provider")).toHaveLength(4);
      expect(bounded.ledgerRequests.filter(({ operation }) => operation === "settle-provider")).toHaveLength(4);
      const captured = JSON.parse(readFileSync(requestCapturePath, "utf8"));
      expect(captured).toMatchObject({
        keys: expect.arrayContaining(["messages", "model", "provider", "sessionId", "system", "tools"]),
        toolCount: 7,
        toolNames: ["bash", "edit", "glob", "grep", "read", "read_image", "write"],
      });
      expect(captured.surfaceTokens + 8_192).toBeLessThanOrEqual(256_000);
      const firstReservation = bounded.ledgerRequests.find(({ operation }) => operation === "reserve-provider") as {
        tokens: number;
      };
      expect(firstReservation.tokens).toBe(captured.modelVisibleBytes + 8_192 + 500);
      await bounded.retryClient.request("shutdown", {});

      const contextRejected = await runRetrySession(
        "session-context-rejected", "bounded-evolve", 8, boundedPrompt, 8_192, true,
      );
      await expect(contextRejected.retryIdle).rejects.toMatchObject({
        kind: "protocol", code: "ARENA_REQUEST_CONTEXT_EXCEEDED",
      });
      expect(providerCalls).toBe(0);
      expect(contextRejected.retryClient.totalModelCalls()).toBe(0);
      expect(contextRejected.ledgerRequests).toHaveLength(0);
      expect(contextRejected.localFailureFrames.map(({ code }) => code))
        .toEqual(["ARENA_REQUEST_CONTEXT_EXCEEDED"]);
      await contextRejected.retryClient.request("shutdown", {});

      const toolLedgerFailure = await runRetrySession(
        "session-tool-ledger-failure", "tool-ledger-error-provider-unknown", 4,
        "Use one tool, then continue once with the tool result.", 256_000, true,
      );
      const providerFailure = await toolLedgerFailure.retryIdle.catch((error) => error);
      expect(providerFailure).toMatchObject({ name: "AdapterError", kind: "provider", code: "UNKNOWN" });
      expect(toolLedgerFailure.retryClient.events.filter(({ type }) => type === "tool/result")).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ message: expect.objectContaining({
          content: [expect.objectContaining({ isError: true })],
        }) }) }),
      );
      expect(providerCalls).toBe(1);
      expect(toolLedgerFailure.localFailureFrames).toEqual([
        expect.objectContaining({ scope: "session", code: "ARENA_LEDGER_REJECTED" }),
      ]);
      expect(classifyRuntimeFailureFromChannel(providerFailure, {
        kind: "session", code: toolLedgerFailure.localFailureFrames[0]!.code!,
      }, 2)).toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
      expect(classifyRuntimeFailureFromChannel(providerFailure, {
        kind: "attempt", attemptSequence: 1, code: "ARENA_REQUEST_CONTEXT_EXCEEDED",
      }, 2))
        .toEqual({ kind: "provider", code: "UNKNOWN" });
      await toolLedgerFailure.retryClient.request("shutdown", {});

      const toolLedgerFinal = await runRetrySession(
        "session-tool-ledger-final", "tool-ledger-error-final", 4,
        "Use one tool, then return final JSON after the tool result.", 256_000, true,
      );
      await expect(toolLedgerFinal.retryIdle).resolves.toBeUndefined();
      expect(parseFinalJson(toolLedgerFinal.retryClient.finalAssistantText())).toEqual({
        hypothesis: "不应接受", strategyPlan: "账本已失败", submitted: true,
      });
      expect(providerCalls).toBe(2);
      expect(toolLedgerFinal.localFailureFrames).toEqual([
        expect.objectContaining({ scope: "session", code: "ARENA_LEDGER_REJECTED" }),
      ]);
      expect(classifyRuntimeFailure(new Error("DSH 表面完成"), toolLedgerFinal.localFailureFrames.at(-1)?.code))
        .toEqual({ kind: "protocol", code: "ARENA_LEDGER_REJECTED" });
      await toolLedgerFinal.retryClient.request("shutdown", {});

      const recoveredMaxTokenTool = await runRetrySession(
        "session-max-token-tool", "max-token-tool", 8,
        "Read the source three times, then return final JSON.", 256_000,
      );
      await expect(recoveredMaxTokenTool.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(4);
      expect(recoveredMaxTokenTool.retryClient.events.filter(({ type }) => type === "tool/result")).toHaveLength(3);
      expect(parseFinalJson(recoveredMaxTokenTool.retryClient.finalAssistantText())).toEqual({
        hypothesis: "完整截断工具继续执行", strategyPlan: "工具完成后提交结果", submitted: true,
      });
      expect(recoveredMaxTokenTool.retryClient.totalModelCalls()).toBe(4);
      expect(recoveredMaxTokenTool.retryClient.totalUsage()).toEqual({ tokens: 484, cost: 0.000496 });
      await recoveredMaxTokenTool.retryClient.request("shutdown", {});

      for (const mode of ["max-token-partial-tool", "max-token-mixed-tool"] as const) {
        const rejectedTool = await runRetrySession(`session-${mode}`, mode, 8, "Attempt one tool.", 256_000);
        await expect(rejectedTool.retryIdle).rejects.toMatchObject({
          name: "AdapterError", kind: "protocol", code: "SDK_TURN_MAX_TOKENS",
        });
        expect(providerCalls).toBe(1);
        expect(rejectedTool.retryClient.events.filter(({ type }) => type === "tool/result")).toHaveLength(0);
        expect(rejectedTool.retryClient.totalModelCalls()).toBe(1);
        expect(rejectedTool.retryClient.totalUsage()).toEqual({ tokens: 121, cost: 0.000124 });
        await rejectedTool.retryClient.request("shutdown", {});
      }

      const completeJsonAtLimit = await runRetrySession(
        "session-max-token-final-json", "max-token-final-json", 8, "Return final JSON.", 256_000,
      );
      await expect(completeJsonAtLimit.retryIdle).resolves.toBeUndefined();
      expect(parseFinalJson(completeJsonAtLimit.retryClient.finalAssistantText())).toEqual({
        hypothesis: "complete", strategyPlan: "complete", submitted: true,
      });
      expect(completeJsonAtLimit.retryClient.totalModelCalls()).toBe(1);
      await completeJsonAtLimit.retryClient.request("shutdown", {});

      const partialJsonAtLimit = await runRetrySession(
        "session-max-token-partial-json", "max-token-partial-json", 8, "Return final JSON.", 256_000,
      );
      await expect(partialJsonAtLimit.retryIdle).rejects.toMatchObject({
        name: "AdapterError", kind: "protocol", code: "SDK_TURN_MAX_TOKENS",
      });
      expect(() => parseFinalJson(partialJsonAtLimit.retryClient.finalAssistantText()))
        .toThrow(expect.objectContaining({ code: "RESULT_JSON_INVALID" }));
      expect(partialJsonAtLimit.retryClient.totalModelCalls()).toBe(1);
      await partialJsonAtLimit.retryClient.request("shutdown", {});

      const toolBounded = await runRetrySession(
        "session-tool-call-budget", "tool-budget-final", 8,
        "Use up to seven tools, then return final JSON.", 256_000,
      );
      await expect(toolBounded.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(7);
      const toolCalls = toolBounded.retryClient.events.filter(({ type }) => type === "tool/call");
      const toolResults = toolBounded.retryClient.events.filter(({ type }) => type === "tool/result");
      expect(toolCalls).toHaveLength(6);
      expect(toolResults).toHaveLength(6);
      for (const result of toolResults) {
        expect(result).toMatchObject({ data: { message: { content: [{ isError: false }] } } });
      }
      expect(parseFinalJson(toolBounded.retryClient.finalAssistantText())).toEqual({
        hypothesis: "工具门禁生效", strategyPlan: "停止工具调用并提交结果", submitted: true,
      });
      expect(toolBounded.retryClient.totalModelCalls()).toBe(7);
      expect(toolBounded.retryClient.totalUsage()).toEqual({ tokens: 847, cost: 0.000868 });
      await toolBounded.retryClient.request("shutdown", {});

      const toolBudgetRepair = await runRetrySession(
        "session-tool-call-budget-repair", "tool-budget-repair", 8,
        "Use up to six tools, then return invalid JSON once for repair.", 256_000,
        true, true,
      );
      await expect(toolBudgetRepair.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(8);
      const repairToolResults = toolBudgetRepair.retryClient.events.filter(({ type }) => type === "tool/result");
      expect(repairToolResults).toHaveLength(6);
      for (const result of repairToolResults) {
        expect(result).toMatchObject({ data: { message: { content: [{ isError: false }] } } });
      }
      expect(parseFinalJson(toolBudgetRepair.retryClient.finalAssistantText())).toEqual({
        hypothesis: "工具门禁后修复", strategyPlan: "严格 JSON 修复回合可达", submitted: true,
      });
      await expect(toolBudgetRepair.strictResult!).resolves.toEqual({
        hypothesis: "工具门禁后修复", strategyPlan: "严格 JSON 修复回合可达", submitted: true,
      });
      expect(toolBudgetRepair.ledgerRequests.filter(({ operation }) => operation === "reserve-tool")).toHaveLength(6);
      expect(toolBudgetRepair.retryClient.totalModelCalls()).toBe(8);
      expect(toolBudgetRepair.retryClient.totalUsage()).toEqual({ tokens: 968, cost: 0.000992 });
      await toolBudgetRepair.retryClient.request("shutdown", {});

      const multiToolBounded = await runRetrySession(
        "session-multi-tool-call-budget", "multi-tool-budget-final", 8,
        "Request seven reads in one step, then return final JSON.", 256_000,
      );
      await expect(multiToolBounded.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(2);
      const multiToolResults = multiToolBounded.retryClient.events.filter(({ type }) => type === "tool/result");
      expect(multiToolResults).toHaveLength(7);
      for (const result of multiToolResults.slice(0, 6)) {
        expect(result).toMatchObject({ data: { message: { content: [{ isError: false }] } } });
      }
      expect(multiToolResults.at(-1)).toMatchObject({
        data: { message: { content: [{ isError: true }] } },
      });
      expect(parseFinalJson(multiToolBounded.retryClient.finalAssistantText())).toEqual({
        hypothesis: "同一步工具门禁生效", strategyPlan: "停止工具调用并提交结果", submitted: true,
      });
      expect(multiToolBounded.retryClient.totalModelCalls()).toBe(2);
      await multiToolBounded.retryClient.request("shutdown", {});

      const ninthBlocked = await runRetrySession("session-eight-call-budget", "always-tool", 8);
      const ninthError = await ninthBlocked.retryIdle.catch((error) => error);
      expect(ninthError).toMatchObject({
        name: "AdapterError", kind: "protocol", code: "ARENA_MODEL_CALL_BUDGET_EXHAUSTED",
      });
      expect(classifyRuntimeFailure(ninthError, ninthBlocked.localFailureFrames.at(-1)?.code))
        .toEqual({ kind: "protocol", code: "MODEL_CALL_BUDGET_EXHAUSTED" });
      expect(providerCalls).toBe(8);
      // 第八次工具响应之后，预算插件在第九次 Provider 前关闭；八次真实 attempt 均计数。
      expect(ninthBlocked.retryClient.totalModelCalls()).toBe(8);
      expect(ninthBlocked.retryClient.totalUsage()).toEqual({ tokens: 968, cost: 0.000992 });
      await ninthBlocked.retryClient.request("shutdown", {});

      const exhausted = await runRetrySession("session-retry-fail", "retry-fail");
      await expect(exhausted.retryIdle).rejects.toMatchObject({
        name: "AdapterError", kind: "transient-provider", code: "SERVER",
      });
      await expect(exhausted.retryIdle).rejects.not.toThrow(/opaque-first-attempt|opaque-final-attempt/);
      expect(providerCalls).toBe(2);
      expect(exhausted.retryClient.totalUsage()).toEqual({ tokens: 0, cost: 0 });
      expect(exhausted.retryClient.totalModelCalls()).toBe(2);
      expect(exhausted.retryClient.events.filter(({ type }) => type === "llm/retry")).toHaveLength(1);
      await exhausted.retryClient.request("shutdown", {});

      const budgetedRetry = await runRetrySession("session-retry-budget", "retry-success", 1);
      const budgetedRetryError = await budgetedRetry.retryIdle.catch((error) => error);
      expect(budgetedRetryError).toMatchObject({
        name: "AdapterError", kind: "protocol", code: "ARENA_MODEL_CALL_BUDGET_EXHAUSTED",
      });
      expect(classifyRuntimeFailure(budgetedRetryError, budgetedRetry.localFailureFrames.at(-1)?.code))
        .toEqual({ kind: "protocol", code: "MODEL_CALL_BUDGET_EXHAUSTED" });
      expect(providerCalls).toBe(1);
      expect(budgetedRetry.retryClient.totalUsage()).toEqual({ tokens: 0, cost: 0 });
      expect(budgetedRetry.retryClient.totalModelCalls()).toBe(1);
      expect(budgetedRetry.retryClient.events.filter(({ type }) => type === "llm/retry")).toHaveLength(1);
      await budgetedRetry.retryClient.request("shutdown", {});

      const maxTokens = await runRetrySession("session-max-tokens", "max-tokens", 1);
      await expect(maxTokens.retryIdle).resolves.toBeUndefined();
      expect(providerCalls).toBe(1);
      expect(maxTokens.retryClient.totalUsage()).toEqual({ tokens: 121, cost: 0.000124 });
      expect(maxTokens.retryClient.totalModelCalls()).toBe(1);
      expect(maxTokens.retryClient.finalAssistantText()).toContain('"submitted":true');
      await maxTokens.retryClient.request("shutdown", {});

      providerMode = "tool";
      providerCalls = 0;
      const budgetRuntime = createSessionRuntimeFiles({
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        contextTokens: 256_000, outputTokens: 64_000, totalTokenLimit: 320_000,
      }, {
        id: "deepseek-official", adapter: "deepseek", credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
        models: ["deepseek-v4-flash"], costMultipliers: { "deepseek-v4-flash": 1 },
      }, "session-budget-overlay", 1);
      const budgetPatch = createRuntimePatch("0.1.2-rc.1", {
        providerId: "deepseek-official", modelId: "deepseek-v4-flash",
        credentialRef: "dsh-credential://DEEPSEEK_API_KEY",
      }, ["read", "edit", "search", "shell", "test", "public-check", "submit"], {
        ...budgetRuntime, maxModelCalls: 1,
      });
      child = spawn(dsh, ["--profile", "sdk", "--patch", budgetPatch], {
        cwd: root, env: { ...environment, DSH_LOCAL_FAILURE_FD: "6" }, detached: true,
        stdio: ["pipe", "pipe", "pipe", "ignore", credentialFd, "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const budgetLocalFailureCodes: string[] = [];
      const budgetLocalFailures = (child.stdio as unknown as Array<Duplex | null>)[6];
      budgetLocalFailures?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").trim().split("\n")) {
          if (line) budgetLocalFailureCodes.push(JSON.parse(line).code);
        }
      });
      const budgetClient = new SdkClient(child as never, "session-budget-overlay", 1, {
        maxTokens: 640_000, maxCost: 5, maxModelCalls: 1,
      }, 256_000);
      await budgetClient.request("initialize", {
        cwd: root, provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 500,
      });
      const budgetIdle = budgetClient.waitForIdle();
      await budgetClient.request("session/prompt", {
        sessionId: "session-budget-overlay",
        contentBlocks: [{ type: "text", text: "Run one readiness command, then report its result." }],
      });
      const budgetError = await budgetIdle.catch((error) => error);
      expect(budgetError).toMatchObject({
        name: "AdapterError", kind: "protocol", code: "ARENA_MODEL_CALL_BUDGET_EXHAUSTED",
      });
      expect(classifyRuntimeFailure(budgetError, budgetLocalFailureCodes.at(-1)))
        .toEqual({ kind: "protocol", code: "MODEL_CALL_BUDGET_EXHAUSTED" });
      expect(providerCalls).toBe(1);
      expect(budgetClient.totalModelCalls()).toBe(1);
      expect(stderr).not.toMatch(/maze-arena-model-call-budget.*(?:fail|error|not found)/iu);
    } finally {
      if (child?.exitCode === null && child.pid) {
        const exited = new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit()));
        process.kill(-child.pid, "SIGKILL");
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
      }
      if (credentialFd !== undefined) closeSync(credentialFd);
      await new Promise<void>((resolveClose) => providerServer.close(() => resolveClose()));
      for (const [key, value] of Object.entries(previous)) {
        const environmentKey = key === "exportPath" ? "DSH_MODEL_EXPORT_PATH"
          : key === "settingsPath" ? "DSH_MODEL_SETTINGS_PATH"
            : key === "credentialFd" ? "DSH_CREDENTIAL_FD"
              : key === "allowedTools" ? "DSH_HARNESS_ALLOWED_TOOLS" : "DSH_HOME";
        if (value === undefined) delete process.env[environmentKey]; else process.env[environmentKey] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
