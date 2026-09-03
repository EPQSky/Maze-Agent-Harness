import { createHash } from "node:crypto";

export interface OpponentVersion {
  commit: string;
  category: "baseline" | "champion" | "recent" | "historical";
}

export interface HistoricalResult {
  opponentCommit: string;
  primaryMetric: number;
}

export function buildActiveOpponentPool(options: {
  baseline: string;
  champion: string;
  recentChampions: readonly string[];
  historicalResults: readonly HistoricalResult[];
}): OpponentVersion[] {
  const selected: OpponentVersion[] = [];
  addUnique(selected, options.baseline, "baseline");
  addUnique(selected, options.champion, "champion");
  let recentAdded = 0;
  for (const commit of options.recentChampions) {
    if (selected.some((entry) => entry.commit === commit)) continue;
    addUnique(selected, commit, "recent");
    recentAdded += 1;
    if (recentAdded === 2) break;
  }
  const historical = [...options.historicalResults]
    .sort((left, right) => left.primaryMetric - right.primaryMetric || left.opponentCommit.localeCompare(right.opponentCommit));
  let historicalAdded = 0;
  for (const result of historical) {
    if (selected.length >= 6 || historicalAdded === 2) break;
    const before = selected.length;
    addUnique(selected, result.opponentCommit, "historical");
    if (selected.length > before) historicalAdded += 1;
  }
  return selected.slice(0, 6);
}

function addUnique(pool: OpponentVersion[], commit: string, category: OpponentVersion["category"]): void {
  if (commit && !pool.some((entry) => entry.commit === commit)) pool.push({ commit, category });
}

export interface GenerationEvaluationCase {
  id: string;
  seed: string;
  visibility: "public" | "hidden";
  opponentCommit: string;
}

export function createGenerationEvaluationPlan(options: {
  experimentId: string;
  role: "generator" | "solver";
  generation: number;
  opponents: readonly OpponentVersion[];
}): GenerationEvaluationCase[] {
  if (options.opponents.length === 0) throw new Error("实际对手池不能为空");
  const opponents = [...options.opponents].sort((left, right) => left.commit.localeCompare(right.commit));
  const make = (visibility: "public" | "hidden", count: number): GenerationEvaluationCase[] => Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const generationPart = visibility === "hidden" ? `:g${options.generation}` : "";
    const material = `${options.experimentId}:${options.role}${generationPart}:${visibility}:${ordinal}`;
    const seed = createHash("sha256").update(material).digest("hex");
    return {
      id: `${visibility}-${String(ordinal).padStart(2, "0")}`,
      seed,
      visibility,
      opponentCommit: opponents[index % opponents.length]!.commit,
    };
  });
  return [...make("public", 8), ...make("hidden", 24)];
}

export function requiresFullHistoryRegression(generation: number): boolean {
  return generation > 0 && generation % 5 === 0;
}

export function historyRegressionPassed(groups: readonly { opponentCommit: string; candidatePublicPrimary: number; championPublicPrimary: number }[]): boolean {
  return groups.every(({ candidatePublicPrimary, championPublicPrimary }) => candidatePublicPrimary >= championPublicPrimary);
}

export function generatorDiversityPassed(topologyHashes: readonly string[]): boolean {
  return topologyHashes.length === 32 && new Set(topologyHashes).size >= 29;
}
