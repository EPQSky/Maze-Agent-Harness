import type { GenerationRoleResult } from "@maze-arena/contracts";

type PublicTraces = NonNullable<GenerationRoleResult["trustedPublicTraces"]>;

export class CandidateEvaluationFacts {
  publicProgress = 0;
  hiddenProgress = 0;
  outcome: GenerationRoleResult["outcome"] = "failed";
  aggregate: Record<string, number> = {};
  hiddenCandidateAggregate: Record<string, number> = {};
  publicTraces: PublicTraces = [];
  diagnostics: string[] = [];

  beginRepairAttempt(): void {
    this.publicProgress = 0;
    this.hiddenProgress = 0;
    this.outcome = "failed";
    this.aggregate = {};
    this.hiddenCandidateAggregate = {};
    this.publicTraces = [];
    this.diagnostics = [];
  }

  recordPublicSuccess(input: {
    caseCount: number;
    aggregate: Readonly<Record<string, number>>;
    traces: PublicTraces;
    regressed: boolean;
  }): string[] {
    this.publicProgress = input.caseCount;
    this.aggregate = { ...input.aggregate };
    this.publicTraces = structuredClone(input.traces);
    this.diagnostics = input.regressed ? ["PUBLIC_PRIMARY_REGRESSION"] : [];
    return [...this.diagnostics];
  }

  recordPublicFailure(): string[] {
    this.diagnostics = ["PUBLIC_GATE_FAILED"];
    return [...this.diagnostics];
  }

  recordHiddenSuccess(input: {
    caseCount: number;
    outcome: GenerationRoleResult["outcome"];
    aggregate: Readonly<Record<string, number>>;
    hiddenCandidateAggregate: Readonly<Record<string, number>>;
  }): void {
    this.hiddenProgress = input.caseCount;
    this.outcome = input.outcome;
    this.aggregate = { ...input.aggregate };
    this.hiddenCandidateAggregate = { ...input.hiddenCandidateAggregate };
  }

  recordHiddenFailure(): void {
    this.outcome = "failed";
    this.diagnostics = [...this.diagnostics, "HIDDEN_EVALUATION_FAILED"];
  }
}
