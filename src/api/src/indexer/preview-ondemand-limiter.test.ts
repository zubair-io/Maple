// preview-ondemand-limiter.test.ts
//
// Unit coverage for the on-demand preview-regeneration semaphore (#2012).
// Three layers:
//   - Pure concurrency-gate behavior, exercised directly against a fresh
//     `PreviewOndemandLimiter` instance (no DB, no HTTP) via synthetic slow
//     jobs — this is the "simulate N concurrent cache-miss requests and
//     assert regeneration is actually bounded" coverage the ticket calls for.
//   - Seeding from the `preview` stage's persisted `worker_config` row, over a
//     per-test SQLite database installed as the process-wide handle (#3787).
//   - The gate that keeps a request arriving before startup — or after
//     shutdown — off a database that isn't there.
//
// Route-level integration coverage (real HTTP requests through
// `routes/library/preview.ts`) lives in
// `routes/library/preview-ondemand-limiter.test.ts`.

import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  DEFAULT_ONDEMAND_LIMIT,
  previewOndemandLimiter,
  _resetPreviewOndemandLimiterForTests,
  type PreviewOndemandLimiter,
} from './preview-ondemand-limiter.ts';
import { isSqliteOpen } from '../db/sqlite/index.ts';
import { createLiveTestDatabase, run } from '../db/sqlite/test-sqlite.test-helpers.ts';

/** Yield the event loop a tick — enough for a pending `acquire()`'s promise
 * continuation to run without a real timer. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The `preview` stage concurrency an operator would have saved on Settings →
 * Workers. Every other column is nullable, so a row may carry this alone. */
function setPreviewConcurrency(db: Database, concurrency: number): void {
  run(
    db,
    `INSERT INTO worker_config (name, concurrency) VALUES ('preview', ?)
       ON CONFLICT (name) DO UPDATE SET concurrency = excluded.concurrency`,
    concurrency,
  );
}

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

describe('PreviewOndemandLimiter — seeding from the `preview` stage config', () => {
  afterEach(() => {
    _resetPreviewOndemandLimiterForTests();
  });

  it('seeds its cap from worker_config.preview.concurrency on first run()', async () => {
    using live = await createLiveTestDatabase();
    setPreviewConcurrency(live.db, 7);

    const limiter = previewOndemandLimiter();
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT); // not seeded yet

    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(7);
  });

  it('falls back to the built-in default when no worker_config row exists', async () => {
    // Opened and left empty: a fresh install has the table but not the row.
    using live = await createLiveTestDatabase();
    expect(live.db.query(`SELECT COUNT(*) AS n FROM worker_config`).get()).toEqual({ n: 0 });

    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);
  });

  it('only reads the DB once — a later external DB edit does not retroactively reseed', async () => {
    using live = await createLiveTestDatabase();
    setPreviewConcurrency(live.db, 9);

    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {});
    expect(limiter.currentLimit()).toBe(9);

    setPreviewConcurrency(live.db, 2);
    await limiter.run(async () => {});
    // Still 9 — live changes only apply via the explicit `setLimit` hook
    // (routes-main.ts's PATCH /:name/config handler), not a re-poll here.
    expect(limiter.currentLimit()).toBe(9);
  });
});

describe('PreviewOndemandLimiter — no open database does not break the hot path (Copilot review, PR #2015)', () => {
  afterEach(() => {
    _resetPreviewOndemandLimiterForTests();
  });

  it('run() stays at the default when no database is open, without reaching for the pool', async () => {
    // No test handle installed and no pool open. `sqliteDb()` throws in that
    // state, so `ensureSeeded`'s `isSqliteOpen()` gate is the only reason the
    // request path survives at all — this is the assertion that catches the
    // gate being dropped.
    expect(isSqliteOpen()).toBe(false);

    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {});

    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);
  });

  it('a later call, once the database is open, still gets a real chance to seed (the skip is not memoized as done)', async () => {
    const limiter = previewOndemandLimiter();
    await limiter.run(async () => {}); // nothing open — skipped, stays at default
    expect(limiter.currentLimit()).toBe(DEFAULT_ONDEMAND_LIMIT);

    // The pool comes up (startup finished, or a request arrived after it did).
    using live = await createLiveTestDatabase();
    setPreviewConcurrency(live.db, 6);

    await limiter.run(async () => {}); // should now seed for real
    expect(limiter.currentLimit()).toBe(6);
  });
});
