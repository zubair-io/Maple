/**
 * The two login/refresh behaviours that need no ceremony: `/login/options`
 * answers every caller with discoverable options (so there is no
 * account-existence oracle), and `/refresh` turns away a request with no
 * usable token.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), so the handlers reach it through the same `sqliteDb()`
 * they use in production. Each test gets its own, so there is nothing to clean
 * up between them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { authRoutes } from '../../src/routes/auth.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const app = new Elysia().use(authRoutes);

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

describe('login flow', () => {
  it('login/options returns discoverable options for any caller (no email 404)', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/login/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ghost@nope.io' }),
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { challenge?: string; allowCredentials?: unknown[] };
    expect(body.challenge).toBeDefined();
    expect(body.allowCredentials ?? []).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('401 without token', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(401);
  });

  it('401 on unknown token', async () => {
    const r = await app.handle(
      new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: 'garbage' }),
      }),
    );
    expect(r.status).toBe(401);
  });
});
