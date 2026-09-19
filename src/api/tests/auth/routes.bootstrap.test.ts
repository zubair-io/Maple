/**
 * `GET /api/auth/bootstrap` and `POST /api/auth/register/options` — what a
 * browser asks before it knows whether this server has an owner yet.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so "empty database" is literally true for every test
 * rather than something a delete pass has to restore.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { authRoutes } from '../../src/routes/auth.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedUser } from '../helpers/sqlite-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

// Scope MAPLE_DEV_AUTH for this file so the assertions on
// `dev_login_enabled: false` aren't sensitive to the host's .env or
// shell state. A dev's local .env may set MAPLE_DEV_AUTH=1 to enable
// the passkey-bypass during dev — without this scope, that leaks into
// the test process and flips dev_login_enabled to true. Mirrors the
// pattern in routes.dev-login.test.ts.
const PRIOR_DEV_AUTH = process.env.MAPLE_DEV_AUTH;
delete process.env.MAPLE_DEV_AUTH;
afterAll(() => {
  if (PRIOR_DEV_AUTH === undefined) delete process.env.MAPLE_DEV_AUTH;
  else process.env.MAPLE_DEV_AUTH = PRIOR_DEV_AUTH;
});

const app = new Elysia().use(authRoutes);

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

describe('auth/bootstrap', () => {
  it('returns claimed=false on empty DB', async () => {
    const r = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ claimed: false, dev_login_enabled: false });
  });

  it('returns claimed=true once a user exists', async () => {
    seedUser(live.db, { email: 'a@b.c', role: 'owner' });
    const r = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(await r.json()).toEqual({ claimed: true, dev_login_enabled: false });
  });
});

describe('auth/register options', () => {
  it('accepts when DB empty (claim flow)', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c' }),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { challenge?: string };
    expect(body.challenge).toBeDefined();
  });

  it('rejects when claimed and no invite', async () => {
    seedUser(live.db, { email: 'a@b.c', role: 'owner' });
    const r = await app.handle(
      new Request('http://localhost/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@y.z' }),
      }),
    );
    expect(r.status).toBe(403);
  });
});
