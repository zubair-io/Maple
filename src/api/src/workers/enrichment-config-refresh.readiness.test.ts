// The worker's readiness pass against a drifted Meilisearch embedder (#4432):
// it must never PATCH the embedder, and must carry vector coverage forward
// only once the live embedder matches Settings.
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as describeBootstrap from '../enrichment/describe-bootstrap.ts';
import * as configRepo from '../enrichment/enrichment-config.repo.ts';
import type { EnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { setMeilisearchClientForTests } from '../enrichment/meilisearch-client.ts';
import { assetsIndexSettings } from '../enrichment/meilisearch-index-settings.ts';
import { fakeMeilisearchIndex } from '../enrichment/meilisearch-test-harness.ts';
import * as coverage from '../enrichment/meilisearch-vector-coverage.ts';
import { refreshWorkerEnrichmentConfig } from './enrichment-config-refresh.ts';

const config: EnrichmentConfig = {
  nominatim_url: null,
  geocode_worker_enabled: false,
  meilisearch_url: 'http://meili.local:7700',
  meilisearch_semantic_enabled: true,
};
const configuredUrl = resolveEnrichmentConfig(config).meilisearch_embedder_url;

function indexEmbeddingWith(embedderUrl: string) {
  return fakeMeilisearchIndex(
    assetsIndexSettings({ semantic: true, embedderUrl, embedderModel: 'bge-m3' }, 'caption'),
    { documents: 335_000 },
  );
}

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setMeilisearchClientForTests(null);
});

function stub(meili: ReturnType<typeof fakeMeilisearchIndex>): string[][] {
  const advanced: string[][] = [];
  spies.push(
    spyOn(configRepo, 'loadEnrichmentConfig').mockImplementation(async () => config),
    spyOn(describeBootstrap, 'applyDescribeConfig').mockImplementation(async () => {}),
    spyOn(globalThis, 'fetch').mockImplementation(meili.fetchImpl),
    spyOn(coverage, 'advanceKnownVectorCoverage').mockImplementation(async (fingerprint) => {
      advanced.push([String(fingerprint)]);
    }),
    spyOn(coverage, 'advancePendingVectorCoverage').mockImplementation(async (fingerprint) => {
      advanced.push(['pending', String(fingerprint)]);
    }),
  );
  return advanced;
}

describe('worker readiness with a drifted embedder (#4432)', () => {
  it('leaves the embedder alone and does not carry coverage forward', async () => {
    const meili = indexEmbeddingWith('http://192.168.0.250:11434');
    const advanced = stub(meili);

    expect(await refreshWorkerEnrichmentConfig(true)).toBe(true);

    expect(meili.patches).toHaveLength(0);
    expect(advanced).toHaveLength(0);
  });

  it('carries coverage forward once the live embedder matches Settings', async () => {
    const meili = indexEmbeddingWith(configuredUrl);
    const advanced = stub(meili);

    await refreshWorkerEnrichmentConfig(true);

    expect(meili.patches).toHaveLength(0);
    // Same-shape markers carry forward, and rows written as pending while the
    // client was unconfirmed are promoted.
    expect(advanced).toHaveLength(2);
    expect(advanced[0]![0]).toStartWith('v');
    expect(advanced[1]).toEqual(['pending', advanced[0]![0]!]);
  });

  it('keeps going when Meilisearch is unreachable', async () => {
    const meili = indexEmbeddingWith(configuredUrl);
    const advanced = stub(meili);
    spies.push(
      spyOn(globalThis, 'fetch').mockImplementation((async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch),
    );

    await expect(refreshWorkerEnrichmentConfig(true)).resolves.toBe(true);
    expect(advanced).toHaveLength(0);
  });
});
