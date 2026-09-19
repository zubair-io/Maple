/**
 * `POST /api/auth/dev-login` — the passkey bypass, and the gate that keeps it
 * off unless `MAPLE_DEV_AUTH` is set.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787). The account assertions read the `users` table back
 * directly, which is what proves "created once, then reused" rather than
 * "created twice and the second response happened to match".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

let live: LiveTestDatabase;

async function freshAppWith(devAuth: '1' | undefined) {
  // Re-import the routes module after toggling the env var so the
  // route handlers observe the current value (they read process.env
  // on each request, so a fresh import isn't strictly needed — but
  // building a fresh Elysia keeps the tests independent).
  if (devAuth === undefined) delete process.env.MAPLE_DEV_AUTH;
  else process.env.MAPLE_DEV_AUTH = devAuth;
  const { authRoutes } = await import('../../src/routes/auth.ts');
  return new Elysia().use(authRoutes);
}

/** How many accounts carry this address. */
function userCount(email: string): number {
  const row = live.db.query(`SELECT count(*) AS n FROM users WHERE email = ?`).get(email) as {
    n: number;
  };
  return row.n;
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
  delete process.env.MAPLE_DEV_AUTH;
});

describe('dev-login (gated)', () => {
  it('bootstrap reports dev_login_enabled=false by default', async () => {
    const app = await freshAppWith(undefined);
    const r = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ claimed: false, dev_login_enabled: false });
  });

  it('bootstrap reports dev_login_enabled=true when env set', async () => {
    const app = await freshAppWith('1');
    const r = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(await r.json()).toEqual({ claimed: false, dev_login_enabled: true });
  });

  it('returns 404 when MAPLE_DEV_AUTH is unset', async () => {
    const app = await freshAppWith(undefined);
    const r = await app.handle(
      new Request('http://localhost/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(404);
  });

  it('creates the default dev user on first call when enabled', async () => {
    const app = await freshAppWith('1');
    const r = await app.handle(
      new Request('http://localhost/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      access_token: string;
      refresh_token?: string;
      user: { email: string; role: string };
    };
    expect(body.access_token).toBeTypeOf('string');
    // #857: refresh token is the httpOnly cookie only, not the JSON body.
    expect(body.refresh_token).toBeUndefined();
    expect(body.user.email).toBe('dev@maple.local');
    expect(body.user.role).toBe('owner');

    const stored = live.db
      .query(`SELECT role FROM users WHERE email = ?`)
      .get('dev@maple.local') as { role: string } | null;
    expect(stored).not.toBeNull();
    expect(stored?.role).toBe('owner');
  });

  it('reuses the user on subsequent calls', async () => {
    const app = await freshAppWith('1');
    const devLogin = () =>
      app
        .handle(
          new Request('http://localhost/api/auth/dev-login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }),
        )
        .then((r) => r.json() as Promise<{ user: { id: string } }>);
    const first = await devLogin();
    const second = await devLogin();
    expect(second.user.id).toBe(first.user.id);
    expect(userCount('dev@maple.local')).toBe(1);
  });

  it('honours a custom email', async () => {
    const app = await freshAppWith('1');
    const r = await app.handle(
      new Request('http://localhost/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'custom@dev.local' }),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { user: { email: string } };
    expect(body.user.email).toBe('custom@dev.local');
  });
});
