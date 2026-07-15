// preview-ondemand-limiter.test.ts
//
// Unit coverage for the on-demand preview-regeneration semaphore (#2012).
// Two layers:
//   - Pure concurrency-gate behavior, exercised directly against a fresh
//     `PreviewOndemandLimiter` instance (no DB, no HTTP) via synthetic slow
//     jobs — this is the "simulate N concurrent cache-miss requests and
//     assert regeneration is actually bounded" coverage the ticket calls for.
//   - DB-seeding from the `preview` stage's persisted `worker_config` row,
//     using the same per-process isolated-DB + skip-if-Mongo-unreachable
//     pattern as `libraries.cache.test.ts`.
//
// Route-level integration coverage (real HTTP requests through
// `routes/library/preview.ts`) lives in
// `routes/library/preview-ondemand-limiter.test.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { MongoClient } from 'mongodb';

const TEST_DB = `maple_test_preview_ondemand_limiter_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

import {
  DEFAULT_ONDEMAND_LIMIT,
  previewOndemandLimiter,
  _resetPreviewOndemandLimiterForTests,
  type PreviewOndemandLimiter,
} from './preview-ondemand-limiter.ts';
import { WorkerConfigRepo } from '../workers/worker-config.repo.ts';
import { getDb, closeDb, isDbConnected } from '../db/client.ts';

/** Yield the event loop a tick — enough for a pending `acquire()`'s promise
 * continuation to run without a real timer. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PreviewOndemandLimiter — bounded concurrency', () => {
  afterEach(() => {
    _resetPreviewOndemandLimiterForTests();
  });

  it('never runs more than `limit` jobs concurrently, and every job eventually completes', async () => {
    const limiter: PreviewOndemandLimiter = previewOndemandLimiter();
    limiter.setLimit(3);

    const TOTAL_JOBS = 12;
    let active = 0;
    let peak = 0;
    let completed = 0;

    const job = () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        // Simulate real decode+encode work with a small artificial delay so
        // jobs genuinely overlap instead of trivially resolving in order.
        await new Promise((r) => setTimeout(r, 15));
        active--;
        completed++;
      });

    await Promise.all(Array.from({ length: TOTAL_JOBS }, job));

    expect(peak).toBeLessThanOrEqual(3);
    // Sanity: this really exercised parallelism, not accidental
    // serialization down to 1.
    expect(peak).toBeGreaterThan(1);
    expect(completed).toBe(TOTAL_JOBS);
  });

  it('defaults to DEFAULT_ONDEMAND_LIMIT before any setLimit/DB seed', () => {
    const limiter = previewOndemandLimiter();
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);
  });

  it('raising the limit live drains queued waiters immediately', async () => {
    const limiter = previewOndemandLimiter();
    limiter.setLimit(1);

    let active = 0;
    let peak = 0;
    const started: number[] = [];

    const job = (id: number) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        started.push(id);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      });

    const p1 = job(1);
    await tick(); // let job 1 acquire its permit and start
    const p2 = job(2); // queues — limit is 1 and job 1 is in flight
    await tick();
    expect(started).toEqual([1]); // job 2 hasn't started yet

    limiter.setLimit(5); // raise the cap — job 2 should be admitted right away
    await tick();
    expect(started).toEqual([1, 2]);

    await Promise.all([p1, p2]);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('lowering the limit does not abort in-flight work, only admits fewer new jobs', async () => {
    const limiter = previewOndemandLimiter();
    limiter.setLimit(4);

    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      }),
    );
    await tick();
    expect(active).toBe(4); // all 4 admitted under the original cap

    limiter.setLimit(1); // lower the cap — must not cancel the 4 already running
    await Promise.all(jobs);
    expect(peak).toBe(4);
  });

  it('ignores a non-finite or sub-1 setLimit call (keeps the previous cap)', () => {
    const limiter = previewOndemandLimiter();
    limiter.setLimit(5);
    limiter.setLimit(0);
    expect(limiter.currentLimit()).toBe(5);
    limiter.setLimit(Number.NaN);
    expect(limiter.currentLimit()).toBe(5);
    limiter.setLimit(-3);
    expect(limiter.currentLimit()).toBe(5);
  });

  it('floors a fractional setLimit', () => {
    const limiter = previewOndemandLimiter();
    limiter.setLimit(2.9);
    expect(limiter.currentLimit()).toBe(2);
  });
});

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db(TEST_DB).command({ ping: 1 });
    return c;
  } catch {
    await c.close().catch(() => {});
    return null;
  }
}

describe('PreviewOndemandLimiter — DB seeding from the `preview` stage config', () => {
  let mongo: MongoClient | null = null;

  beforeAll(async () => {
    mongo = await tryConnect();
    if (mongo) await getDb();
  });

  afterAll(async () => {
    if (mongo) {
      await mongo
        .db(TEST_DB)
        .dropDatabase()
        .catch(() => {});
      await mongo.close().catch(() => {});
    }
    await closeDb().catch(() => {});
  });

  afterEach(() => {
    _resetPreviewOndemandLimiterForTests();
  });

  it('seeds its cap from worker_config.preview.concurrency on first run()', async () => {
    if (!mongo) return; // skip-if-unreachable

    const repo = new WorkerConfigRepo((await getDb()).collection('worker_config') as never);
    await repo.upsert('preview', {
      concurrency: 7,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 3,
    });

    const limiter = previewOndemandLimiter();
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT); // not seeded yet

    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(7);
  });

  it('falls back to the built-in default when no worker_config row exists', async () => {
    if (!mongo) return;
    await (await getDb()).collection('worker_config').deleteOne({ name: 'preview' });

    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);
  });

  it('only reads the DB once — a later external DB edit does not retroactively reseed', async () => {
    if (!mongo) return;

    const repo = new WorkerConfigRepo((await getDb()).collection('worker_config') as never);
    await repo.upsert('preview', {
      concurrency: 9,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 3,
    });

    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(9);

    await repo.patch('preview', { concurrency: 2 });
    await limiter.run(async () => {});
    // Still 9 — live changes only apply via the explicit `setLimit` hook
    // (routes-main.ts's PATCH /:name/config handler), not a re-poll here.
    expect(limiter.currentLimit()).toBe(9);
  });
});

describe('PreviewOndemandLimiter — DB-down does not stall the hot path (Copilot review, PR #2015)', () => {
  afterEach(() => {
    _resetPreviewOndemandLimiterForTests();
  });

  it('run() resolves quickly and stays at the default when isDbConnected() is false, without attempting a connect', async () => {
    // Force a known-disconnected state regardless of what an earlier
    // describe block in this file left behind.
    await closeDb().catch(() => {});
    expect(isDbConnected()).toBe(false);

    const limiter = previewOndemandLimiter();
    const started = Date.now();
    await limiter.run(async () => {});
    const elapsedMs = Date.now() - started;

    // The driver's connect/server-selection timeout in `getDb()` is 5000ms;
    // resolving well under that proves `ensureSeeded()` never attempted a
    // connect. Generous bound to absorb CI jitter without risking a false
    // pass if the gate regresses back to an unconditional connect attempt.
    expect(elapsedMs).toBeLessThan(1000);
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);
  });

  it('a later call, once the DB connects, still gets a real chance to seed (the skip is not memoized as done)', async () => {
    const probe = await tryConnect();
    if (!probe) return; // skip-if-unreachable
    await probe.close().catch(() => {});

    await closeDb().catch(() => {});
    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {}); // DB down — skipped, stays at default
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);

    // DB comes up.
    await getDb();
    const repo = new WorkerConfigRepo((await getDb()).collection('worker_config') as never);
    await repo.upsert('preview', {
      concurrency: 6,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 3,
    });

    await limiter.run(async () => {}); // should now seed for real
    expect(limiter.currentLimit()).toBe(6);

    await closeDb().catch(() => {});
  });
});
