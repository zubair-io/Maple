/**
 * PUT /api/enrichment/config — Meilisearch-related fields (url, task timeout,
 * semantic-search blend, write-only API key) plus the PUT owner gate
 * (#2353). Split out of `enrichment-route.test.ts` to stay under the
 * repo's 600-line file budget (see CONTRIBUTING.md § "File-size budget");
 * same route, same `app.handle` harness.
 *
 * PUT /config requires the `owner` role (#2353): it can repoint
 * `meilisearch_url` (and the Meilisearch API key bearer) at an
 * attacker-controlled host, so the `put()` helper below defaults to an
 * owner JWT. GET/test stay member-readable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { signAccessToken } from '../src/auth/tokens.ts';

const TEST_DB = `maple_test_enrichment_route_meili_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

const realFetch = globalThis.fetch;

const ownerJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { sub: new ObjectId().toHexString(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[enrichment-route-meilisearch.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  delete process.env.MAPLE_NOMINATIM_URL;
  process.env.MAPLE_GEOCODE_WORKER_ENABLED = 'false';
  process.env.MAPLE_DESCRIBE_WORKER_ENABLED = 'false';
  process.env.MAPLE_FACE_WORKER_ENABLED = 'false';
  process.env.MAPLE_OCR_WORKER_ENABLED = 'false';
  const { enrichmentRoutes } = await import('../src/routes/enrichment.ts');
  app = new Elysia().use(enrichmentRoutes);
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('app_settings').deleteMany({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
});

function stubFetch(handler: (url: string) => { status?: number; body?: unknown } | Error): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
}

async function get(
  path: string,
  jwt: string = memberJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${jwt}` } }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

// Defaults to an owner bearer — PUT /config is owner-gated (#2353). Pass
// `jwt` explicitly to exercise the member rejection path; the no-bearer
// (401) path is exercised directly against `app!.handle` below since its
// body isn't JSON.
async function put(
  path: string,
  body: Record<string, unknown>,
  jwt: string = ownerJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
  jwt: string = memberJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('PUT /api/enrichment/config — meilisearch_url', () => {
  it('rejects a malformed meilisearch_url with 400', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_url: 'not-a-url',
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid meilisearch_url/);
  });

  it("persists meilisearch_url and reports source 'db' (no health gate)", async () => {
    if (!mongoReachable) return;
    // A bad/unreachable Meili URL must NOT block the save — search degrades
    // to Mongo $text. We still stub fetch so the background health probe
    // doesn't hit the network.
    stubFetch(() => ({ status: 503 }));
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_url: 'http://meili.test:7700/',
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      meilisearch_url: string;
      source: { meilisearch_url: string };
    };
    expect(body.meilisearch_url).toBe('http://meili.test:7700');
    expect(body.source.meilisearch_url).toBe('db');
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { meilisearch_url?: string } }>({ _id: 'enrichment' } as never);
    expect(saved!.config.meilisearch_url).toBe('http://meili.test:7700');
  });
});

describe('PUT /api/enrichment/config — meilisearch task timeout', () => {
  it('persists an operator timeout and rejects values outside the safe range', async () => {
    if (!mongoReachable) return;
    const saved = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_task_timeout_seconds: 900,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      meilisearch_task_timeout_seconds: 900,
      source: { meilisearch_task_timeout_seconds: 'db' },
    });

    const invalid = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_task_timeout_seconds: 29,
    });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { error: string }).error).toMatch(
      /Invalid meilisearch_task_timeout_seconds/,
    );
  });
});

describe('PUT /api/enrichment/config — semantic search', () => {
  it('reuses the Describe Ollama URL and persists the freeform embedding model', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_provider: 'ollama',
      describe_provider_url: 'http://ollama.test:11434',
      meilisearch_url: 'http://meili.test:7700',
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_model: '  custom-embedder  ',
      meilisearch_semantic_ratio: 0.65,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_url: 'http://ollama.test:11434',
      meilisearch_embedder_model: 'custom-embedder',
      meilisearch_semantic_ratio: 0.65,
      source: {
        meilisearch_semantic_enabled: 'db',
        meilisearch_embedder_url: 'db',
        meilisearch_embedder_model: 'db',
        meilisearch_semantic_ratio: 'db',
      },
    });

    const reset = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_provider_url: null,
      meilisearch_embedder_model: '   ',
    });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      meilisearch_embedder_url: 'http://localhost:11434',
      meilisearch_embedder_model: 'bge-m3',
      source: {
        meilisearch_embedder_url: 'default',
        meilisearch_embedder_model: 'default',
      },
    });
  });

  it('ignores the retired separate embedder URL and rejects an invalid blend', async () => {
    if (!mongoReachable) return;
    const base = { nominatim_url: null, geocode_worker_enabled: false };
    const legacyUrl = await put('/api/enrichment/config', {
      ...base,
      meilisearch_embedder_url: 'not-a-url',
    });
    expect(legacyUrl.status).toBe(200);
    expect(legacyUrl.body).toMatchObject({
      meilisearch_embedder_url: 'http://localhost:11434',
      source: { meilisearch_embedder_url: 'default' },
    });
    const badRatio = await put('/api/enrichment/config', {
      ...base,
      meilisearch_semantic_ratio: 1.1,
    });
    expect(badRatio.status).toBe(400);
  });
});

describe('PUT/GET /api/enrichment/config — meilisearch_api_key (write-only)', () => {
  it('persists the key but never echoes it; reports meilisearch_api_key_set', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    const put1 = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_url: 'http://meili.test:7700',
      meilisearch_api_key: 'super-secret',
    });
    expect(put1.status).toBe(200);
    // The raw key must NOT appear in the response.
    expect(JSON.stringify(put1.body)).not.toContain('super-secret');
    expect((put1.body as { meilisearch_api_key_set: boolean }).meilisearch_api_key_set).toBe(true);
    expect(
      (put1.body as { source: { meilisearch_api_key: string } }).source.meilisearch_api_key,
    ).toBe('db');

    // GET also reports set=true and never includes the key.
    const got = await get('/api/enrichment/config');
    expect(JSON.stringify(got.body)).not.toContain('super-secret');
    expect((got.body as { meilisearch_api_key_set: boolean }).meilisearch_api_key_set).toBe(true);

    // ...but it IS persisted in Mongo.
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { meilisearch_api_key?: string } }>({ _id: 'enrichment' } as never);
    expect(saved!.config.meilisearch_api_key).toBe('super-secret');
  });

  it('a blank/omitted key leaves the saved key unchanged', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_api_key: 'keep-me',
    });
    // Second save with an empty-string key must NOT wipe it.
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_api_key: '',
    });
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { meilisearch_api_key?: string } }>({ _id: 'enrichment' } as never);
    expect(saved!.config.meilisearch_api_key).toBe('keep-me');
  });

  it('an explicit null clears the saved key', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_api_key: 'delete-me',
    });
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      meilisearch_api_key: null,
    });
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { meilisearch_api_key?: string | null } }>({ _id: 'enrichment' } as never);
    expect(saved!.config.meilisearch_api_key).toBeNull();
  });
});

// #2353 — PUT /config can repoint meilisearch_url (and its API-key bearer)
// at an attacker-controlled host, so it must reject anyone but the owner.
// GET/test stay member-readable — no state change, no secrets in the response.
describe('PUT /api/enrichment/config — owner gate (#2353)', () => {
  const body = { nominatim_url: null, geocode_worker_enabled: false };

  it('rejects an unauthenticated request with 401', async () => {
    if (!mongoReachable) return;
    // Raw request (bypassing the `put()` helper) — the 401 rejection body is
    // plain text ("missing bearer"), not JSON, so `put()`'s `res.json()`
    // parse would throw.
    const res = await app!.handle(
      new Request('http://localhost/api/enrichment/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', body, memberJwt);
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe('owner role required');
    // The rejected request must not have persisted anything.
    const saved = await db!.collection('app_settings').findOne({ _id: 'enrichment' });
    expect(saved).toBeNull();
  });

  it('allows an owner-role token through to the save path (200)', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', body, ownerJwt);
    expect(r.status).toBe(200);
  });

  it('GET /config stays member-readable', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/enrichment/config', memberJwt);
    expect(r.status).toBe(200);
  });

  it('POST /test stays member-accessible', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    const r = await post('/api/enrichment/test', { nominatim_url: 'http://n.test' }, memberJwt);
    expect(r.status).toBe(200);
  });
});
