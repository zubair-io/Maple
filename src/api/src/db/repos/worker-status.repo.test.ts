/**
 * The `worker_status` singleton: three writers, one row, and no two of them
 * allowed to clobber each other.
 *
 * Every test here is really the same question asked three ways — after a write
 * from one of the three owners, is what the other two wrote still there? The
 * Mongo version got that property from narrow `$set`s; here it comes from each
 * upsert naming only its own columns, which is easy to break and silent when it
 * is.
 */

import { describe, expect, it } from 'bun:test';
import { createTestDatabase, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import type { StageStatusSnapshot } from '../../workers/registry.ts';
import {
  pokeStatusCountsDemand,
  readStatusCountsDemand,
  readWorkerStatus,
  writeStatusCounts,
  writeWorkerStatus,
  type StatusCountsSnapshot,
} from './worker-status.repo.ts';

const SNAPSHOT: Record<string, StageStatusSnapshot> = {
  exif: {
    status: 'running',
    inFlight: 2,
    throughput: 11,
    targetVersion: 3,
    dependsOn: [{ name: 'hash', minVersion: 1 }],
    lastError: null,
  },
};

const COUNTS: StatusCountsSnapshot = {
  pending: { exif: 12 },
  ready: { exif: 5 },
  dead: { exif: 1 },
  damaged: 4,
  newly_hidden: 2,
  computed_at: 1_700_000_000_000,
  duration_ms: 17,
};

describe('the registry snapshot', () => {
  it('round-trips, and reports null before anything has been written', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await readWorkerStatus(db)).toBeNull();

    await writeWorkerStatus(SNAPSHOT, 1234, { kind: 'loaded', errorDetail: null }, db);

    expect(await readWorkerStatus(db)).toEqual({
      statuses: SNAPSHOT,
      face_models: { kind: 'loaded', errorDetail: null },
      updated_at: 1234,
      counts: null,
    });
  });

  it('keeps the previous face-model state when a write does not carry one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeWorkerStatus(SNAPSHOT, 1, { kind: 'loaded', errorDetail: null }, db);

    await writeWorkerStatus(SNAPSHOT, 2, undefined, db);

    const read = await readWorkerStatus(db);
    expect(read?.updated_at).toBe(2);
    expect(read?.face_models).toEqual({ kind: 'loaded', errorDetail: null });
  });
});

describe('the counts snapshot', () => {
  it('can be written before the status writer has ever run', async () => {
    // The counts pass and the status timer start independently, and on a fresh
    // worker the pass can win. The insert branch has to satisfy `statuses NOT
    // NULL` on its own rather than assuming a row exists.
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    await writeStatusCounts(COUNTS, db);

    expect(await readWorkerStatus(db)).toEqual({
      statuses: {},
      updated_at: 0,
      counts: COUNTS,
    });
  });

  it('survives a status write, and vice versa', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeStatusCounts(COUNTS, db);

    await writeWorkerStatus(SNAPSHOT, 99, undefined, db);

    const read = await readWorkerStatus(db);
    expect(read?.counts).toEqual(COUNTS);
    expect(read?.statuses).toEqual(SNAPSHOT);
    expect(read?.updated_at).toBe(99);
  });
});

describe('the demand flag', () => {
  it('reads 0 before anyone has looked at the page', async () => {
    using handle = await createTestDatabase();
    expect(await readStatusCountsDemand(testSqliteDb(handle.db))).toBe(0);
  });

  it('never moves the deadline backwards', async () => {
    // Two API processes poking overlapping windows: the shorter one must not
    // cut the longer one short, which is what `$max` bought on Mongo.
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);

    await pokeStatusCountsDemand(5_000, db);
    await pokeStatusCountsDemand(9_000, db);
    await pokeStatusCountsDemand(7_000, db);

    expect(await readStatusCountsDemand(db)).toBe(9_000);
  });

  it('raises the flag on a row the status writer created', async () => {
    // The stored side is NULL until the first poke, and SQLite's MAX() answers
    // NULL for any NULL argument — so an unguarded comparison would blank the
    // flag here instead of setting it.
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await writeWorkerStatus(SNAPSHOT, 1, undefined, db);

    await pokeStatusCountsDemand(4_242, db);

    expect(await readStatusCountsDemand(db)).toBe(4_242);
    expect((await readWorkerStatus(db))?.statuses).toEqual(SNAPSHOT);
  });
});
