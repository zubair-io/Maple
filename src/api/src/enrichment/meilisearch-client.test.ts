/**
 * Unit tests for the Meilisearch client.
 *
 * No real Meilisearch instance is required — the client is constructed with
 * a fake `fetch` that records calls and replies with canned responses. We
 * also exercise the unconfigured path (URL unset → every method is a no-op).
 *
 * Reference: `docs/indexer-enrichment.md` §5.5 and Phase 7 brief.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  ASSETS_INDEX,
  createMeilisearchClient,
  type MeilisearchAssetDoc,
} from './meilisearch-client.ts';
import { makeFakeFetch } from './meilisearch-test-harness.ts';

const PRIOR_URL = process.env.MAPLE_MEILISEARCH_URL;
const PRIOR_KEY = process.env.MAPLE_MEILISEARCH_API_KEY;

beforeEach(() => {
  delete process.env.MAPLE_MEILISEARCH_URL;
  delete process.env.MAPLE_MEILISEARCH_API_KEY;
});

afterEach(() => {
  if (PRIOR_URL === undefined) delete process.env.MAPLE_MEILISEARCH_URL;
  else process.env.MAPLE_MEILISEARCH_URL = PRIOR_URL;
  if (PRIOR_KEY === undefined) delete process.env.MAPLE_MEILISEARCH_API_KEY;
  else process.env.MAPLE_MEILISEARCH_API_KEY = PRIOR_KEY;
});

const sampleDoc: MeilisearchAssetDoc = {
  id: 'abc123',
  searchBlob: 'albany ny museum',
  folderId: '0123456789abcdef01234567',
  capturedAt: '2024-06-01T12:00:00.000Z',
  deletedAt: null,
};

describe('Meilisearch client — unconfigured', () => {
  it('isConfigured() reports false when URL unset', () => {
    const client = createMeilisearchClient();
    expect(client.isConfigured()).toBe(false);
  });

  it('health() returns false without making any HTTP call', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({ url: undefined, fetchImpl });
    expect(await client.health()).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('ensureIndex/upsert/tombstone are silent no-ops without a URL', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({ url: undefined, fetchImpl });
    await client.ensureIndex();
    await client.upsert(sampleDoc);
    await client.tombstone('abc123');
    expect(calls.length).toBe(0);
  });

  it('search() returns an empty result without a URL', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({ url: undefined, fetchImpl });
    const r = await client.search('anything');
    expect(r.ids).toEqual([]);
    expect(r.estimatedTotal).toBe(0);
    expect(calls.length).toBe(0);
  });
});

describe('Meilisearch client — happy path with mocked fetch', () => {
  it('health() POSTs /health and returns true on 200', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/health',
          status: 200,
          body: { status: 'available' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    expect(await client.health()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://meili.local:7700/health');
    expect(calls[0]!.method).toBe('GET');
  });

  it('health() returns false on non-2xx without throwing', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/health',
          status: 503,
          body: { error: 'down' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    expect(await client.health()).toBe(false);
  });

  it('health() returns false on transport error', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'GET',
          pathPrefix: '/health',
          throwError: new Error('ECONNREFUSED'),
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    expect(await client.health()).toBe(false);
  });

  it('ensureIndex() creates the index AND patches settings', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      apiKey: 'secret-key',
      fetchImpl,
    });
    await client.ensureIndex();
    await client.ensureIndex();

    // The second ensure is cached. The first creates, reads, then patches.
    expect(calls.length).toBe(3);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/indexes');
    expect(calls[0]!.body).toEqual({ uid: ASSETS_INDEX, primaryKey: 'id' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret-key');

    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.url).toContain(`/indexes/${ASSETS_INDEX}/settings`);

    expect(calls[2]!.method).toBe('PATCH');
    expect(calls[2]!.url).toContain(`/indexes/${ASSETS_INDEX}/settings`);
    expect(calls[2]!.body).toEqual({
      embedders: null,
      searchableAttributes: ['filename', 'searchBlob', 'description', 'people', 'ocrText'],
      filterableAttributes: [
        'folderId',
        'deletedAt',
        'visionSceneType',
        'visionActivity',
        'visionSubjects',
        'isScreenshot',
        'people',
        'mediaType',
        'hidden',
      ],
      sortableAttributes: ['capturedAt'],
    });
    // Semantic switch OFF (default) — explicitly reset any previously
    // configured embedder; omission would preserve it on a settings PATCH.
    expect((calls[2]!.body as Record<string, unknown>).embedders).toBeNull();
    expect(calls.some((c) => c.url.includes('/experimental-features'))).toBe(false);
  });

  it('ensureIndex() registers the Ollama embedder without retired experimental flags', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
      embedderUrl: 'http://ollama.lan:11434',
      embedderModel: 'custom-embedder',
      semanticRatio: 0.6,
    });
    await client.ensureIndex();

    expect(calls.some((c) => c.url.includes('/experimental-features'))).toBe(false);

    const settings = calls.find((c) => c.method === 'PATCH' && c.url.includes('/settings'));
    expect(settings).toBeDefined();
    const embedders = (settings!.body as Record<string, unknown>).embedders as Record<
      string,
      Record<string, unknown>
    >;
    expect(embedders).toBeDefined();
    expect(embedders.caption.source).toBe('ollama');
    expect(embedders.caption.url).toBe('http://ollama.lan:11434/api/embed');
    expect(embedders.caption.model).toBe('custom-embedder');
    expect(typeof embedders.caption.documentTemplate).toBe('string');
    // searchable/filterable still carry the `people` attribute.
    const filt = (settings!.body as Record<string, unknown>).filterableAttributes as string[];
    expect(filt).toContain('people');
  });

  it('ensureIndex() waits for the async settings task before reporting ready', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: '/indexes',
          status: 409,
          body: { code: 'index_already_exists' },
        },
        {
          method: 'PATCH',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings`,
          status: 202,
          body: { taskUid: 12 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/12',
          body: { uid: 12, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
      semantic: true,
    });
    await client.ensureIndex();
    expect(calls.some((c) => c.url.includes('/tasks/12'))).toBe(true);
  });

  it('semanticConfigured() reflects the switch AND configured state', () => {
    const off = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl: globalThis.fetch.bind(globalThis),
      semantic: false,
    });
    expect(off.semanticConfigured()).toBe(false);
    const on = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl: globalThis.fetch.bind(globalThis),
      semantic: true,
    });
    expect(on.semanticConfigured()).toBe(true);
    const unconfigured = createMeilisearchClient({
      url: undefined,
      fetchImpl: globalThis.fetch.bind(globalThis),
      semantic: true,
    });
    expect(unconfigured.semanticConfigured()).toBe(false);
  });

  it('ensureIndex() tolerates an existing-index 4xx response', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: '/indexes',
          status: 409,
          body: {
            code: 'index_already_exists',
            message: 'Index `assets` already exists.',
          },
        },
        {
          method: 'PATCH',
          pathPrefix: `/indexes/${ASSETS_INDEX}/settings`,
          status: 202,
          body: { taskUid: 1 },
        },
        {
          method: 'GET',
          pathPrefix: '/tasks/1',
          body: { uid: 1, status: 'succeeded' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    // Must not throw even though /indexes returned 409.
    await client.ensureIndex();
    expect(calls.length).toBe(4);
  });

  it('upsert() POSTs the doc array to /indexes/assets/documents', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.upsert(sampleDoc);

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain(`/indexes/${ASSETS_INDEX}/documents`);
    // Docs are normalized with the embedder template-field defaults (#2369).
    expect(calls[0]!.body).toEqual([{ description: null, people: null, ...sampleDoc }]);
  });

  it('upsert() swallows errors (does not throw)', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/documents`,
          status: 500,
          body: { error: 'kaboom' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    // Should NOT throw — caller is fire-and-forget.
    await client.upsert(sampleDoc);
  });

  it('tombstone() POSTs a doc with deletedAt AND the embedder template fields', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.tombstone('xyz');

    expect(calls.length).toBe(1);
    const body = calls[0]!.body as Array<Record<string, unknown>>;
    // documentTemplate keys must be PRESENT — absence rejects the batch (#2369).
    expect(body[0]).toEqual({
      id: 'xyz',
      deletedAt: expect.any(String),
      searchBlob: '',
      description: null,
      people: null,
    });
  });
});
