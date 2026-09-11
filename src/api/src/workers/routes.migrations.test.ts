/**
 * `/api/workers/migration/migrations` routes — split out of `routes.test.ts`
 * to keep that file under the size budget (#3491).
 */
import { describe, expect, it, afterAll, beforeEach, beforeAll } from 'bun:test';
import type { Db } from 'mongodb';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { closeDb, getDb } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

// Own per-pid database + explicit close — the repo-wide suite convention
// (#2835): otherwise this file operates on whatever database MAPLE_MONGO_DB
// happens to name (the real `maple` dev DB when it runs first) and leaks its
// singleton connection into later suites (the #2783 flake class).
withTestDb(`maple_test_workers_routes_migrations_${process.pid}`);

// Captured here, not re-resolved in afterAll: withTestDb restores
// MAPLE_MONGO_DB before this suite's teardown runs.
let suiteDb: Db | null = null;

let dbReachable = true;
beforeAll(async () => {
  try {
    await closeDb();
    suiteDb = await getDb();
  } catch {
    dbReachable = false;
  }
});
beforeEach(async () => {
  if (dbReachable) {
    const db = await getDb();
    await db.collection('worker_status').deleteMany({ _id: 'singleton' });
    // `/status` derives each stage's pending/ready/dead from a live
    // countDocuments over the `assets` collection. In the shared CI Mongo an
    // earlier test file can leave asset docs behind, which makes the
    // "zeroed on empty DB" assertions observe a stale backlog. Clear assets so
    // every test in this file starts from a true 0/0/0 baseline.
    await db.collection('assets').deleteMany({});
  }
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

describe('migration routes', () => {
  const app = new Elysia().use(workerRoutes());

  it('GET /migration/migrations lists the registry (works without DB)', async () => {
    const res = await app.handle(new Request('http://localhost/api/workers/migration/migrations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.migrations)).toBe(true);
    const restructure = body.migrations.find((m: { id: string }) => m.id === 'refile-backups');
    expect(restructure).toBeDefined();
    expect(restructure).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
      enabled: expect.any(Boolean),
      status: expect.any(String),
    });
    const semanticBackfill = body.migrations.find(
      (m: { id: string }) => m.id === 'backfill-meilisearch-vectors',
    );
    expect(semanticBackfill).toMatchObject({
      title: 'Backfill semantic-search index',
      enabled: expect.any(Boolean),
      status: expect.any(String),
    });
  });

  it('GET /migration/migrations serves persisted remaining counts, null before the first count (#3491)', async () => {
    if (!dbReachable) return;
    const { patchMigrationState } = await import('./migration-config.repo.ts');
    const { _resetDemandThrottleForTests } = await import('./routes-status.ts');
    const { readStatusCountsDemand } = await import('./worker-status.repo.ts');
    const at = new Date().toISOString();
    await patchMigrationState('refile-backups', { remaining: 7, remaining_at: at });
    await patchMigrationState('backfill-meilisearch-vectors', { failed_permanently: 2 });
    _resetDemandThrottleForTests();
    try {
      const res = await app.handle(
        new Request('http://localhost/api/workers/migration/migrations'),
      );
      const body = await res.json();
      const byId = new Map(
        (body.migrations as Array<{ id: string } & Record<string, unknown>>).map((m) => [m.id, m]),
      );
      expect(byId.get('refile-backups')).toMatchObject({ remaining: 7, remaining_at: at });
      // Never counted → null, not a fabricated 0.
      expect(byId.get('refile-legacy-daydir')).toMatchObject({
        remaining: null,
        remaining_at: null,
      });
      expect(byId.get('backfill-meilisearch-vectors')).toMatchObject({ failedPermanently: 2 });
      // Migrations without a dead-letter queue never carry the field.
      expect('failedPermanently' in byId.get('refile-backups')!).toBe(false);
      // Listing is a demand signal too — the worker refreshes while it's watched.
      expect(await readStatusCountsDemand()).toBeGreaterThan(Date.now());
    } finally {
      await (await getDb()).collection('app_settings').deleteOne({ _id: 'migration' as never });
    }
  });

  it('PATCH /migration/migrations/:id → 404 for an unknown migration', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/workers/migration/migrations/nope', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('PATCH /migration/migrations/:id → 400 when neither enabled nor reset given', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/workers/migration/migrations/refile-backups', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('Reset clears the semantic-backfill cursor as well as generic migration state', async () => {
    if (!dbReachable) return;
    const db = await getDb();
    await db.collection('meilisearch_backfill_state').insertOne({
      _id: 'assets',
      cursor: null,
      scanned: 10,
      completed_at: '2026-07-26T00:00:00.000Z',
    });

    const res = await app.handle(
      new Request(
        'http://localhost/api/workers/migration/migrations/backfill-meilisearch-vectors',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reset: true }),
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(await db.collection('meilisearch_backfill_state').findOne({ _id: 'assets' })).toBeNull();
  });
});
