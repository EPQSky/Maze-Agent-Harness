import type { EvolutionRole } from "@maze-arena/contracts";
import type { ExperimentRuntimeRepository } from "@maze-arena/control-plane";
import type { AuditRepository } from "./audit-repository.js";
import type { AutonomousUsageBudget } from "./autonomous-runner.js";
import { HarnessInvocationError } from "./harness-invocation-error.js";

export function reconcileProviderUsageItems(input: {
  runtime: ExperimentRuntimeRepository;
  audits: AuditRepository;
  usageBudget?: AutonomousUsageBudget;
  experimentId: string;
  generation: number;
  role: EvolutionRole;
  auditDetails?: Record<string, unknown>;
}): void {
  try {
    reconcileFromLedger(input);
  } catch (error) {
    if (error instanceof HarnessInvocationError && error.usageLedgerBacked) throw error;
    throw new HarnessInvocationError("Provider usage item 恢复失败", "process", undefined, undefined,
      "PROVIDER_USAGE_RECONCILIATION_FAILED", undefined, true);
  }
}

function reconcileFromLedger(input: {
  runtime: ExperimentRuntimeRepository;
  audits: AuditRepository;
  usageBudget?: AutonomousUsageBudget;
  experimentId: string;
  generation: number;
  role: EvolutionRole;
  auditDetails?: Record<string, unknown>;
}): void {
  let rejectedUsage: { tokens: number; cost: number; modelCalls: number } | undefined;
  for (const item of input.runtime.listPendingProviderUsageItems(
    input.experimentId, input.generation, input.role,
  )) {
    if (!item.modelCallsAccounted && !input.runtime.accountProviderUsageItemModelCalls(item.itemId)) {
      throw new HarnessInvocationError("Provider usage item 缺少可恢复的模型调用结算", "protocol", item,
        undefined, "PROVIDER_MODEL_CALL_ACCOUNTING_INCOMPLETE", undefined, true);
    }
    let canaryAccepted = item.canaryAccepted;
    if (!item.canaryAccounted) {
      canaryAccepted = input.usageBudget
        ? input.usageBudget.consumeOnce?.(item.itemId, item) ?? input.usageBudget.consume(item)
        : true;
      input.runtime.markProviderUsageItemCanaryAccounted(item.itemId, canaryAccepted);
    }
    if (canaryAccepted === false) {
      rejectedUsage ??= { tokens: 0, cost: 0, modelCalls: 0 };
      rejectedUsage.tokens += item.tokens;
      rejectedUsage.cost += item.cost;
      rejectedUsage.modelCalls += item.modelCalls;
    }
    if (!item.auditAccounted) {
      input.audits.appendOnce(`provider-usage:${item.itemId}`, input.experimentId, "harness.activity", {
        ...(input.auditDetails ?? item.auditDetails),
        usageTokens: item.tokens,
        usageCost: item.cost,
        usageModelCalls: item.modelCalls,
      });
      input.runtime.markProviderUsageItemAuditAccounted(item.itemId);
    }
    if (!item.runtimeAccounted) input.runtime.accountProviderUsageItemRuntime(item.itemId);
  }
  if (rejectedUsage) {
    throw new HarnessInvocationError("金丝雀提供方调用超过剩余硬预算", "provider", rejectedUsage,
      undefined, "CANARY_USAGE_LIMIT_EXCEEDED", undefined, true);
  }
}
