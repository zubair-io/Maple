/**
 * Ranking-quality metrics for the search relevance gate (#2384).
 *
 * Pure and dependency-free so they run in CI without a Meilisearch sidecar;
 * the env-gated integration harness (`tests/search-relevance.integration.test.ts`)
 * feeds them real result orders.
 */

/** Fraction of the labelled-relevant ids that appear in the top `k` results.
 * An unlabelled query returns 1; scoreRankings excludes it from aggregates. */
export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** Reciprocal rank of the FIRST relevant hit; 0 when none is present. */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const relevantSet = new Set(relevant);
  const index = ranked.findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Mean of `reciprocalRank` across an evaluation set. */
export function meanReciprocalRank(
  perQuery: Array<{ ranked: string[]; relevant: string[] }>,
): number {
  if (perQuery.length === 0) return 0;
  const total = perQuery.reduce((sum, q) => sum + reciprocalRank(q.ranked, q.relevant), 0);
  return total / perQuery.length;
}

/** Report-only observations have no relevance labels and cannot score as misses (#3965). */
export function scoreRankings(perQuery: Array<{ ranked: string[]; relevant: string[] }>): {
  recallAt10: number;
  mrr: number;
  evaluatedQueries: number;
} {
  const labelled = perQuery.filter((query) => query.relevant.length > 0);
  if (labelled.length === 0) throw new Error('No labelled queries to evaluate');
  return {
    recallAt10:
      labelled.reduce((sum, query) => sum + recallAtK(query.ranked, query.relevant, 10), 0) /
      labelled.length,
    mrr: meanReciprocalRank(labelled),
    evaluatedQueries: labelled.length,
  };
}
