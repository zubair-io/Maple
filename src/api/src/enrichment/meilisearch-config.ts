/** Semantic-search defaults shared by persistence, runtime, and status surfaces. */
export const DEFAULT_MEILISEARCH_SEMANTIC_ENABLED = false;
export const DEFAULT_MEILISEARCH_EMBEDDER_URL = 'http://localhost:11434';
export const DEFAULT_MEILISEARCH_EMBEDDER_MODEL = 'bge-m3';
/**
 * Hybrid blend: 0 = pure keyword, 1 = pure vector.
 *
 * 0.5 confirmed by measurement, not inherited by default (#2384). Swept
 * 0.3-0.9 against `tests/fixtures/search-relevance/` on Meilisearch 1.51.0 +
 * bge-m3: ratios at or below 0.5 all score Recall@10 1.0000 / MRR 0.7407,
 * while 0.6 and above drop to MRR 0.6296 AND regress two hard guards — exact
 * filename falls from rank 1 to 2, named-person from 1 to 3. There is no
 * upside above 0.5 to trade for that, so more semantic weight is not a lever.
 * Operators can still override per-deployment via Settings → Workers.
 */
export const DEFAULT_MEILISEARCH_SEMANTIC_RATIO = 0.5;

export function validMeilisearchSemanticRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
