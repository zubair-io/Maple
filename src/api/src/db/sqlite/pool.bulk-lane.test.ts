/**
 * The bulk-read lane: a fan-out of slow reads leaves one reader for everything
 * else (#4413).
 *
 * The incident: a facet request's thirteen aggregations went straight onto
 * every reader's queue, and the grid page of the same search waited behind all
 * of them. Same test shape as `pool.concurrency.test.ts` — round trips first,
 * assertions afterwards (Bun 1.4.3 can drop a worker message when an `expect()`
 * runs between two round trips) — and, like it, no wall-clock thresholds.
 */

import { afterAll, expect, test } from 'bun:test';

import { cleanupTempDatabases, countingQuery, openTestPool } from './pool.test-helpers.ts';

const SLOW_QUERY = countingQuery(3_000_000);

afterAll(cleanupTempDatabases);

test('bulk reads never occupy every reader, so a plain read overtakes them', async () => {
  const pool = await openTestPool({ readers: 3 });
  try {
    const order: string[] = [];
    const bulk = Array.from({ length: 6 }, (_unused, i) =>
      pool.readBulk(SLOW_QUERY).then(() => order.push(`bulk${i}`)),
    );
    // The lane admits on a later microtask than the call, so sample once the
    // admitted reads have reached their workers — well inside one slow query.
    await Bun.sleep(20);
    const duringBulk = pool.stats();
    const page = pool.read('SELECT 1 AS x').then(() => order.push('page'));
    await Promise.all([...bulk, page]);

    expect(pool.bulkReadLimit).toBe(2);
    expect(duringBulk.inFlight).toBe(2);
    expect(duringBulk.readers.filter((reader) => reader.inFlight === 0).length).toBe(1);
    expect(order[0]).toBe('page');
    expect(order.length).toBe(7);
  } finally {
    pool.close();
  }
}, 60_000);

test('a single-reader pool still runs its bulk reads, one at a time', async () => {
  const pool = await openTestPool({ readers: 1 });
  try {
    const rows = await Promise.all([
      pool.readBulk('SELECT 1 AS x'),
      pool.readBulk('SELECT 2 AS x'),
    ]);

    expect(pool.bulkReadLimit).toBe(1);
    expect(rows).toEqual([[{ x: 1 }], [{ x: 2 }]]);
  } finally {
    pool.close();
  }
}, 30_000);
