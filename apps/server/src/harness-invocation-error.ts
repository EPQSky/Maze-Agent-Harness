import type { HarnessExecutionIdentity, HarnessUsage } from "@maze-arena/dsh-integration";

export type HarnessInvocationFailureKind = "transient-provider" | "provider" | "protocol" | "cancelled" | "timeout" | "process";

export interface HarnessFailureFacts {
  status?: number;
  requestId?: string;
  messageFingerprint?: string;
  wireCode?: number | string;
  dataType?: "null" | "string" | "number" | "boolean" | "object" | "array";
  dataCode?: number | string;
  dataRequestId?: string;
  dataStatus?: number;
  dataFingerprint?: string;
}

export interface HarnessLocalFailureFacts {
  stage?: string;
  errorType?: string;
  messageFingerprint?: string;
  stackFingerprint?: string;
}

export interface HarnessLocalFailureSummary extends HarnessLocalFailureFacts {
  code: string;
}

/** 仅保留用于定位 DSH 故障的去敏事件摘要，不保存原始 prompt、响应或 stderr。 */
export interface HarnessDiagnosticSummary {
  modelCalls: number;
  eventCounts: Readonly<Record<string, number>>;
  turnEnds: readonly {
    turn: number | null;
    kind: string | null;
    errorCode: string | null;
    failureFacts?: HarnessFailureFacts;
  }[];
  toolNames: readonly string[];
  requestContext?: {
    provider: string;
    model: string;
    contextWindow: number | null;
  };
  errorCode: string | null;
  failureFacts?: HarnessFailureFacts;
  localFailureCode: string | null;
  localFailure?: HarnessLocalFailureSummary;
  cleanupErrorCode: string | null;
  stderrBytes: number;
}

export class HarnessInvocationError extends Error {
  readonly code?: string;

  constructor(
    message: string,
    readonly kind: HarnessInvocationFailureKind,
    readonly usage?: HarnessUsage,
    readonly execution?: HarnessExecutionIdentity,
    code?: string,
    readonly attemptedModelCalls?: number,
    readonly usageLedgerBacked = false,
    readonly diagnostic?: HarnessDiagnosticSummary,
    readonly failureFacts?: HarnessFailureFacts,
  ) {
    super(message);
    this.name = "HarnessInvocationError";
    this.code = code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
  }
}
