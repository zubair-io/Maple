import { describe, expect, it } from 'bun:test';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { workerEnrichmentFingerprint } from './enrichment-config-refresh.ts';

describe('worker enrichment config refresh', () => {
  it('invalidates worker caches when any describe or provider setting changes', () => {
    const base = resolveEnrichmentConfig(null, {});
    const fingerprint = workerEnrichmentFingerprint(base);
    const changes = [
      { describe_provider: 'openai' as const },
      { describe_model: 'gpt-4o' },
      { describe_system_prompt: 'Custom prompt text' },
      { openai_api_key: 'sk-proj-test' },
      { anthropic_api_key: 'sk-ant-test' },
      { gemini_api_key: 'AIzaSyTest' },
      { describe_provider_url: 'http://ollama.internal:11434' },
    ];

    for (const change of changes) {
      expect(workerEnrichmentFingerprint({ ...base, ...change })).not.toBe(fingerprint);
    }
  });

  it('does not re-apply the worker config for unrelated enrichment settings', () => {
    const base = resolveEnrichmentConfig(null, {});
    expect(
      workerEnrichmentFingerprint({
        ...base,
        face_min_detection_size: base.face_min_detection_size + 0.01,
      }),
    ).toBe(workerEnrichmentFingerprint(base));
  });
});
