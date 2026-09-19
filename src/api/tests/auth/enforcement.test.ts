/**
 * Which routes the global bearer gate lets through.
 *
 * `/api/auth/bootstrap` reads the users table to answer `claimed`, so this
 * suite needs a database installed as the process-wide handle (#3787) — with
 * none, the open route would answer 500 and the test would pass for the wrong
 * reason on the one case it is actually about.
 */
import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { healthRoutes } from '../../src/routes/health.ts';
import { authRoutes } from '../../src/routes/auth.ts';
import { requireAuth } from '../../src/auth/middleware.ts';
import { foldersRoutes } from '../../src/routes/folders.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const app = new Elysia().use(healthRoutes).use(authRoutes).use(requireAuth).use(foldersRoutes);

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

describe('global enforcement', () => {
  it('/api/health is open', async () => {
    const r = await app.handle(new Request('http://localhost/api/health'));
    expect(r.status).toBe(200);
  });
  it('/api/auth/bootstrap is open', async () => {
    const r = await app.handle(new Request('http://localhost/api/auth/bootstrap'));
    expect(r.status).toBe(200);
    expect((await r.json()).claimed).toBe(false);
  });
  it('/api/folders requires bearer', async () => {
    const r = await app.handle(new Request('http://localhost/api/folders'));
    expect(r.status).toBe(401);
  });
});
