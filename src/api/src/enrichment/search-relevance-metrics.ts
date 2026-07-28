/**
 * Ranking-quality metrics for the search relevance gate (#2384).
 *
 * Pure and dependency-free so they run in CI without a Meilisearch sidecar;
 * the env-gated integration harness (`tests/search-relevance.integration.test.ts`)
 * feeds them real result orders.
 */

/** Fraction of the labelled-relevant ids that appear in the top `k` results.
 * An unlabelled query is vacuously satisfied (returns 1) so a corpus entry
 * carrying no labels — an observation owned by another ticket, say — never
 * drags the aggregate down. */
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
