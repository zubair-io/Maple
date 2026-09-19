/**
 * `POST /api/search/assets` — the service-API search surface.
 *
 * Meilisearch is mocked through `setMeilisearchClientForTests`; the database
 * fallback beneath it runs for real against SQLite, installed as the
 * process-wide handle for each test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { createServiceApiKey } from '../src/auth/service-api-keys.ts';
import { insertUser } from '../src/db/repos/auth.users.repo.ts';
import { saveEnrichmentConfig } from '../src/enrichment/enrichment-config.repo.ts';
import {
  MeilisearchSearchError,
  setMeilisearchClientForTests,
  type MeilisearchClient,
  type MeilisearchSearchOptions,
} from '../src/enrichment/meilisearch-client.ts';
import {
  _resetServiceSearchRateLimitsForTests,
  serviceAssetSearchRoutes,
} from '../src/routes/service-asset-search.ts';
import { seedSearchAsset } from '../src/db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;
let serviceKey = '';

function mockMeili(input: {
  semantic?: boolean;
  search: (
    query: string,
    options: MeilisearchSearchOptions,
    call: number,
  ) => ReturnType<MeilisearchClient['search']>;
}): MeilisearchClient & { calls: Array<{ query: string; options: MeilisearchSearchOptions }> } {
  const calls: Array<{ query: string; options: MeilisearchSearchOptions }> = [];
  return {
    calls,
    isConfigured: () => true,
    semanticConfigured: () => input.semantic ?? true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async (query, options = {}) => {
      calls.push({ query, options });
      return input.search(query, options, calls.length);
    },
  };
}

/** A Meilisearch client that reports itself unconfigured, forcing the
 * database fallback. */
function unconfiguredMeili(): MeilisearchClient {
  return {
    isConfigured: () => false,
    semanticConfigured: () => false,
    health: async () => false,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {},
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

function request(body: Record<string, unknown>, key = serviceKey): Promise<Response> {
  return new Elysia().use(serviceAssetSearchRoutes).handle(
    new Request('http://localhost/api/search/assets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/lib', slug: 'service-search' });
  // `created_by` is a foreign key onto `users`, so the owner exists first.
  const createdBy = await insertUser({
    email: 'owner@maple.test',
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  serviceKey = (await createServiceApiKey({ name: 'SugarMaple integration', createdBy })).key;
  _resetServiceSearchRateLimitsForTests();
  setMeilisearchClientForTests(null);
});

afterEach(() => {
  setMeilisearchClientForTests(null);
  live.close();
});

describe('POST /api/search/assets', () => {
  it('returns the concrete HVAC video from a hybrid conceptual query', async () => {
    const meili = mockMeili({
      search: async () => ({
        ids: ['010045ca68ac1f7f7e8b3aa02f72ac80', 'lexical-only'],
        estimatedTotal: 2,
        scores: { '010045ca68ac1f7f7e8b3aa02f72ac80': 0.97 },
      }),
    });
    setMeilisearchClientForTests(meili);

    const response = await request({
      query: 'HVAC air conditioning installation',
      filters: { mediaTypes: ['video'] },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      modeUsed: string;
      fallbackReason: string | null;
      results: Array<{ assetId: string; score: number | null }>;
    };
    expect(body.modeUsed).toBe('hybrid');
    expect(body.fallbackReason).toBeNull();
    expect(body.results[0]).toEqual({
      assetId: '010045ca68ac1f7f7e8b3aa02f72ac80',
      score: 0.97,
    });
    // A document without a vector/ranking score is retained rather than
    // silently disappearing during a partially complete vector backfill.
    expect(body.results[1]).toEqual({ assetId: 'lexical-only', score: null });
    expect(meili.calls[0]!.options).toMatchObject({
      semantic: true,
      mediaTypes: ['video'],
      includeHidden: false,
    });
  });

  it('passes an inclusive capture-date range to hybrid search', async () => {
    const meili = mockMeili({
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    });
    setMeilisearchClientForTests(meili);

    const response = await request({
      query: 'HVAC air conditioning installation',
      from: '2026-06-29',
      to: '2026-07-29',
    });

    expect(response.status).toBe(200);
    expect(meili.calls[0]!.options).toMatchObject({
      semantic: true,
      capturedFrom: '2026-06-29T00:00:00.000Z',
      capturedBefore: '2026-07-30T00:00:00.000Z',
    });
  });

  it('rejects invalid or reversed capture-date ranges', async () => {
    expect((await request({ query: 'HVAC', from: '2026-02-30' })).status).toBe(400);
    expect((await request({ query: 'HVAC', from: '2026-07-30', to: '2026-07-29' })).status).toBe(
      400,
    );
  });

  it('retries lexical search and reports the fallback when embedding fails', async () => {
    const meili = mockMeili({
      search: async (_query, options) => {
        if (options.semantic) {
          throw new MeilisearchSearchError(
            400,
            JSON.stringify({
              message: 'Cannot find embedder with name `caption`.',
              code: 'invalid_search_embedder',
              type: 'invalid_request',
            }),
          );
        }
        return {
          ids: ['010045ca68ac1f7f7e8b3aa02f72ac80'],
          estimatedTotal: 1,
        };
      },
    });
    setMeilisearchClientForTests(meili);

    const response = await request({ query: 'EL16K-P1' });
    const body = (await response.json()) as {
      modeUsed: string;
      fallbackReason: string | null;
      fallbackDetails: {
        status: number | null;
        code: string | null;
        type: string | null;
        message: string;
      } | null;
      results: Array<{ assetId: string }>;
    };
    expect(response.status).toBe(200);
    expect(body.modeUsed).toBe('lexical');
    expect(body.fallbackReason).toBe('semantic_embedder_unavailable');
    expect(body.fallbackDetails).toEqual({
      status: 400,
      code: 'invalid_search_embedder',
      type: 'invalid_request',
      message: 'Cannot find embedder with name `caption`.',
    });
    expect(body.results[0]!.assetId).toBe('010045ca68ac1f7f7e8b3aa02f72ac80');
    expect(meili.calls.map((call) => call.options.semantic)).toEqual([true, false]);
  });

  it('reports the lexical failure when hybrid and lexical Meilisearch queries both fail', async () => {
    const meili = mockMeili({
      search: async (_query, options) => {
        throw new MeilisearchSearchError(
          options.semantic ? 400 : 503,
          JSON.stringify(
            options.semantic
              ? {
                  message: 'Cannot find embedder with name `caption`.',
                  code: 'invalid_search_embedder',
                  type: 'invalid_request',
                }
              : {
                  message: 'Meilisearch is unavailable.',
                  code: 'service_unavailable',
                  type: 'internal',
                },
          ),
        );
      },
    });
    setMeilisearchClientForTests(meili);

    const response = await request({ query: 'fallback diagnostics' });
    const body = (await response.json()) as {
      modeUsed: string;
      fallbackReason: string | null;
      fallbackDetails: {
        status: number | null;
        code: string | null;
        type: string | null;
        message: string;
      } | null;
    };
    expect(response.status).toBe(200);
    expect(body.modeUsed).toBe('lexical');
    expect(body.fallbackReason).toBe('meilisearch_query_failed');
    expect(body.fallbackDetails).toEqual({
      status: 503,
      code: 'service_unavailable',
      type: 'internal',
      message: 'Meilisearch is unavailable.',
    });
    expect(meili.calls.map((call) => call.options.semantic)).toEqual([true, false]);
  });

  it('preserves exact filename search during the database fallback', async () => {
    seedSearchAsset(live.db, libraryId, {
      filename: 'IMG_4185.MOV',
      path: '',
      mapleId: '010045ca68ac1f7f7e8b3aa02f72ac80',
      mediaKind: 'video',
      capturedAt: null,
    });
    // The matching filename belongs to a stale location while another
    // location of the same asset is live. The exact-filename and liveness
    // predicates must match the same location row, so this asset must not
    // come back. It sits in its own directory because `asset_locations` is
    // unique on (library, path, filename) — two live copies of one name in
    // one directory is a state the schema rules out.
    const stale = seedSearchAsset(live.db, libraryId, {
      filename: 'IMG_4185.MOV',
      path: 'archive',
      mapleId: 'stale-filename',
      mediaKind: 'video',
      capturedAt: null,
      locationDeletedAt: '2026-01-01T00:00:00.000Z',
    });
    insertLocation(live.db, {
      assetId: stale,
      libraryId,
      ordinal: 1,
      path: '',
      filename: 'IMG_9999.MOV',
    });
    setMeilisearchClientForTests(unconfiguredMeili());

    const response = await request({ query: 'IMG_4185.MOV', mode: 'hybrid' });
    const body = (await response.json()) as {
      modeUsed: string;
      fallbackReason: string | null;
      results: Array<{ assetId: string; score: number | null; matchedBy?: string[] }>;
    };
    expect(response.status).toBe(200);
    expect(body.modeUsed).toBe('lexical');
    expect(body.fallbackReason).toBe('meilisearch_unavailable');
    expect(body.results).toEqual([
      {
        assetId: '010045ca68ac1f7f7e8b3aa02f72ac80',
        score: null,
        matchedBy: ['exact_filename'],
      },
    ]);
  });

  it('applies the capture-date range during the database fallback', async () => {
    // `captured_at` is a UTC ISO string, so the range is a lexicographic
    // compare. `undated` carries no capture date at all — NULL satisfies
    // neither bound, so it must fall out of a bounded window rather than
    // sorting below every string, and must still be reachable when no window
    // is given.
    for (const [mapleId, capturedAt] of [
      ['dated-2023', '2023-06-15T12:00:00.000Z'],
      ['dated-2024', '2024-06-15T12:00:00.000Z'],
      ['dated-2025', '2025-06-15T12:00:00.000Z'],
      ['undated', null],
    ] as Array<[string, string | null]>) {
      seedSearchAsset(live.db, libraryId, {
        filename: `${mapleId}.jpg`,
        path: '',
        mapleId,
        capturedAt,
      });
    }
    setMeilisearchClientForTests(unconfiguredMeili());

    const idsFor = async (range: Record<string, unknown>) => {
      const body = (await (await request({ query: 'dated-2024.jpg', ...range })).json()) as {
        results: Array<{ assetId: string }>;
      };
      return body.results.map((r) => r.assetId).sort();
    };

    // `to` is inclusive of the whole day, so 2024-12-31 admits 2024 only.
    expect(await idsFor({ from: '2024-01-01', to: '2024-12-31' })).toEqual(['dated-2024']);
    // Out-of-window: the exact-filename match must NOT survive the range.
    expect(await idsFor({ from: '2025-01-01' })).toEqual([]);
    expect(await idsFor({ to: '2023-12-31' })).toEqual([]);
    // Control — with no window the same query does find the asset, so the
    // empty results above are real exclusions, not a broken query.
    expect(await idsFor({})).toEqual(['dated-2024']);
  });

  it('rejects invalid credentials and whitespace-only queries', async () => {
    const invalid = await request({ query: 'HVAC' }, 'maple_sk_invalid');
    expect(invalid.status).toBe(401);

    const empty = await request({ query: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'query_must_not_be_empty' });
  });

  it('authenticates before validating the request body', async () => {
    const response = await new Elysia().use(serviceAssetSearchRoutes).handle(
      new Request('http://localhost/api/search/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(401);
  });

  it('reads the per-key request budget from persisted enrichment settings', async () => {
    await saveEnrichmentConfig({ service_search_rate_limit_per_minute: 1 });
    const meili = mockMeili({
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    });
    setMeilisearchClientForTests(meili);

    expect((await request({ query: 'first' })).status).toBe(200);
    const limited = await request({ query: 'second' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });

  it('accepts service-key authentication over plain HTTP on remote hosts', async () => {
    const response = await new Elysia().use(serviceAssetSearchRoutes).handle(
      new Request('http://maple.example/api/search/assets', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ query: 'HVAC' }),
      }),
    );
    expect(response.status).toBe(200);
  });
});
