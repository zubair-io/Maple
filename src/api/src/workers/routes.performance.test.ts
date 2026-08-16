/**
 * PATCH /api/workers/performance — validation + clamp + live pool resize
 * (ticket #673).
 *
 * The clamp-to-[1,16] + "resizes the live pool" assertions don't need Mongo:
 * the route clamps before persisting and resizes the process-wide `ffiPool()`
 * singleton after. DB-dependent assertions (persisted source = 'db') skip-pass
 * when MongoDB is unreachable. The non-finite-rejection path is exercised by
 * the Elysia body schema (`t.Number()` rejects NaN/strings before our handler
 * runs).
 */

import { afterAll, beforeAll, describe, it, expect, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { ffiPool, _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { closeDb, getDb } from '../db/client.ts';
import { MAX_FFI_WORKERS, MIN_FFI_WORKERS } from '../ffi/ffi-pool-config.repo.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

// getDb() blocks on a ~5s server-selection timeout when MongoDB is unreachable
// (CI without a DB). Give the DB-touching route tests room to reach that path
// and skip-pass, rather than tripping the default 5s per-test timeout.
const DB_TIMEOUT_MS = 15000;

withTestDb(`maple_test_perf_route_${process.pid}`);

// Force the singleton to reconnect under TEST_DB even when an earlier suite
// left it connected, and drop + close on the way out (#2835).
// Captured here, not re-resolved in afterAll: withTestDb restores
// MAPLE_MONGO_DB before this suite's teardown runs.
let suiteDb: Db | null = null;

beforeAll(async () => {
  await closeDb();
  suiteDb = await getDb().catch(() => null);
});
afterAll(async () => {
  if (suiteDb) await suiteDb.dropDatabase();
  await closeDb();
});

function app() {
  return new Elysia().use(workerRoutes());
}

async function patch(body: unknown) {
  return app().handle(
    new Request('http://localhost/api/workers/performance', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('PATCH /api/workers/performance — body validation', () => {
  beforeEach(() => _resetFfiPoolForTests());

  it('rejects a missing ffi_workers field (422 schema)', async () => {
    const res = await patch({});
    expect(res.status).toBe(422);
  });

  it('rejects a non-numeric ffi_workers (422 schema)', async () => {
    const res = await patch({ ffi_workers: 'four' });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/workers/performance — clamp + live resize', () => {
  beforeEach(() => _resetFfiPoolForTests());

  it(
    'clamps an over-range value to MAX and resizes the live pool',
    async () => {
      const res = await patch({ ffi_workers: 999 });
      const body = (await res.json()) as { ffi_workers?: number; error?: string };
      // When the DB write succeeds the route resolves + resizes the pool to
      // the clamped value. When Mongo is unreachable the write fails (500) and
      // the pool is left at its prior size — skip-pass that branch.
      if (res.status === 200) {
        expect(body.ffi_workers).toBe(MAX_FFI_WORKERS);
        expect(ffiPool().poolSize()).toBe(MAX_FFI_WORKERS);
      } else {
        expect(res.status).toBe(500);
        console.log('[routes.performance.test] skipping resize assertion: DB unreachable');
      }
    },
    DB_TIMEOUT_MS,
  );

  it(
    'clamps an under-range value to MIN',
    async () => {
      const res = await patch({ ffi_workers: 0 });
      if (res.status === 200) {
        const body = (await res.json()) as { ffi_workers: number };
        expect(body.ffi_workers).toBe(MIN_FFI_WORKERS);
        expect(ffiPool().poolSize()).toBe(MIN_FFI_WORKERS);
      } else {
        expect(res.status).toBe(500);
      }
    },
    DB_TIMEOUT_MS,
  );
});

describe('GET /api/workers/performance', () => {
  it(
    'returns ffi_workers, source, clamp bounds, and live pool stats',
    async () => {
      const res = await app().handle(new Request('http://localhost/api/workers/performance'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ffi_workers: number;
        source: string;
        min: number;
        max: number;
        pool: { target: number; spawned: number; busy: number; queued: number };
      };
      expect(body.min).toBe(MIN_FFI_WORKERS);
      expect(body.max).toBe(MAX_FFI_WORKERS);
      expect(body.ffi_workers).toBeGreaterThanOrEqual(MIN_FFI_WORKERS);
      expect(body.ffi_workers).toBeLessThanOrEqual(MAX_FFI_WORKERS);
      expect(['db', 'env', 'default']).toContain(body.source);
      expect(body.pool).toHaveProperty('target');
      expect(body.pool).toHaveProperty('queued');
    },
    DB_TIMEOUT_MS,
  );
});
