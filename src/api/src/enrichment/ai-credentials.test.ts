import { describe, expect, it } from 'bun:test';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';

describe('AI credential precedence', () => {
  it('uses deployment keys only when no credential has been configured', () => {
    const base = { nominatim_url: null, geocode_worker_enabled: false };
    const env = { MAPLE_OPENAI_API_KEY: 'test-deployment-key' };
    expect(resolveEnrichmentConfig(null, env).openai_api_key).toBe('test-deployment-key');
    expect(
      resolveEnrichmentConfig({ ...base, openai_api_key: ' test-saved-key ' }, env).openai_api_key,
    ).toBe('test-saved-key');
    expect(
      resolveEnrichmentConfig({ ...base, openai_api_key: null }, env).openai_api_key,
    ).toBeNull();
    expect(resolveEnrichmentConfig({ ...base, openai_api_key: '' }, env).openai_api_key).toBeNull();
  });
});
