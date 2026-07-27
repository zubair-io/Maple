import { describe, expect, it } from 'bun:test';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { workerEnrichmentFingerprint } from './enrichment-config-refresh.ts';

describe('worker enrichment config refresh', () => {
  it('invalidates worker caches when any search or shared Ollama setting changes', () => {
    const base = resolveEnrichmentConfig(null, {});
    const fingerprint = workerEnrichmentFingerprint(base);
    const changes = [
      { describe_provider_url: 'http://ollama.internal:11434' },
      { meilisearch_url: 'http://meili.internal:7700' },
      { meilisearch_api_key: 'new-secret' },
      { meilisearch_semantic_enabled: true },
      { meilisearch_embedder_model: 'snowflake-arctic-embed2' },
      { meilisearch_semantic_ratio: 0.7 },
      { meilisearch_task_timeout_seconds: 900 },
    ];

    for (const change of changes) {
      expect(workerEnrichmentFingerprint({ ...base, ...change })).not.toBe(fingerprint);
    }
  });

  it('does not rebuild search clients for unrelated enrichment settings', () => {
    const base = resolveEnrichmentConfig(null, {});
    expect(
      workerEnrichmentFingerprint({
        ...base,
        face_min_detection_size: base.face_min_detection_size + 0.01,
      }),
    ).toBe(workerEnrichmentFingerprint(base));
  });
});
