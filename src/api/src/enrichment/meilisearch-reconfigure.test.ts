import { afterEach, describe, expect, it } from 'bun:test';
import {
  createMeilisearchClient,
  meilisearchClient,
  reconfigureMeilisearch,
  setMeilisearchClientForTests,
  type MeilisearchRuntimeSettings,
} from './meilisearch-client.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

const priorUrl = process.env.MAPLE_MEILISEARCH_URL;

function runtimeSettings(
  overrides: Partial<MeilisearchRuntimeSettings> = {},
): MeilisearchRuntimeSettings {
  return {
    url: null,
    apiKey: null,
    taskTimeoutMs: 600_000,
    semanticEnabled: false,
    embedderUrl: 'http://localhost:11434',
    embedderModel: 'bge-m3',
    semanticRatio: 0.5,
    ...overrides,
  };
}

describe('reconfigureMeilisearch — runtime singleton swap', () => {
  afterEach(() => {
    setMeilisearchClientForTests(null);
    if (priorUrl === undefined) delete process.env.MAPLE_MEILISEARCH_URL;
    else process.env.MAPLE_MEILISEARCH_URL = priorUrl;
  });

  it('a non-null URL configures the shared client', () => {
    reconfigureMeilisearch(runtimeSettings({ url: 'http://meili.saved:7700' }));
    expect(meilisearchClient().isConfigured()).toBe(true);
  });

  it('reuses the cached runtime client instead of resolving settings per search', () => {
    reconfigureMeilisearch(runtimeSettings({ url: 'http://meili.saved:7700' }));
    expect(meilisearchClient()).toBe(meilisearchClient());
  });

  it('uses the resolved URL instead of a stale environment value', () => {
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.env:7700';
    reconfigureMeilisearch(runtimeSettings({ url: 'http://meili.db:7700' }));
    expect(meilisearchClient().isConfigured()).toBe(true);
  });

  it('a null resolved URL disables the client', () => {
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.env:7700';
    reconfigureMeilisearch(runtimeSettings());
    expect(meilisearchClient().isConfigured()).toBe(false);
  });

  it('applies DB-backed semantic settings during the runtime swap', () => {
    reconfigureMeilisearch(
      runtimeSettings({
        url: 'http://meili.db:7700',
        semanticEnabled: true,
        embedderUrl: 'http://ollama.db:11434',
        semanticRatio: 0.7,
      }),
    );
    expect(meilisearchClient().semanticConfigured()).toBe(true);
  });

  it('sends the resolved API key as a bearer token on requests', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [{ method: 'GET', pathPrefix: '/health', status: 200, body: { status: 'ok' } }],
    });
    setMeilisearchClientForTests(
      createMeilisearchClient({ url: 'http://meili.db:7700', apiKey: 'db-key', fetchImpl }),
    );
    await meilisearchClient().health();
    expect(calls[0]!.headers.Authorization).toBe('Bearer db-key');
  });
});
