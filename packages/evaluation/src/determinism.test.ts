import { describe, expect, it } from "vitest";
import {
  CandidateGateError,
  DeterministicEvaluationCache,
  createEvaluationCacheKey,
  runCandidateGate,
  type CandidateExecutionFailure,
  type EvaluationCacheKeyInput,
} from "./index.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("确定性门禁与评测缓存", () => {
  it("在不同启动时间和调度扰动下至少三次逐字节一致才通过", async () => {
    const perturbations: unknown[] = [];
    const result = await runCandidateGate({
      build: () => undefined,
      execute: (perturbation) => {
        perturbations.push(perturbation);
        return { authoritativeBytes: bytes({ events: [1, 2], score: 3 }), complete: true, telemetry: { wallClockMs: Math.random() } };
      },
    });
    expect(result).toMatchObject({ passed: true, successfulRepetitions: 3, infrastructureRetries: 0 });
    expect(perturbations).toHaveLength(3);
  });

  it("时间或进程内随机影响权威输出时以稳定原因关闭失败", async () => {
    let run = 0;
    const result = await runCandidateGate({
      build: () => undefined,
      execute: () => ({ authoritativeBytes: bytes({ run: ++run }), complete: true }),
    });
    expect(result).toEqual({ passed: false, reason: "nondeterministic", successfulRepetitions: 3, infrastructureRetries: 0 });
  });

  it.each([
    ["protocol-failed", "protocol-failed"],
    ["illegal-output", "illegal-output"],
    ["resource-limit", "resource-limit"],
  ] as const)("插件故障 %s 不作为基础设施故障重试", async (_label, reason) => {
    let calls = 0;
    const result = await runCandidateGate({
      build: () => undefined,
      execute: () => { calls += 1; throw new CandidateGateError(reason, "候选失败"); },
    });
    expect(result.reason).toBe(reason);
    expect(calls).toBe(1);
    expect(result.infrastructureRetries).toBe(0);
  });

  it("构建失败使用稳定枚举且不执行候选", async () => {
    let executed = false;
    const result = await runCandidateGate({
      build: () => { throw new Error("编译器失败"); },
      execute: () => { executed = true; return { authoritativeBytes: bytes(1), complete: true }; },
    });
    expect(result.reason).toBe("build-failed");
    expect(executed).toBe(false);
  });

  it("基础设施故障最多重试两次，恢复后仍需三个成功样本", async () => {
    let calls = 0;
    const recovered = await runCandidateGate({
      build: () => undefined,
      execute: () => {
        calls += 1;
        if (calls <= 2) throw new CandidateGateError("infrastructure-failed", "容器暂不可用");
        return { authoritativeBytes: bytes("stable"), complete: true };
      },
    });
    expect(recovered).toMatchObject({ passed: true, successfulRepetitions: 3, infrastructureRetries: 2 });
    expect(calls).toBe(5);

    const stopped = await runCandidateGate({
      build: () => undefined,
      execute: () => { throw new CandidateGateError("infrastructure-failed", "持续故障"); },
    });
    expect(stopped).toEqual({ passed: false, reason: "infrastructure-failed", successfulRepetitions: 0, infrastructureRetries: 2 });
  });

  it("不完整执行不进入缓存，遥测差异不改变权威摘要", async () => {
    const cache = new DeterministicEvaluationCache();
    const incomplete = await runCandidateGate({
      build: () => undefined,
      execute: () => ({ authoritativeBytes: bytes("partial"), complete: false }),
    });
    expect(() => cache.put("partial", incomplete)).toThrow(/三次确定性复检/);

    let telemetry = 0;
    const complete = await runCandidateGate({
      build: () => undefined,
      execute: () => ({ authoritativeBytes: bytes({ score: 7, promote: true }), complete: true, telemetry: { cpuUsec: ++telemetry } }),
    });
    const stored = cache.put("complete", complete);
    expect(cache.get("complete")).toEqual(stored);
    stored.authoritativeBytes[0] = 0;
    expect(cache.get("complete")?.authoritativeBytes[0]).not.toBe(0);
  });

  it("缓存键覆盖全部冻结身份字段，任一变化都会失配", () => {
    const input: EvaluationCacheKeyInput = {
      engineVersion: "engine-1", protocolVersion: 1, scoringVersion: "score-1", rulesDigest: "rules",
      candidateCommit: "candidate", championCommit: "champion", opponentCommit: "opponent",
      seeds: ["a", "b"], imageDigest: "image", resourcePolicyDigest: "resource",
    };
    const baseline = createEvaluationCacheKey(input);
    for (const [key, value] of Object.entries(input)) {
      const changed = { ...input, [key]: Array.isArray(value) ? [...value, "c"] : typeof value === "number" ? value + 1 : `${value}-changed` };
      expect(createEvaluationCacheKey(changed as EvaluationCacheKeyInput)).not.toBe(baseline);
    }
  });
});
