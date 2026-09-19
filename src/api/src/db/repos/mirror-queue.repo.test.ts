/**
 * `mirror_queue` behaviour through the repository.
 *
 * The case this file exists for is the claim. `claimNextMirrorCopy` replaces a
 * Mongo `findOneAndUpdate` with a sort, and the property that has to survive is
 * that two copy workers are never handed the same row — one would copy a file
 * the other is mid-way through writing, and whichever finished second would
 * delete a queue row the first still believed it owned.
 *
 * `claims the next row when a rival takes the candidate first` is the test that
 * pins it. It wedges a competing claim into the window between the candidate
 * read and the conditional write, which is exactly the window a naive
 * `UPDATE … WHERE id = ?` would lose; that version returns the stolen row and
 * fails this test.
 */

import { describe, expect, test } from 'bun:test';
import type { SqlParams } from '../sqlite/protocol.ts';
import { createTestDatabase, run, testSqliteDb } from '../sqlite/test-sqlite.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import {
  claimNextMirrorCopy,
  completeMirrorCopy,
  enqueueMirrorCopy,
  failMirrorCopy,
  mirrorQueueCounts,
  retryDeadMirrorCopies,
} from './mirror-queue.repo.ts';

const LEASE_MS = 120_000;

/** Pins a row's enqueue time so claim ordering is a fact rather than a race. */
function pinEnqueuedAt(db: SqliteDb, mirrorPath: string, at: number): Promise<unknown> {
  return db.write(`UPDATE mirror_queue SET enqueued_at = ? WHERE mirror_path = ?`, [
    at,
    mirrorPath,
  ]);
}

function readRow(
  db: SqliteDb,
  mirrorPath: string,
): Promise<Array<{ id: number; claimed_at: number | null; attempts: number; dead: number }>> {
  return db.read(`SELECT id, claimed_at, attempts, dead FROM mirror_queue WHERE mirror_path = ?`, [
    mirrorPath,
  ]);
}

/**
 * The same handle, except that a rival worker claims the head of the candidate
 * list the moment it is read — the interleaving a second process produces, made
 * deterministic.
 */
function withRivalClaimingFirstCandidate(db: SqliteDb, rivalLeaseUntil: number): SqliteDb {
  let fired = false;
  return {
    ...db,
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      const rows = await db.read<T>(sql, params);
      if (fired || !sql.includes('ORDER BY enqueued_at')) return rows;
      fired = true;
      const first = (rows as ReadonlyArray<{ id: number }>)[0];
      if (first !== undefined) {
        await db.write(`UPDATE mirror_queue SET claimed_at = ? WHERE id = ?`, [
          rivalLeaseUntil,
          first.id,
        ]);
      }
      return rows;
    },
  };
}

describe('enqueueMirrorCopy', () => {
  test('adds a pending row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    expect(await mirrorQueueCounts(db)).toEqual({ pending: 1, dead: 0 });
  });

  test('coalesces a re-detection onto the existing row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await pinEnqueuedAt(db, '/mirror/a.dng', 1000);
    run(handle.db, `UPDATE mirror_queue SET attempts = 3 WHERE mirror_path = ?`, '/mirror/a.dng');

    await enqueueMirrorCopy('/primary/moved.dng', '/mirror/a.dng', 'write-failure', db);

    const rows = await db.read<{
      n: number;
      primary_path: string;
      reason: string;
      attempts: number;
      enqueued_at: number;
    }>(`SELECT COUNT(*) AS n, primary_path, reason, attempts, enqueued_at FROM mirror_queue`);
    // Source path and reason are refreshed; the queue state a retry depends on
    // is not, so repeated failures cannot reset the backoff.
    expect(rows[0]).toMatchObject({
      n: 1,
      primary_path: '/primary/moved.dng',
      reason: 'write-failure',
      attempts: 3,
      enqueued_at: 1000,
    });
  });
});

describe('claimNextMirrorCopy', () => {
  test('returns null on an empty queue', async () => {
    using handle = await createTestDatabase();
    expect(await claimNextMirrorCopy(LEASE_MS, testSqliteDb(handle.db))).toBeNull();
  });

  test('takes the oldest row first and leases it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/new.dng', '/mirror/new.dng', 'scan-missing', db);
    await enqueueMirrorCopy('/primary/old.dng', '/mirror/old.dng', 'scan-missing', db);
    await pinEnqueuedAt(db, '/mirror/new.dng', 2000);
    await pinEnqueuedAt(db, '/mirror/old.dng', 1000);

    const claimed = await claimNextMirrorCopy(LEASE_MS, db);
    expect(claimed?.mirror_path).toBe('/mirror/old.dng');
    expect(claimed?.primary_path).toBe('/primary/old.dng');
    expect(claimed?.dead).toBe(false);
    expect(claimed!.claimed_at!).toBeGreaterThan(Date.now() - 1);
  });

  test('never hands the same row to two callers', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await enqueueMirrorCopy('/primary/b.dng', '/mirror/b.dng', 'scan-missing', db);

    const first = await claimNextMirrorCopy(LEASE_MS, db);
    const second = await claimNextMirrorCopy(LEASE_MS, db);
    const third = await claimNextMirrorCopy(LEASE_MS, db);

    expect(first?._id).not.toBe(second?._id);
    expect(new Set([first!.mirror_path, second!.mirror_path])).toEqual(
      new Set(['/mirror/a.dng', '/mirror/b.dng']),
    );
    expect(third).toBeNull();
  });

  test('claims the next row when a rival takes the candidate first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await enqueueMirrorCopy('/primary/b.dng', '/mirror/b.dng', 'scan-missing', db);
    await pinEnqueuedAt(db, '/mirror/a.dng', 1000);
    await pinEnqueuedAt(db, '/mirror/b.dng', 2000);

    const rivalLeaseUntil = Date.now() + LEASE_MS;
    const claimed = await claimNextMirrorCopy(
      LEASE_MS,
      withRivalClaimingFirstCandidate(db, rivalLeaseUntil),
    );

    // The rival owns a; this caller must not also own it.
    expect(claimed?.mirror_path).toBe('/mirror/b.dng');
    expect((await readRow(db, '/mirror/a.dng'))[0]?.claimed_at).toBe(rivalLeaseUntil);
  });

  test('returns null when every candidate is already leased', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await claimNextMirrorCopy(LEASE_MS, db);
    expect(await claimNextMirrorCopy(LEASE_MS, db)).toBeNull();
  });

  test('retakes a row whose lease has expired', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await db.write(`UPDATE mirror_queue SET claimed_at = ?`, [Date.now() - 1000]);

    const reclaimed = await claimNextMirrorCopy(LEASE_MS, db);
    expect(reclaimed?.mirror_path).toBe('/mirror/a.dng');
  });

  test('never claims a dead-lettered row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    await db.write(`UPDATE mirror_queue SET dead = 1`);
    expect(await claimNextMirrorCopy(LEASE_MS, db)).toBeNull();
  });
});

describe('completeMirrorCopy', () => {
  test('removes the finished row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    const claimed = await claimNextMirrorCopy(LEASE_MS, db);

    await completeMirrorCopy(claimed!._id, db);
    expect(await mirrorQueueCounts(db)).toEqual({ pending: 0, dead: 0 });
  });
});

describe('failMirrorCopy', () => {
  test('bumps the attempt, records the error and releases the claim', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    const claimed = await claimNextMirrorCopy(LEASE_MS, db);

    await failMirrorCopy(claimed!._id, 'network unreachable', 3, db);

    const rows = await db.read<{
      attempts: number;
      last_error: string;
      claimed_at: number | null;
      dead: number;
    }>(`SELECT attempts, last_error, claimed_at, dead FROM mirror_queue`);
    expect(rows[0]).toEqual({
      attempts: 1,
      last_error: 'network unreachable',
      claimed_at: null,
      dead: 0,
    });
    // Released, so the next pass can retry it.
    expect((await claimNextMirrorCopy(LEASE_MS, db))?.mirror_path).toBe('/mirror/a.dng');
  });

  test('dead-letters on the attempt that reaches the maximum, not the one after', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await enqueueMirrorCopy('/primary/a.dng', '/mirror/a.dng', 'scan-missing', db);
    const id = (await claimNextMirrorCopy(LEASE_MS, db))!._id;

    await failMirrorCopy(id, 'first', 2, db);
    expect((await readRow(db, '/mirror/a.dng'))[0]?.dead).toBe(0);

    await failMirrorCopy(id, 'second', 2, db);
    const row = (await readRow(db, '/mirror/a.dng'))[0];
    // The flag is derived from the NEW attempt count: 2 attempts, max 2.
    expect(row?.attempts).toBe(2);
    expect(row?.dead).toBe(1);
    expect(await mirrorQueueCounts(db)).toEqual({ pending: 0, dead: 1 });
  });
});

describe('retryDeadMirrorCopies', () => {
  test('revives every dead row and reports how many', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (const name of ['a', 'b']) {
      await enqueueMirrorCopy(`/primary/${name}.dng`, `/mirror/${name}.dng`, 'scan-missing', db);
    }
    await db.write(`UPDATE mirror_queue SET dead = 1, attempts = 5, last_error = 'gone'`);

    expect(await retryDeadMirrorCopies(db)).toBe(2);
    expect(await mirrorQueueCounts(db)).toEqual({ pending: 2, dead: 0 });
    const rows = await readRow(db, '/mirror/a.dng');
    expect(rows[0]).toMatchObject({ attempts: 0, claimed_at: null, dead: 0 });
  });

  test('reports zero when nothing is dead', async () => {
    using handle = await createTestDatabase();
    expect(await retryDeadMirrorCopies(testSqliteDb(handle.db))).toBe(0);
  });
});

describe('mirrorQueueCounts', () => {
  test('answers zeros on an empty queue', async () => {
    using handle = await createTestDatabase();
    expect(await mirrorQueueCounts(testSqliteDb(handle.db))).toEqual({ pending: 0, dead: 0 });
  });
});
