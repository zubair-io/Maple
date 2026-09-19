/**
 * /api/jobs HTTP round-trip tests via `app.handle`.
 *
 * Real SQLite, installed as the process-wide handle for the duration of each
 * test, because the route reaches `sqliteDb()` with no override. Every fixture
 * is created through the route itself, which is also what makes the isolation
 * cheap: a fresh database per test replaces the `deleteMany({})` the Mongo
 * version ran between tests.
 *
 * Coverage:
 *   - bearer required (401 without)
 *   - POST /api/jobs validates kind, returns id
 *   - GET /api/jobs/:id returns the doc
 *   - POST /api/jobs/:id/cancel flips cancel_requested
 *   - GET /api/jobs?status= filters
 */

import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import { requireAuth } from '../src/auth/middleware.ts';
import { jobsRoutes } from '../src/routes/jobs.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';

// JWT bootstrap MUST run before any request reaches `requireAuth`.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET;
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
      file_access: true,
    },
    SECRET,
  ));

const app = new Elysia().use(requireAuth).use(jobsRoutes);

function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER, 'Content-Type': 'application/json' };
}

const EXPORT_JOB = {
  kind: 'batch_jpeg_export',
  payload: { assetIds: [], outputDir: '/tmp', quality: 82 },
};

/** Create one export job through the route and return its id. */
async function createJob(): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/api/jobs', {
      method: 'POST',
      headers: fmtAuth(),
      body: JSON.stringify(EXPORT_JOB),
    }),
  );
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe('/api/jobs', () => {
  it('requires a bearer', async () => {
    using live = await createLiveTestDatabase();
    const r = await app.handle(new Request('http://localhost/api/jobs'));
    expect(r.status).toBe(401);
  });

  it('POST /api/jobs creates a queued job and returns id', async () => {
    using live = await createLiveTestDatabase();

    const r = await app.handle(
      new Request('http://localhost/api/jobs', {
        method: 'POST',
        headers: fmtAuth(),
        body: JSON.stringify(EXPORT_JOB),
      }),
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBe(24);
  });

  it('POST /api/jobs rejects unknown kinds', async () => {
    using live = await createLiveTestDatabase();

    const r = await app.handle(
      new Request('http://localhost/api/jobs', {
        method: 'POST',
        headers: fmtAuth(),
        body: JSON.stringify({ kind: 'no_such_kind', payload: {} }),
      }),
    );
    expect(r.status).toBe(400);
  });

  it('GET /api/jobs/:id returns the doc; 404 on unknown', async () => {
    using live = await createLiveTestDatabase();
    const id = await createJob();

    const get = await app.handle(
      new Request(`http://localhost/api/jobs/${id}`, { headers: fmtAuth() }),
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      id: string;
      status: string;
      cancel_requested: boolean;
      progress: { current: number; total: number };
    };
    expect(body.id).toBe(id);
    expect(body.status).toBe('queued');
    expect(body.cancel_requested).toBe(false);
    expect(body.progress).toEqual({ current: 0, total: 0 });

    const miss = await app.handle(
      new Request('http://localhost/api/jobs/000000000000000000000000', {
        headers: fmtAuth(),
      }),
    );
    expect(miss.status).toBe(404);
  });

  it('POST /api/jobs/:id/cancel flips cancel_requested', async () => {
    using live = await createLiveTestDatabase();
    const id = await createJob();

    const cancel = await app.handle(
      new Request(`http://localhost/api/jobs/${id}/cancel`, {
        method: 'POST',
        headers: fmtAuth(),
      }),
    );
    expect(cancel.status).toBe(200);
    const after = await app.handle(
      new Request(`http://localhost/api/jobs/${id}`, { headers: fmtAuth() }),
    );
    const body = (await after.json()) as { cancel_requested: boolean };
    expect(body.cancel_requested).toBe(true);
  });

  it('GET /api/jobs?status= filters by status', async () => {
    using live = await createLiveTestDatabase();

    for (let i = 0; i < 3; i++) await createJob();

    const list = await app.handle(
      new Request('http://localhost/api/jobs?status=queued&kind=batch_jpeg_export&limit=10', {
        headers: fmtAuth(),
      }),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { jobs: unknown[] };
    expect(body.jobs.length).toBe(3);

    const empty = await app.handle(
      new Request('http://localhost/api/jobs?status=done', {
        headers: fmtAuth(),
      }),
    );
    const e = (await empty.json()) as { jobs: unknown[] };
    expect(e.jobs.length).toBe(0);
  });
});
