/**
 * `/api/workers/migration/migrations` — split out of `routes.test.ts` to keep
 * that file under the size budget (#3491).
 *
 * The `remaining` counts these routes serve are the worker's persisted values,
 * never a live count: most `countRemaining()` implementations are
 * whole-collection scans, and running them per page load is what made this
 * endpoint an eight-second one.
 */
import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { readStatusCountsDemand } from '../db/repos/worker-status.repo.ts';

const app = new Elysia().use(workerRoutes());

async function listMigrations(): Promise<Map<string, Record<string, unknown>>> {
  const res = await app.handle(new Request('http://localhost/api/workers/migration/migrations'));
  expect(res.status).toBe(200);
  const body = await res.json();
  return new Map(
    (body.migrations as Array<{ id: string } & Record<string, unknown>>).map((m) => [m.id, m]),
  );
}

async function patchMigration(id: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/workers/migration/migrations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /migration/migrations', () => {
  it('lists the registry', async () => {
    using _live = await createLiveTestDatabase();
    const byId = await listMigrations();
    expect(byId.get('refile-backups')).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
      enabled: expect.any(Boolean),
      status: expect.any(String),
    });
  });

  it('serves persisted remaining counts, null before the first count (#3491)', async () => {
    using _live = await createLiveTestDatabase();
    const { patchMigrationState } = await import('./migration-config.repo.ts');
    const { _resetDemandThrottleForTests } = await import('./routes-status.ts');
    const at = new Date().toISOString();
    await patchMigrationState('refile-backups', { remaining: 7, remaining_at: at });
    _resetDemandThrottleForTests();

    const byId = await listMigrations();

    expect(byId.get('refile-backups')).toMatchObject({ remaining: 7, remaining_at: at });
    // Never counted → null, not a fabricated 0.
    expect(byId.get('refile-legacy-daydir')).toMatchObject({ remaining: null, remaining_at: null });
    // Listing is a demand signal too — the worker refreshes while it is watched.
    expect(await readStatusCountsDemand()).toBeGreaterThan(Date.now());
  });
});

describe('PATCH /migration/migrations/:id', () => {
  it('404s an unknown migration', async () => {
    expect((await patchMigration('nope', { enabled: true })).status).toBe(404);
  });

  it('400s when neither enabled nor reset is given', async () => {
    expect((await patchMigration('refile-backups', {})).status).toBe(400);
  });

  it('enables a migration and reports the state it wrote', async () => {
    using _live = await createLiveTestDatabase();

    const res = await patchMigration('refile-legacy-daydir', { enabled: true });

    expect(res.status).toBe(200);
    expect((await res.json()).state).toMatchObject({ enabled: true });
    expect((await listMigrations()).get('refile-legacy-daydir')).toMatchObject({ enabled: true });
  });

  it('resets a migration back to a pristine idle state', async () => {
    using _live = await createLiveTestDatabase();
    const { patchMigrationState } = await import('./migration-config.repo.ts');
    await patchMigrationState('refile-legacy-daydir', {
      enabled: true,
      status: 'running',
      processed: 120,
      errors: 3,
    });

    const res = await patchMigration('refile-legacy-daydir', { reset: true });

    expect(res.status).toBe(200);
    expect((await res.json()).state).toMatchObject({
      enabled: false,
      status: 'idle',
      processed: 0,
      errors: 0,
    });
  });
});
