/**
 * Body-based refresh rotation for native (Apple) clients.
 *
 * The web client authenticates `/api/auth/refresh` with the httpOnly
 * `maple_refresh` cookie and reads back only `{ access_token }` — the rotated
 * refresh token rides in the rotated cookie (#857, keeps it out of reach of JS).
 *
 * The native Apple client has no cookie jar: it stores tokens in the Keychain,
 * sends the refresh token in the request BODY, and must read the rotated
 * refresh token back FROM the body — there is nowhere else for it to land.
 * When `/refresh` returned `{ access_token }` only for body callers, the native
 * client could never learn its rotated refresh token: the first rotation left it
 * holding a now-consumed token, and its next refresh tripped reuse-detection →
 * whole-family revocation → sign-out. This pins the body contract.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), which is what lets `issueRefreshToken` and the route
 * see the same token rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import type { ObjectId } from 'mongodb';
import { authRoutes } from '../../src/routes/auth.ts';
import { issueRefreshToken } from '../../src/auth/refresh_store.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const app = new Elysia().use(authRoutes);

let live: LiveTestDatabase;
let userId: ObjectId;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  userId = seedUser(live.db, {
    email: 'native@maple.test',
    role: 'owner',
    lastSeenAt: new Date().toISOString(),
  });
});

afterEach(() => {
  live.close();
});

/** Refresh over the BODY (native path) — no cookie. Distinct IP per call keeps
 *  the shared `auth:${ip}` 10/min limiter from tripping across tests. */
function bodyRefresh(token: string, ip: string): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ refresh_token: token }),
    }),
  );
}

describe('body-based refresh (native Apple client)', () => {
  it('returns the rotated refresh_token in the JSON body', async () => {
    const { raw: r1 } = await issueRefreshToken(userId, 'native-device');

    const res = await bodyRefresh(r1, '203.0.113.1');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    expect(body.refresh_token).not.toBe(r1);
  });

  it('the rotated body refresh_token is itself usable for the next refresh', async () => {
    const { raw: r1 } = await issueRefreshToken(userId, 'native-device');

    const first = (await bodyRefresh(r1, '203.0.113.2').then((r) => r.json())) as {
      refresh_token?: string;
    };
    expect(first.refresh_token).toBeDefined();

    // The native client persists r2 and refreshes again — this must NOT be seen
    // as reuse of a consumed token; it is the legitimate rotated successor.
    const res2 = await bodyRefresh(first.refresh_token!, '203.0.113.2');
    expect(res2.status).toBe(200);
  });

  it('an empty body refresh_token falls back to the cookie instead of 401ing', async () => {
    const { raw: r1 } = await issueRefreshToken(userId, 'web-device');

    // A client that sends `refresh_token: ""` in the body but authenticates via
    // the cookie must not be rejected — the empty body token is "no body token".
    const res = await app.handle(
      new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.4',
          cookie: `maple_refresh=${r1}`,
        },
        body: JSON.stringify({ refresh_token: '' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeUndefined();
    expect(res.headers.get('set-cookie') ?? '').toContain('maple_refresh=');
  });

  it('when both a body token and a cookie are sent, rotates the body token and leaves the cookie untouched', async () => {
    const { raw: r1 } = await issueRefreshToken(userId, 'native-device');

    const res = await app.handle(
      new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.5',
          cookie: 'maple_refresh=some-other-token',
        },
        body: JSON.stringify({ refresh_token: r1 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token?: string };
    // Rotated the BODY token (returned in the body)…
    expect(body.refresh_token).toBeDefined();
    expect(body.refresh_token).not.toBe(r1);
    // …and did NOT overwrite the unrelated cookie with a body-family successor.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('cookie-based refresh still omits refresh_token from the body (#857)', async () => {
    const { raw: r1 } = await issueRefreshToken(userId, 'web-device');

    const res = await app.handle(
      new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.3',
          cookie: `maple_refresh=${r1}`,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { access_token?: string; refresh_token?: string };
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeUndefined();
    expect(res.headers.get('set-cookie') ?? '').toContain('maple_refresh=');
  });
});
