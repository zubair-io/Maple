/**
 * `/api/workers/performance` — validation, the clamp, and the live pool resize
 * (#673).
 *
 * The route clamps before persisting and resizes the process-wide `ffiPool()`
 * singleton after, so both halves are observable in one request. The
 * skip-passing the Mongo version needed — "if the write failed with a 500,
 * assert the 500 instead" — is gone: a per-test database is always reachable,
 * so every branch is asserted rather than tolerated.
 */

import { beforeEach, describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { workerRoutes } from './routes.ts';
import { ffiPool, _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { MAX_FFI_WORKERS, MIN_FFI_WORKERS } from '../ffi/ffi-pool-config.repo.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { writeWorkerMemory } from '../db/repos/worker-status.repo.ts';

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

  it('rejects a body with neither setting (400)', async () => {
    using _live = await createLiveTestDatabase();
    expect((await patch({})).status).toBe(400);
  });

  it('rejects a non-numeric ffi_workers (422 schema)', async () => {
    expect((await patch({ ffi_workers: 'four' })).status).toBe(422);
  });
});

describe('PATCH /api/workers/performance — clamp + live resize', () => {
  beforeEach(() => _resetFfiPoolForTests());

  it('clamps an over-range value to MAX and resizes the live pool', async () => {
    using _live = await createLiveTestDatabase();
    const res = await patch({ ffi_workers: 999 });
    expect(res.status).toBe(200);
    expect((await res.json()).ffi_workers).toBe(MAX_FFI_WORKERS);
    expect(ffiPool().poolSize()).toBe(MAX_FFI_WORKERS);
  });

  it('clamps an under-range value to MIN', async () => {
    using _live = await createLiveTestDatabase();
    const res = await patch({ ffi_workers: 0 });
    expect(res.status).toBe(200);
    expect((await res.json()).ffi_workers).toBe(MIN_FFI_WORKERS);
    expect(ffiPool().poolSize()).toBe(MIN_FFI_WORKERS);
  });

  it('reports the persisted value as the source on the next read', async () => {
    using _live = await createLiveTestDatabase();
    await patch({ ffi_workers: 3 });

    const body = await (
      await app().handle(new Request('http://localhost/api/workers/performance'))
    ).json();

    expect(body.ffi_workers).toBe(3);
    expect(body.source).toBe('db');
  });
});

describe('GET /api/workers/performance', () => {
  it('returns ffi_workers, source, clamp bounds, and live pool stats', async () => {
    using _live = await createLiveTestDatabase();
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
  });
});

describe('decode memory budget (#5467)', () => {
  beforeEach(() => _resetFfiPoolForTests());

  it('saves the percent alone and reports it with the container limit it applies to', async () => {
    using _live = await createLiveTestDatabase();
    const res = await patch({ decode_memory_budget_percent: 35 });
    expect(res.status).toBe(200);
    const body = (await (
      await app().handle(new Request('http://localhost/api/workers/performance'))
    ).json()) as {
      ffi_workers: number;
      decode_memory_budget: {
        percent: number;
        source: string;
        budget_bytes: number;
        container_limit_bytes: number;
        live: unknown;
      };
    };
    expect(body.ffi_workers).toBe(1);
    expect(body.decode_memory_budget.percent).toBe(35);
    expect(body.decode_memory_budget.source).toBe('db');
    expect(body.decode_memory_budget.budget_bytes).toBe(
      Math.floor((body.decode_memory_budget.container_limit_bytes * 35) / 100),
    );
    expect(body.decode_memory_budget.live).toBeNull();
  });

  it('accepts 0 to remove the cap', async () => {
    using _live = await createLiveTestDatabase();
    const body = await (await patch({ decode_memory_budget_percent: 0 })).json();
    expect(body.decode_memory_budget.percent).toBe(0);
    expect(body.decode_memory_budget.budget_bytes).toBeNull();
  });

  it('rejects a non-numeric percent (422 schema)', async () => {
    using _live = await createLiveTestDatabase();
    expect((await patch({ decode_memory_budget_percent: 'lots' })).status).toBe(422);
  });

  it("reads the worker's last persisted reservation", async () => {
    using _live = await createLiveTestDatabase();
    const sample = { rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0, at: 1234 };
    await writeWorkerMemory({
      rows: [{ process: 'worker', pid: 1, ...sample }],
      decodeBudget: { limitBytes: 100, reservedBytes: 40, running: 2, waiting: 3 },
    });
    const body = await (
      await app().handle(new Request('http://localhost/api/workers/performance'))
    ).json();
    expect(body.decode_memory_budget.live).toEqual({
      limit_bytes: 100,
      reserved_bytes: 40,
      running: 2,
      waiting: 3,
      at: 1234,
    });
  });
});
