/**
 * /api/cloudflare/* route tests. Exercises the route via `app.handle`,
 * with real owner/member bearer tokens (mirrors routes.invites.test.ts) —
 * unlike enrichment/observability, this route is owner-gated.
 *
 * Real SQLite, installed as the process-wide handle for the length of each
 * test, because the route reaches `sqliteDb()` with no override. A fresh
 * database per test is what replaces the `deleteMany({})` on `app_settings`
 * the Mongo version ran between tests.
 *
 * R2 network calls are faked by stubbing `globalThis.fetch` for the
 * duration of each test.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { cloudflareRoutes } from '../src/routes/cloudflare.ts';
import { readAppSettings } from '../src/db/sqlite/repos/app-settings.repo.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const app = new Elysia().use(cloudflareRoutes);

const realFetch = globalThis.fetch;

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body = ''): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

async function get(path: string, jwt: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${jwt}` },
    }),
  );
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

async function put(
  path: string,
  body: Record<string, unknown>,
  jwt: string,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

/** The persisted document, secret included — what the wire never shows. */
async function savedConfig(): Promise<{ secret_access_key?: string } | undefined> {
  const doc = await readAppSettings<{ config: { secret_access_key?: string } }>('cloudflare');
  return doc?.config;
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
    using live = await createLiveTestDatabase();
    const res = await app.handle(new Request('http://localhost/api/cloudflare/config'));
    expect(res.status).toBe(401);
  });

  it('rejects a member-role token with 403', async () => {
    using live = await createLiveTestDatabase();
    const r = await get('/api/cloudflare/config', memberJwt);
    expect(r.status).toBe(403);
  });

  it('returns defaults when no DB row exists', async () => {
    using live = await createLiveTestDatabase();
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
    using live = await createLiveTestDatabase();
    const r = await put('/api/cloudflare/config', { enabled: true }, ownerJwt);
    expect(r.status).toBe(400);
  });

  it('validates credentials against R2 before persisting when enabling', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(403, 'AccessDenied');
    const r = await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    expect(r.status).toBe(502);
    // Rejected save must not have persisted.
    const got = await get('/api/cloudflare/config', ownerJwt);
    expect((got.body as { enabled: boolean }).enabled).toBe(false);
  });

  it('saves full credentials once the R2 probe succeeds, redacting the secret', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(200);
    const r = await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, account_id: 'acct123' });
    expect(r.body).not.toHaveProperty('secret_access_key');
    expect((r.body as { secret_access_key_set: boolean }).secret_access_key_set).toBe(true);
  });

  it('does not re-validate against R2 when disabling', async () => {
    using live = await createLiveTestDatabase();
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
    using live = await createLiveTestDatabase();
    stubFetch(200);
    await put('/api/cloudflare/config', FULL_CONFIG, ownerJwt);
    const r = await put('/api/cloudflare/config', { enabled: false, bucket: 'renamed' }, ownerJwt);
    expect(r.status).toBe(200);
    expect((await savedConfig())!.secret_access_key).toBe('secretexample');
  });

  it('rejects a member-role token with 403', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/cloudflare/config', { enabled: false }, memberJwt);
    expect(r.status).toBe(403);
  });
});

describe('POST /api/cloudflare/test', () => {
  it('returns ok:true on a successful R2 round-trip', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(200);
    const res = await app.handle(
      new Request('http://localhost/api/cloudflare/test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerJwt}`,
        },
        body: JSON.stringify(FULL_CONFIG),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns ok:false with the error on a failed probe', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(401, 'InvalidAccessKeyId');
    const res = await app.handle(
      new Request('http://localhost/api/cloudflare/test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerJwt}`,
        },
        body: JSON.stringify(FULL_CONFIG),
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/401/);
  });
});
