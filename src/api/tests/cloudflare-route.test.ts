/**
 * /api/cloudflare/* route tests. Exercises the route via `app.handle`,
 * with real owner/member bearer tokens (mirrors routes.invites.test.ts) —
 * unlike enrichment/observability, this route is owner-gated.
 *
 * R2 network calls are faked by stubbing `globalThis.fetch` for the
 * duration of each test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { signAccessToken } from '../src/auth/tokens.ts';

const TEST_DB = `maple_test_cloudflare_route_${process.pid}`;
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
    console.log('[cloudflare-route.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../src/db/client.ts');
  await closeDb();
  const { cloudflareRoutes } = await import('../src/routes/cloudflare.ts');
  app = new Elysia().use(cloudflareRoutes);
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

function stubFetch(status: number, body = ''): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

async function get(path: string, jwt: string): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${jwt}` } }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function put(
  path: string,
  body: Record<string, unknown>,
  jwt: string,
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

const FULL_CONFIG = {
  enabled: true,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key: 'secretexample',
};

describe('GET /api/cloudflare/config', () => {
  it('rejects an unauthenticated request with 401', async () => {
    if (!mongoReachable) return;
    const res = await app!.handle(new Request('http://localhost/api/cloudflare/config'));
    expect(res.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/cloudflare/config', memberJwt);
    expect(r.status).toBe(403);
  });

  it('returns defaults when no DB row exists', async () => {
    if (!mongoReachable) return;
    const r = await get('/api/cloudflare/config', ownerJwt);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: false,
      account_id: null,
      bucket: null,
      secret_access_key_set: false,
    });
    expect(r.body).not.toHaveProperty('secret_access_key');
  });
});

describe('PUT /api/cloudflare/config', () => {
  it('rejects enabling without full credentials', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/cloudflare/config', { enabled: true }, ownerJwt);
    expect(r.status).toBe(400);
  });

  it('validates credentials against R2 before persisting when enabling', async () => {
    if (!mongoReachable) return;
    stubFetch(403, 'AccessDenied');
    const r = await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    expect(r.status).toBe(502);
    // Rejected save must not have persisted.
    const got = await get('/api/cloudflare/config', ownerJwt);
    expect((got.body as { enabled: boolean }).enabled).toBe(false);
  });

  it('saves full credentials once the R2 probe succeeds, redacting the secret', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const r = await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, account_id: 'acct123' });
    expect(r.body).not.toHaveProperty('secret_access_key');
    expect((r.body as { secret_access_key_set: boolean }).secret_access_key_set).toBe(true);
  });

  it('does not re-validate against R2 when disabling', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    globalThis.fetch = (async () => {
      throw new Error('should not be called when disabling');
    }) as unknown as typeof fetch;
    const r = await put('/api/cloudflare/config', { enabled: false }, ownerJwt);
    expect(r.status).toBe(200);
    expect((r.body as { enabled: boolean }).enabled).toBe(false);
  });

  it('omitting secret_access_key leaves the saved key unchanged', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    const r = await put(
      '/api/cloudflare/config',
      { enabled: false, bucket: 'renamed' },
      ownerJwt,
    );
    expect(r.status).toBe(200);
    const saved = await db!
      .collection('app_settings')
      .findOne<{ config: { secret_access_key?: string } }>({ _id: 'cloudflare' } as never);
    expect(saved!.config.secret_access_key).toBe('secretexample');
  });

  it('rejects a member-role token with 403', async () => {
    if (!mongoReachable) return;
    const r = await put('/api/cloudflare/config', { enabled: false }, memberJwt);
    expect(r.status).toBe(403);
  });
});

describe('POST /api/cloudflare/test', () => {
  it('returns ok:true on a successful R2 round-trip', async () => {
    if (!mongoReachable) return;
    stubFetch(200);
    const res = await app!.handle(
      new Request('http://localhost/api/cloudflare/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
        body: JSON.stringify(FULL_CONFIG),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns ok:false with the error on a failed probe', async () => {
    if (!mongoReachable) return;
    stubFetch(401, 'InvalidAccessKeyId');
    const res = await app!.handle(
      new Request('http://localhost/api/cloudflare/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
        body: JSON.stringify(FULL_CONFIG),
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/401/);
  });
});
