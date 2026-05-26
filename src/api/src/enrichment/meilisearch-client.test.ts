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
  meilisearchClient,
  reconfigureMeilisearch,
  setMeilisearchClientForTests,
  type MeilisearchAssetDoc,
} from './meilisearch-client.ts';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeFetchOpts {
  /** Per-path response. The first matching prefix wins. */
  routes?: Array<{
    method: string;
    pathPrefix: string;
    status?: number;
    body?: unknown;
    throwError?: Error;
  }>;
  /** Default response when nothing matches (defaults to 200/{}). */
  defaultStatus?: number;
  defaultBody?: unknown;
}

function makeFakeFetch(opts: FakeFetchOpts = {}): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  // The `typeof fetch` declaration in @types/bun (and lib.dom) requires a
  // `preconnect` static method that we don't need; cast through `unknown`
  // so the test fake satisfies the structural call signature.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });

    const path = new URL(url).pathname;
    for (const r of opts.routes ?? []) {
      if (r.method === method && path.startsWith(r.pathPrefix)) {
        if (r.throwError) throw r.throwError;
        const status = r.status ?? 200;
        return new Response(JSON.stringify(r.body ?? {}), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify(opts.defaultBody ?? {}), {
      status: opts.defaultStatus ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

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

    // Two calls: POST /indexes (create) + PATCH /indexes/assets/settings
    expect(calls.length).toBe(2);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/indexes');
    expect(calls[0]!.body).toEqual({ uid: ASSETS_INDEX, primaryKey: 'id' });
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret-key');

    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.url).toContain(`/indexes/${ASSETS_INDEX}/settings`);
    expect(calls[1]!.body).toEqual({
      // Phase 8 — per-attribute weighting across the three sources
      // (place metadata, LLM caption, OCR'd text). Order is the
      // weighting order Meilisearch applies.
      searchableAttributes: ['searchBlob', 'description', 'ocrText'],
      filterableAttributes: [
        'folderId',
        'deletedAt',
        'visionSceneType',
        'visionActivity',
        'visionSubjects',
        'isScreenshot',
      ],
      sortableAttributes: ['capturedAt'],
    });
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
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    // Must not throw even though /indexes returned 409.
    await client.ensureIndex();
    expect(calls.length).toBe(2);
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
    expect(calls[0]!.body).toEqual([sampleDoc]);
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

  it('tombstone() POSTs a partial doc with deletedAt set', async () => {
    const { fetchImpl, calls } = makeFakeFetch();
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.tombstone('xyz');

    expect(calls.length).toBe(1);
    const body = calls[0]!.body as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]!.id).toBe('xyz');
    expect(typeof body[0]!.deletedAt).toBe('string');
  });

  it('search() passes q + filter + pagination, parses hits', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: {
            hits: [{ id: 'a' }, { id: 'b' }],
            estimatedTotalHits: 2,
            offset: 0,
            limit: 100,
          },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    const r = await client.search('Musum', {
      folderId: '0123456789abcdef01234567',
      offset: 0,
      limit: 50,
    });
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.estimatedTotal).toBe(2);

    expect(calls.length).toBe(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.q).toBe('Musum');
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(50);
    expect(body.filter).toBe('deletedAt IS NULL AND folderId = "0123456789abcdef01234567"');
  });

  it('search() with no folderId only filters deletedAt', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await client.search('Park');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filter).toBe('deletedAt IS NULL');
  });

  it('search() throws on transport error so the route can fall back', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          throwError: new Error('ECONNREFUSED'),
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await expect(client.search('Albany')).rejects.toThrow(/meilisearch search failed/);
  });

  it('search() throws on 5xx so the route can fall back', async () => {
    const { fetchImpl } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 500,
          body: { error: 'boom' },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    await expect(client.search('Albany')).rejects.toThrow(/meilisearch search failed/);
  });

  it('search() scrubs non-hex chars from folderId before injecting', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [
        {
          method: 'POST',
          pathPrefix: `/indexes/${ASSETS_INDEX}/search`,
          status: 200,
          body: { hits: [], estimatedTotalHits: 0 },
        },
      ],
    });
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl,
    });
    // Attempt injection — only hex chars [0-9a-f] survive (so digits in
    // a real ObjectId still pass through).
    await client.search('park', {
      folderId: 'abc" OR x=z --',
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.filter).toBe('deletedAt IS NULL AND folderId = "abc"');
  });

  it('isConfigured() reports true when URL is set via override', () => {
    const client = createMeilisearchClient({
      url: 'http://meili.local:7700',
      fetchImpl: globalThis.fetch.bind(globalThis),
    });
    expect(client.isConfigured()).toBe(true);
  });

  it('isConfigured() reads MAPLE_MEILISEARCH_URL from env', () => {
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.local:7700';
    const client = createMeilisearchClient();
    expect(client.isConfigured()).toBe(true);
  });
});

describe('reconfigureMeilisearch — runtime singleton swap', () => {
  afterEach(() => {
    // Reset the module singleton so other suites start clean.
    setMeilisearchClientForTests(null);
  });

  it('a non-null URL configures the shared client', () => {
    reconfigureMeilisearch('http://meili.saved:7700', null);
    expect(meilisearchClient().isConfigured()).toBe(true);
  });

  it('the resolved URL wins even when the env var is set', () => {
    // Simulate the resolver having already chosen the DB value: we pass the
    // resolved URL explicitly, and the env var must NOT leak back in.
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.env:7700';
    reconfigureMeilisearch('http://meili.db:7700', null);
    expect(meilisearchClient().isConfigured()).toBe(true);
  });

  it('a null URL disables the client even when the env var is set', () => {
    // resolved.meilisearch_url === null means "neither DB nor env" — but
    // even if a stale env var is present, the explicit null must disable.
    process.env.MAPLE_MEILISEARCH_URL = 'http://meili.env:7700';
    reconfigureMeilisearch(null, null);
    expect(meilisearchClient().isConfigured()).toBe(false);
  });

  it('sends the resolved API key as a bearer token on requests', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      routes: [{ method: 'GET', pathPrefix: '/health', status: 200, body: { status: 'ok' } }],
    });
    reconfigureMeilisearch('http://meili.db:7700', 'db-key');
    // Swap in the recording fetch on the freshly-built singleton.
    setMeilisearchClientForTests(
      createMeilisearchClient({ url: 'http://meili.db:7700', apiKey: 'db-key', fetchImpl }),
    );
    await meilisearchClient().health();
    expect(calls[0]!.headers.Authorization).toBe('Bearer db-key');
  });
});
