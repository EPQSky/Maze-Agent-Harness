import type { HarnessExecutionIdentity } from "@maze-arena/dsh-integration";

export type HarnessInvocationFailureKind = "transient-provider" | "provider" | "protocol" | "cancelled" | "timeout" | "process";

export class HarnessInvocationError extends Error {
  constructor(
    message: string,
    readonly kind: HarnessInvocationFailureKind,
    readonly usage?: { tokens: number; cost: number },
    readonly execution?: HarnessExecutionIdentity,
  ) {
    super(message);
    this.name = "HarnessInvocationError";
  }
}
