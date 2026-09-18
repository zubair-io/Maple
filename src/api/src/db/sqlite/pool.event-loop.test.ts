/**
 * The measurement this whole module exists for.
 *
 * Every in-process SQLite API available to Bun blocks the event loop. Taken on
 * Bun 1.4.3 with a query engineered to run for about one second, counting
 * 10 ms timer ticks while it ran: `bun:sqlite` 0 ticks of an expected ~102,
 * `Bun.sql` against a `sqlite://` URL 0 ticks (a promise wrapper over the same
 * synchronous engine), `node:sqlite` `DatabaseSync` 0 ticks, and `bun:sqlite`
 * inside a Worker 101 ticks of an expected ~114.
 *
 * This test re-takes the two ends of that table — in process versus through
 * the pool — so the finding is a gate rather than a note in a ticket. If
 * someone ever "simplifies" the pool by calling `bun:sqlite` on the main
 * thread, the tick count goes to zero and this fails.
 *
 * The thresholds are deliberately loose (half the expected ticks, against a
 * blocking baseline of zero) because the point is the difference between
 * "nothing ran" and "the loop kept going", not a throughput number that would
 * flake on a busy CI box.
 */

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';

import { cleanupTempDatabases, ONE_SECOND_QUERY, openTestPool } from './pool.test-helpers.ts';

/** Sampling interval, matching how the original measurement was taken. */
const TICK_MS = 10;

afterAll(cleanupTempDatabases);

interface TickSample {
  ticks: number;
  elapsedMs: number;
  /** Ticks a completely unblocked loop would have fired in that time. */
  expectedTicks: number;
}

/** Count timer ticks that actually fire while `run` is outstanding. */
async function sampleTicks(run: () => unknown | Promise<unknown>): Promise<TickSample> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, TICK_MS);
  const startedNs = Bun.nanoseconds();
  await run();
  const elapsedMs = (Bun.nanoseconds() - startedNs) / 1_000_000;
  clearInterval(timer);
  return { ticks, elapsedMs, expectedTicks: Math.floor(elapsedMs / TICK_MS) };
}

test('the event loop keeps ticking while a slow query runs on the pool', async () => {
  const pool = await openTestPool();
  const inProcess = new Database(':memory:');
  try {
    // Warm both paths so neither measurement includes connection setup or
    // statement preparation.
    await pool.read('SELECT 1 AS x');
    inProcess.query('SELECT 1 AS x').get();

    const viaWorker = await sampleTicks(() => pool.read(ONE_SECOND_QUERY));
    const onMainThread = await sampleTicks(() => inProcess.query(ONE_SECOND_QUERY).get());

    console.log(
      `[#3742] via worker pool: ${viaWorker.ticks} ticks of an expected ` +
        `${viaWorker.expectedTicks} over ${Math.round(viaWorker.elapsedMs)}ms; ` +
        `in process (bun:sqlite): ${onMainThread.ticks} ticks of an expected ` +
        `${onMainThread.expectedTicks} over ${Math.round(onMainThread.elapsedMs)}ms`,
    );

    // The query really is heavy enough to be a meaningful probe.
    expect(viaWorker.expectedTicks).toBeGreaterThan(50);
    expect(onMainThread.expectedTicks).toBeGreaterThan(50);

    // Through the pool the loop stays live...
    expect(viaWorker.ticks).toBeGreaterThan(viaWorker.expectedTicks / 2);
    // ...and in process it does not. A couple of ticks of slack covers timer
    // bookkeeping either side of the synchronous call.
    expect(onMainThread.ticks).toBeLessThanOrEqual(2);
  } finally {
    inProcess.close();
    pool.close();
  }
}, 30_000);

test('an HTTP-shaped request can complete while a slow query is in flight', async () => {
  const pool = await openTestPool();
  try {
    // The concrete version of the tick count: a cheap handler must not wait
    // behind a facet-sized query, which is exactly what a blocking driver in
    // this single-process API would make it do.
    const order: string[] = [];
    const slow = pool.read(ONE_SECOND_QUERY).then(() => order.push('slow query'));
    const request = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() =>
      order.push('cheap handler'),
    );
    await Promise.all([slow, request]);

    expect(order).toEqual(['cheap handler', 'slow query']);
  } finally {
    pool.close();
  }
}, 30_000);
