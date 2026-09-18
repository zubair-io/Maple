/**
 * Reader concurrency — the reason for more than one reader worker.
 *
 * WAL lets read-only connections run at the same time as each other and as the
 * writer. What that buys the product is that a facet count taking a few
 * hundred milliseconds cannot park a grid page behind it. Two assertions carry
 * that: a cheap read overtaking a slow one, which can only happen if both are
 * being processed at once, and an even spread of concurrent reads across the
 * workers, which is what would catch a routing bug that queued everything onto
 * one of them.
 *
 * Deliberately NOT asserted: a wall-clock speedup from two readers versus one.
 * That ratio measures how many cores happen to be free on the machine running
 * the suite, not whether the pool is correct — it flips red on a loaded box
 * while the code is fine. Both assertions below hold on a single core.
 *
 * Test shape note — round trips first, assertions afterwards, because Bun
 * 1.4.3 can drop a worker message when an `expect()` runs between two round
 * trips.
 */

import { afterAll, expect, test } from 'bun:test';

import { cleanupTempDatabases, countingQuery, openTestPool } from './pool.test-helpers.ts';

/** A couple of hundred milliseconds of SQLite CPU — facet-query territory. */
const SLOW_QUERY = countingQuery(3_000_000);

/** How many concurrent reads the routing assertion fires at a two-reader pool. */
const BATCH_SIZE = 4;

afterAll(cleanupTempDatabases);

test('a cheap read overtakes a slow one when there is a spare reader', async () => {
  const pool = await openTestPool({ readers: 2 });
  try {
    const order: string[] = [];
    await Promise.all([
      pool.read(SLOW_QUERY).then(() => order.push('slow')),
      pool.read('SELECT 1 AS x').then(() => order.push('cheap')),
    ]);

    expect(order).toEqual(['cheap', 'slow']);
  } finally {
    pool.close();
  }
}, 30_000);

test('a single reader serialises the same pair', async () => {
  const pool = await openTestPool({ readers: 1 });
  try {
    const order: string[] = [];
    await Promise.all([
      pool.read(SLOW_QUERY).then(() => order.push('slow')),
      pool.read('SELECT 1 AS x').then(() => order.push('cheap')),
    ]);

    // Same two calls, one worker: the cheap read now waits its turn. This is
    // the control that shows the test above is measuring concurrency and not
    // just scheduling luck.
    expect(order).toEqual(['slow', 'cheap']);
  } finally {
    pool.close();
  }
}, 30_000);

test('concurrent reads are spread across readers rather than queued on one', async () => {
  const pool = await openTestPool({ readers: 2 });
  try {
    const inFlight = Array.from({ length: BATCH_SIZE }, () => pool.read(SLOW_QUERY));
    const duringBatch = pool.stats();
    await Promise.all(inFlight);
    const afterBatch = pool.stats();

    // Four reads, two readers: an even split. A routing bug that always picked
    // the same worker would show as 4 and 0 here, and the overtaking test
    // above would still pass by luck on a fast query.
    expect(duringBatch.readers.map((reader) => reader.inFlight)).toEqual([2, 2]);
    expect(afterBatch.inFlight).toBe(0);
    expect(afterBatch.readers.every((reader) => reader.completed > 0)).toBe(true);
  } finally {
    pool.close();
  }
}, 30_000);

test('writes proceed while a slow read is in flight', async () => {
  const pool = await openTestPool();
  try {
    await pool.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');

    const order: string[] = [];
    await Promise.all([
      pool.read(SLOW_QUERY).then(() => order.push('read')),
      pool.write('INSERT INTO t (id) VALUES (1)').then(() => order.push('write')),
    ]);
    const rows = await pool.read<{ id: number }>('SELECT id FROM t');

    // WAL is what makes this true: on a rollback-journal database the writer
    // would have to wait for the reader to release its lock.
    expect(order).toEqual(['write', 'read']);
    expect(rows).toEqual([{ id: 1 }]);
  } finally {
    pool.close();
  }
}, 30_000);
