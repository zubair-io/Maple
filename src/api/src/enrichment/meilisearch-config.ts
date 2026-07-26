/** Semantic-search defaults shared by persistence, runtime, and status surfaces. */
export const DEFAULT_MEILISEARCH_SEMANTIC_ENABLED = false;
export const DEFAULT_MEILISEARCH_EMBEDDER_URL = 'http://localhost:11434';
export const DEFAULT_MEILISEARCH_EMBEDDER_MODEL = 'bge-m3';
export const DEFAULT_MEILISEARCH_SEMANTIC_RATIO = 0.5;

export function validMeilisearchSemanticRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
