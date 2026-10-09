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

import { SqlitePool } from './pool.ts';
import {
  cleanupTempDatabases,
  countingQuery,
  fakeWorkers,
  openTestPool,
  type FakeWorker,
} from './pool.test-helpers.ts';

const SLOW_QUERY = countingQuery(3_000_000);

/** Long enough that nothing a test parks on a silent reader times out under it. */
const PARKED_MS = 60_000;

/** Let admitted bulk reads reach their workers and any queued close events land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function readsReceived(spawned: readonly FakeWorker[]): number {
  return spawned
    .filter((worker) => worker.role === 'reader')
    .flatMap((worker) => worker.received)
    .filter((request) => request.kind === 'read').length;
}

/** A three-reader pool of fakes whose dead readers stay down unless `respawnDelaysMs` says otherwise. */
function openFakePool(spawn: Parameters<typeof SqlitePool.open>[0]['spawnWorker'], extra = {}) {
  return SqlitePool.open({
    path: '/unused',
    readers: 3,
    spawnWorker: spawn,
    requestTimeoutMs: PARKED_MS,
    respawnDelaysMs: [PARKED_MS],
    ...extra,
  });
}

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

test('a dead reader shrinks the lane, so the survivors still leave one free for a plain read', async () => {
  const { spawned, spawn } = fakeWorkers();
  const pool = await openFakePool(spawn);
  const [, dead, ...survivors] = spawned;
  dead?.exit();
  for (const survivor of survivors) survivor.goSilent();
  const bulk = Array.from({ length: 4 }, () => pool.readBulk('SELECT 1').catch(() => null));
  await settle();
  const limitWhileDown = pool.bulkReadLimit;
  const duringBulk = pool.stats();
  const page = pool.read('SELECT 2').catch(() => null);
  const withPage = pool.stats();
  pool.close();
  await Promise.all([...bulk, page]);

  expect(limitWhileDown).toBe(1);
  expect(duringBulk.inFlight).toBe(1);
  // One bulk statement on one survivor, the page on the other — not queued behind it.
  expect(withPage.readers.map((reader) => reader.inFlight)).toEqual([0, 1, 1]);
});

test('a reader lost mid-fan-out leaves admitted bulk reads running and admits no more', async () => {
  const { spawned, spawn } = fakeWorkers();
  const pool = await openFakePool(spawn);
  const readers = spawned.filter((worker) => worker.role === 'reader');
  for (const reader of readers) reader.goSilent();
  const bulk = Array.from({ length: 4 }, () => pool.readBulk('SELECT 1').catch(() => null));
  await settle();
  const idle = pool.stats().readers.findIndex((reader) => reader.inFlight === 0);
  readers[idle]?.exit();
  await settle();
  const afterDeath = { limit: pool.bulkReadLimit, inFlight: pool.stats().inFlight };
  const received = readsReceived(spawned);
  pool.close();
  await Promise.all(bulk);

  expect(idle).toBeGreaterThanOrEqual(0);
  expect(afterDeath).toEqual({ limit: 1, inFlight: 2 });
  expect(received).toBe(2);
});

test('a respawned reader widens the lane again without waiting for a bulk read to finish', async () => {
  const { spawned, spawn } = fakeWorkers();
  let respawned: () => void = () => {};
  const back = new Promise<void>((resolve) => (respawned = resolve));
  const pool = await openFakePool(spawn, {
    respawnDelaysMs: [50],
    onReaderRespawn: (event: { outcome: string }) => {
      if (event.outcome === 'respawned') respawned();
    },
  });
  const [, dead, ...survivors] = spawned;
  dead?.exit();
  for (const survivor of survivors) survivor.goSilent();
  const bulk = Array.from({ length: 3 }, () => pool.readBulk('SELECT 1').catch(() => null));
  await settle();
  const whileDown = { limit: pool.bulkReadLimit, received: readsReceived(spawned) };
  await back;
  await settle();
  const afterRespawn = { limit: pool.bulkReadLimit, received: readsReceived(spawned) };
  pool.close();
  await Promise.all(bulk);

  expect(whileDown).toEqual({ limit: 1, received: 1 });
  // The first bulk read is parked on a silent survivor for good, so any second
  // admission can only have come from the returning reader widening the lane.
  expect(afterRespawn.limit).toBe(2);
  expect(afterRespawn.received).toBeGreaterThanOrEqual(2);
});
