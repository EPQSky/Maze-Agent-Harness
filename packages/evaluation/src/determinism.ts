import { createHash } from "node:crypto";
import type { EvaluationTelemetry } from "./index.js";

export const candidateGateFailureReasons = [
  "build-failed",
  "protocol-failed",
  "illegal-output",
  "resource-limit",
  "nondeterministic",
  "infrastructure-failed",
] as const;

export type CandidateGateFailureReason = (typeof candidateGateFailureReasons)[number];
export type CandidateExecutionFailure = Exclude<CandidateGateFailureReason, "build-failed" | "nondeterministic">;

export interface DeterminismPerturbation {
  repetition: number;
  startDelayMs: number;
  schedulerJitter: number;
}

export interface CandidateExecutionResult {
  authoritativeBytes: Uint8Array;
  telemetry?: EvaluationTelemetry;
  complete: boolean;
}

export interface CandidateGateAdapter {
  build(): void | Promise<void>;
  execute(perturbation: DeterminismPerturbation): CandidateExecutionResult | Promise<CandidateExecutionResult>;
}

export class CandidateGateError extends Error {
  constructor(public readonly reason: CandidateExecutionFailure, message: string) {
    super(message);
    this.name = "CandidateGateError";
  }
}

export interface CandidateGateResult {
  passed: boolean;
  reason: CandidateGateFailureReason | null;
  successfulRepetitions: number;
  infrastructureRetries: number;
  authoritativeBytes?: Uint8Array;
  authoritativeDigest?: string;
}

const perturbations: readonly DeterminismPerturbation[] = [
  { repetition: 1, startDelayMs: 0, schedulerJitter: 3 },
  { repetition: 2, startDelayMs: 17, schedulerJitter: 11 },
  { repetition: 3, startDelayMs: 43, schedulerJitter: 23 },
];

export async function runCandidateGate(adapter: CandidateGateAdapter): Promise<CandidateGateResult> {
  try { await adapter.build(); }
  catch { return failed("build-failed", 0, 0); }

  let infrastructureRetries = 0;
  const successful: Uint8Array[] = [];
  for (const perturbation of perturbations) {
    for (;;) {
      try {
        const result = await adapter.execute(perturbation);
        if (!result.complete) return failed("protocol-failed", successful.length, infrastructureRetries);
        successful.push(Uint8Array.from(result.authoritativeBytes));
        break;
      } catch (error) {
        if (!(error instanceof CandidateGateError)) throw error;
        if (error.reason !== "infrastructure-failed") return failed(error.reason, successful.length, infrastructureRetries);
        if (infrastructureRetries >= 2) return failed("infrastructure-failed", successful.length, infrastructureRetries);
        infrastructureRetries += 1;
      }
    }
  }
  const baseline = successful[0]!;
  if (!successful.every((bytes) => bytesEqual(bytes, baseline))) {
    return failed("nondeterministic", successful.length, infrastructureRetries);
  }
  return {
    passed: true,
    reason: null,
    successfulRepetitions: successful.length,
    infrastructureRetries,
    authoritativeBytes: baseline,
    authoritativeDigest: sha256(baseline),
  };
}

function failed(reason: CandidateGateFailureReason, successfulRepetitions: number, infrastructureRetries: number): CandidateGateResult {
  return { passed: false, reason, successfulRepetitions, infrastructureRetries };
}

export interface EvaluationCacheKeyInput {
  engineVersion: string;
  protocolVersion: number;
  scoringVersion: string;
  rulesDigest: string;
  candidateCommit: string;
  championCommit: string;
  opponentCommit: string;
  seeds: readonly string[];
  imageDigest: string;
  resourcePolicyDigest: string;
}

export function createEvaluationCacheKey(input: EvaluationCacheKeyInput): string {
  const canonical = JSON.stringify({
    engineVersion: input.engineVersion,
    protocolVersion: input.protocolVersion,
    scoringVersion: input.scoringVersion,
    rulesDigest: input.rulesDigest,
    candidateCommit: input.candidateCommit,
    championCommit: input.championCommit,
    opponentCommit: input.opponentCommit,
    seeds: [...input.seeds],
    imageDigest: input.imageDigest,
    resourcePolicyDigest: input.resourcePolicyDigest,
  });
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface CachedEvaluation {
  authoritativeBytes: Uint8Array;
  authoritativeDigest: string;
}

export class DeterministicEvaluationCache {
  private readonly entries = new Map<string, CachedEvaluation>();

  get(key: string): CachedEvaluation | undefined {
    const entry = this.entries.get(key);
    return entry ? cloneCached(entry) : undefined;
  }

  put(key: string, gate: CandidateGateResult): CachedEvaluation {
    if (!gate.passed || !gate.authoritativeBytes || !gate.authoritativeDigest || gate.successfulRepetitions < 3) {
      throw new Error("只有完整通过三次确定性复检的权威结果可以写入缓存");
    }
    const entry = { authoritativeBytes: Uint8Array.from(gate.authoritativeBytes), authoritativeDigest: gate.authoritativeDigest };
    this.entries.set(key, entry);
    return cloneCached(entry);
  }

  size(): number { return this.entries.size; }
}

function cloneCached(entry: CachedEvaluation): CachedEvaluation {
  return { authoritativeBytes: Uint8Array.from(entry.authoritativeBytes), authoritativeDigest: entry.authoritativeDigest };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
