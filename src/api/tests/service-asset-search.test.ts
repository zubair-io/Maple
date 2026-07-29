import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId } from 'mongodb';
import { createServiceApiKey } from '../src/auth/service-api-keys.ts';
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

const TEST_DB = `maple_test_service_asset_search_${process.pid}`;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const PRIOR_DB = process.env.MAPLE_MONGO_DB;
process.env.MAPLE_MONGO_DB = TEST_DB;

let mongo: MongoClient | null = null;
let mongoReachable = false;
let serviceKey = '';

async function tryConnect(): Promise<MongoClient | null> {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch {
    await client.close().catch(() => {});
    return null;
  }
}

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

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[service-asset-search.test] skipping: MongoDB unreachable');
    return;
  }
  await mongo!.db(TEST_DB).dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  const db = mongo!.db(TEST_DB);
  await db.collection('app_settings').deleteMany({});
  await db.collection('service_api_keys').deleteMany({});
  await db.collection('assets').deleteMany({});
  serviceKey = (
    await createServiceApiKey({
      name: 'SugarMaple integration',
      createdBy: new ObjectId(),
    })
  ).key;
  _resetServiceSearchRateLimitsForTests();
  setMeilisearchClientForTests(null);
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo
      .db(TEST_DB)
      .dropDatabase()
      .catch(() => {});
    await mongo.close().catch(() => {});
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  if (PRIOR_DB === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = PRIOR_DB;
});

describe('POST /api/search/assets', () => {
  it('returns the concrete HVAC video from a hybrid conceptual query', async () => {
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
    expect((await request({ query: 'HVAC', from: '2026-02-30' })).status).toBe(400);
    expect(
      (await request({ query: 'HVAC', from: '2026-07-30', to: '2026-07-29' })).status,
    ).toBe(400);
  });

  it('retries lexical search and reports the fallback when embedding fails', async () => {
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
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

  it('preserves exact filename search during full Mongo fallback', async () => {
    if (!mongoReachable) return;
    const folder = new ObjectId();
    await mongo!
      .db(TEST_DB)
      .collection('assets')
      .insertOne({
        maple_id: '010045ca68ac1f7f7e8b3aa02f72ac80',
        fileinfo: [
          {
            library_id: folder,
            path: '',
            filename: 'IMG_4185.MOV',
            deleted_at: null,
            missing_since: null,
          },
        ],
        size: 1024,
        mtime: Date.now(),
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: new Date().toISOString(),
        deleted_at: null,
        hidden: false,
      });
    // The matching filename belongs to a stale location while another
    // location is live. The exact filename and liveness predicates must
    // match the same fileinfo element.
    await mongo!
      .db(TEST_DB)
      .collection('assets')
      .insertOne({
        maple_id: 'stale-filename',
        fileinfo: [
          {
            library_id: folder,
            path: '',
            filename: 'IMG_4185.MOV',
            deleted_at: new Date().toISOString(),
            missing_since: null,
          },
          {
            library_id: folder,
            path: '',
            filename: 'IMG_9999.MOV',
            deleted_at: null,
            missing_since: null,
          },
        ],
        deleted_at: null,
        hidden: false,
      });
    setMeilisearchClientForTests({
      isConfigured: () => false,
      semanticConfigured: () => false,
      health: async () => false,
      ensureIndex: async () => {},
      upsert: async () => {},
      upsertOrThrow: async () => {},
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    });

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

  it('rejects invalid credentials and whitespace-only queries', async () => {
    if (!mongoReachable) return;
    const invalid = await request({ query: 'HVAC' }, 'maple_sk_invalid');
    expect(invalid.status).toBe(401);

    const empty = await request({ query: '   ' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'query_must_not_be_empty' });
  });

  it('authenticates before validating the request body', async () => {
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
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
    if (!mongoReachable) return;
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
