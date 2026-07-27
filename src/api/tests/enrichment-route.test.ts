/**
 * /api/enrichment/* route tests. Exercises the route directly via
 * `app.handle` (no auth — we mount the route without `requireAuth` for
 * tests, mirroring the search-route + jobs-route patterns).
 *
 * The Nominatim health-check is faked by stubbing `globalThis.fetch` for
 * the duration of each test — no network calls.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_enrichment_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let app: Elysia | null = null;

const realFetch = globalThis.fetch;

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
    console.log('[enrichment-route.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  // Ensure the worker doesn't auto-start during route tests — set env so the
  // resolved config gives us a dormant worker.
  delete process.env.MAPLE_NOMINATIM_URL;
  process.env.MAPLE_GEOCODE_WORKER_ENABLED = 'false';
  // Suppress slow-tier workers from auto-starting during these tests so
  // their health-checks don't trip the global fetch stub or spawn loops.
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

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function put(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('GET /api/enrichment/config', () => {
  it('returns env fallback when no DB row exists', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      nominatim_url: null,
      geocode_worker_enabled: false,
      source: {
        nominatim_url: 'unset',
        geocode_worker_enabled: 'env',
      },
    });
  });

  it('returns the saved DB row when present', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').insertOne({
      _id: 'enrichment',
      config: {
        nominatim_url: 'http://from-db.test:8080',
        geocode_worker_enabled: true,
        updated_at: 1,
      },
    } as never);
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    expect((r.body as { nominatim_url: string }).nominatim_url).toBe('http://from-db.test:8080');
    expect((r.body as { source: { nominatim_url: string } }).source.nominatim_url).toBe('db');
  });
});

describe('PUT /api/enrichment/config', () => {
  it('rejects malformed URL with 400', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'not-a-url',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid nominatim_url/);
  });

  it('rejects file:// URL', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'file:///etc/passwd',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/protocol/i);
  });

  it('returns 502 when health-check fails (worker enabled + URL set)', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 503 }));
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://broken.test',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/health check failed/);
    // DB row was NOT saved.
    const saved = await db!.collection('app_settings').findOne({ _id: 'enrichment' });
    expect(saved).toBeNull();
  });

  it('saves and returns the resolved config on success', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://nominatim.test:8080/',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(200);
    const body = r.body as { nominatim_url: string; source: { nominatim_url: string } };
    // Trailing slash is stripped on save.
    expect(body.nominatim_url).toBe('http://nominatim.test:8080');
    expect(body.source.nominatim_url).toBe('db');
    const saved = await db!.collection('app_settings').findOne({ _id: 'enrichment' });
    expect(saved).toBeTruthy();
  });

  it('saves without health-check when geocode_worker_enabled=false', async () => {
    if (!mongoReachable) return;
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return { status: 200 };
    });
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://maybe-broken.test',
      geocode_worker_enabled: false,
    });
    expect(r.status).toBe(200);
    expect(fetchCalled).toBe(false);
  });

  it('saves null URL without health-check', async () => {
    if (!mongoReachable) return;
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return { status: 200 };
    });
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(200);
    expect(fetchCalled).toBe(false);
    const body = r.body as { nominatim_url: string | null };
    expect(body.nominatim_url).toBeNull();
  });

  it('rejects rate limit below the minimum', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 0,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/rate_limit/);
  });

  it('rejects rate limit above the maximum', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 1000,
    });
    expect(r.status).toBe(400);
  });

  it('rejects negative rate limit', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: -5,
    });
    expect(r.status).toBe(400);
  });

  it('saves and reflects rate limit on a valid value', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 2.5,
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(2.5);
    expect(body.source.nominatim_rate_limit_per_sec).toBe('db');
  });

  it('clears rate limit back to default when null is supplied', async () => {
    if (!mongoReachable) return;
    // Save a value first.
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 2.5,
    });
    // Then null it out.
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: null,
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(10);
    expect(body.source.nominatim_rate_limit_per_sec).toBe('default');
  });
});

describe('GET /api/enrichment/config — rate limit projection', () => {
  it('includes the resolved value + source on a fresh DB', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(10);
    expect(['env', 'default']).toContain(body.source.nominatim_rate_limit_per_sec);
  });
});

describe('POST /api/enrichment/test', () => {
  it('returns ok:true on successful health-check', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 200 }));
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'http://nominatim.test',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, url: 'http://nominatim.test' });
  });

  it('returns ok:false with detail on 5xx', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 500 }));
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'http://nominatim.test',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(500);
  });

  it('returns 400 for invalid URL', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'not-a-url',
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/enrichment/test-meili', () => {
  it('returns ok:true when Meilisearch /health is reachable', async () => {
    if (!mongoReachable) return;
    stubFetch((url) =>
      url.endsWith('/health') ? { status: 200, body: { status: 'available' } } : { status: 200 },
    );
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700/',
    });
    expect(r.status).toBe(200);
    // Trailing slash is stripped to match the saved/used form.
    expect(r.body).toMatchObject({ ok: true, url: 'http://meili.test:7700' });
  });

  it('returns ok:false when the health check fails', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 503, body: { status: 'unavailable' } }));
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(false);
  });

  it('returns 400 for an invalid URL', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'not-a-url',
    });
    expect(r.status).toBe(400);
  });
});

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
