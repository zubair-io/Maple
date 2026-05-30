/**
 * /api/observability/* route tests. Exercises the route directly via
 * `app.handle` (no auth — we mount the route without `requireAuth` for tests,
 * mirroring the enrichment-route + search-route patterns).
 *
 * The SigNoz `/v1/traces` probe is faked by stubbing `globalThis.fetch` for
 * the duration of each test — no network calls.
 *
 * `MAPLE_SIGNOZ_ENABLED=false` keeps the route's post-save `applyOtelConfig`
 * call a no-op so no background SDK + batch-exporter timers spin up during the
 * test process (which would otherwise hang `bun test`). `shutdownOtel` runs in
 * afterAll as belt-and-braces.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, type Db } from 'mongodb';

const TEST_DB = `maple_test_observability_route_${process.pid}`;
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
  // Keep the OTel SDK dormant so the post-save apply is a no-op (no batch
  // exporter timers leaking past the test run).
  process.env.MAPLE_SIGNOZ_ENABLED = 'false';
  delete process.env.MAPLE_SIGNOZ_ENDPOINT;
  delete process.env.MAPLE_SIGNOZ_INGESTION_KEY;

  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[observability-route.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  const { observabilityRoutes } = await import('../src/routes/observability.ts');
  app = new Elysia().use(observabilityRoutes);
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('app_settings').deleteMany({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  const { shutdownOtel } = await import('../src/otel.ts');
  await shutdownOtel();
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

describe('GET /api/observability/config', () => {
  it('returns defaults when no DB row exists', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/observability/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: false, // env override MAPLE_SIGNOZ_ENABLED=false
      endpoint: null,
      service_namespace: 'maple',
      source: { endpoint: 'unset' },
    });
  });

  it('returns the saved DB row when present, INCLUDING the ingestion key', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').insertOne({
      _id: 'observability',
      config: {
        endpoint: 'https://from-db.test:4318',
        ingestion_key: 'db-secret-key',
        updated_at: 1,
      },
    } as never);
    const r = await get('/api/observability/config');
    expect(r.status).toBe(200);
    const body = r.body as {
      endpoint: string;
      ingestion_key: string;
      source: { endpoint: string };
    };
    expect(body.endpoint).toBe('https://from-db.test:4318');
    expect(body.source.endpoint).toBe('db');
    // Unlike the meilisearch key, the ingestion key IS echoed (direct-to-SigNoz
    // clients need it; the route is bearer-gated in production).
    expect(body.ingestion_key).toBe('db-secret-key');
  });
});

describe('PUT /api/observability/config — endpoint validation', () => {
  it('rejects a malformed endpoint with 400', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { endpoint: 'not-a-url' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid endpoint/);
  });

  it('rejects a file:// endpoint with 400', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { endpoint: 'file:///etc/passwd' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/protocol/i);
  });

  it('saves and strips the trailing slash, reporting source db', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', {
      endpoint: 'https://ingest.signoz.test:4318/',
    });
    expect(r.status).toBe(200);
    const body = r.body as { endpoint: string; source: { endpoint: string } };
    expect(body.endpoint).toBe('https://ingest.signoz.test:4318');
    expect(body.source.endpoint).toBe('db');
  });

  it('clears the endpoint when null is supplied', async () => {
    if (!mongoReachable) return;
    await put('/api/observability/config', { endpoint: 'https://x.test' });
    const r = await put('/api/observability/config', { endpoint: null });
    expect(r.status).toBe(200);
    expect((r.body as { endpoint: string | null }).endpoint).toBeNull();
  });
});

describe('PUT /api/observability/config — sample_ratio validation', () => {
  it('rejects a ratio above 1', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { sample_ratio: 1.5 });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/sample_ratio/);
  });

  it('rejects a ratio below 0', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { sample_ratio: -0.1 });
    expect(r.status).toBe(400);
  });

  it('accepts a valid ratio and reflects it with source db', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { sample_ratio: 0.3 });
    expect(r.status).toBe(200);
    const body = r.body as { sample_ratio: number; source: { sample_ratio: string } };
    expect(body.sample_ratio).toBe(0.3);
    expect(body.source.sample_ratio).toBe('db');
  });

  it('accepts the boundary values 0 and 1', async () => {
    if (!mongoReachable) return;
    expect((await put('/api/observability/config', { sample_ratio: 0 })).status).toBe(200);
    expect((await put('/api/observability/config', { sample_ratio: 1 })).status).toBe(200);
  });
});

describe('PUT/GET /api/observability/config — ingestion_key write semantics', () => {
  it('a non-empty string sets the key and GET echoes it', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/observability/config', { ingestion_key: 'set-me' });
    expect(r.status).toBe(200);
    expect((r.body as { ingestion_key: string }).ingestion_key).toBe('set-me');
    expect((r.body as { source: { ingestion_key: string } }).source.ingestion_key).toBe('db');
    const got = await get('/api/observability/config');
    expect((got.body as { ingestion_key: string }).ingestion_key).toBe('set-me');
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { ingestion_key?: string } }>({ _id: 'observability' } as never);
    expect(saved!.config.ingestion_key).toBe('set-me');
  });

  it('a blank/empty-string key leaves the saved key unchanged', async () => {
    if (!mongoReachable) return;
    await put('/api/observability/config', { ingestion_key: 'keep-me' });
    await put('/api/observability/config', { ingestion_key: '' });
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { ingestion_key?: string } }>({ _id: 'observability' } as never);
    expect(saved!.config.ingestion_key).toBe('keep-me');
  });

  it('an explicit null clears the saved key', async () => {
    if (!mongoReachable) return;
    await put('/api/observability/config', { ingestion_key: 'delete-me' });
    await put('/api/observability/config', { ingestion_key: null });
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { ingestion_key?: string | null } }>({ _id: 'observability' } as never);
    expect(saved!.config.ingestion_key).toBeNull();
  });
});

describe('POST /api/observability/test', () => {
  it('returns ok:true on a 2xx from the SigNoz traces endpoint', async () => {
    if (!mongoReachable) return;
    let calledUrl = '';
    let sawToken = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      sawToken = headers.get('signoz-access-token') === 'probe-key';
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const r = await post('/api/observability/test', {
      endpoint: 'https://ingest.signoz.test:4318/',
      ingestion_key: 'probe-key',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 200 });
    // Probes the /v1/traces path on the trailing-slash-stripped base, with the
    // access-token header attached.
    expect(calledUrl).toBe('https://ingest.signoz.test:4318/v1/traces');
    expect(sawToken).toBe(true);
  });

  it('returns ok:false with the status on a non-2xx', async () => {
    if (!mongoReachable) return;
    stubFetch(() => ({ status: 401 }));
    const r = await post('/api/observability/test', {
      endpoint: 'https://ingest.signoz.test:4318',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
  });

  it('returns ok:false with an error when the fetch throws', async () => {
    if (!mongoReachable) return;
    stubFetch(() => new Error('ECONNREFUSED'));
    const r = await post('/api/observability/test', {
      endpoint: 'https://unreachable.test:4318',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it('returns 400 for an invalid endpoint', async () => {
    if (!mongoReachable) return;
    const r = await post('/api/observability/test', { endpoint: 'not-a-url' });
    expect(r.status).toBe(400);
  });
});
