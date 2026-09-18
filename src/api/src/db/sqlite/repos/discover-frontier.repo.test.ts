/**
 * The frontier queue against a real database.
 *
 * The behaviour worth testing here is the claim, because that is the one place
 * the port could not copy Mongo's mechanism: `findOneAndUpdate` decides a
 * winner server-side, and the compare-and-swap that replaces it only works if
 * the `UPDATE` re-checks the free-or-expired predicate. The last test in the
 * claim block fails outright if that `WHERE` clause is weakened.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  claimNextDir,
  completeDir,
  enqueueDirs,
  remainingForGen,
  seedRoot,
} from './discover-frontier.repo.ts';
import {
  createTestDatabase,
  insertFolder,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { SqlParams } from '../protocol.ts';
import type { SqliteDb } from './db-handle.ts';

const CANDIDATE_QUERY = 'ORDER BY enqueued_at, id';

/**
 * The same handle, except that the first candidate read has a rival sweeper
 * claim every id it returned before the caller gets to act on them. This is the
 * race the compare-and-swap exists for, made deterministic.
 */
function withRivalSweeper(db: SqliteDb, claim: (ids: number[]) => void): SqliteDb {
  let fired = false;
  return {
    ...db,
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      const rows = await db.read<T>(sql, params);
      if (!fired && sql.includes(CANDIDATE_QUERY)) {
        fired = true;
        claim((rows as Array<{ id: number }>).map((row) => row.id));
      }
      return rows;
    },
  };
}

describe('seedRoot and enqueueDirs', () => {
  test('seeds a root once, however many times the sweep restarts', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await seedRoot(folder, '/srv/photos/Library', 1, db);
    await seedRoot(folder, '/srv/photos/Library', 1, db);

    expect(await remainingForGen(folder, 1, db)).toBe(1);
  });

  test('re-enqueuing a mixture of known and new dirs keeps the new ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, ['/a', '/b'], 1, false, db);
    await enqueueDirs(folder, ['/b', '/c'], 1, false, db);

    expect(await remainingForGen(folder, 1, db)).toBe(3);
  });

  test('is scoped to a folder and a generation', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const first = new ObjectId(insertFolder(handle.db));
    const second = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(first, ['/shared'], 1, false, db);
    await enqueueDirs(second, ['/shared'], 1, false, db);
    await enqueueDirs(first, ['/shared'], 2, false, db);

    expect(await remainingForGen(first, 1, db)).toBe(1);
    expect(await remainingForGen(second, 1, db)).toBe(1);
    expect(await remainingForGen(first, 2, db)).toBe(1);
  });

  test('carries the inherited hide flag through to the claimed dir', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, ['/hidden-subtree'], 1, true, db);
    const dir = await claimNextDir(folder, 1, 60_000, db);

    expect(dir?.hidden_ancestor).toBe(true);
    expect(dir?.folder_id.toHexString()).toBe(folder.toHexString());
    expect(dir?.sweep_gen).toBe(1);
  });

  test('an empty list writes nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, [], 1, false, db);
    expect(await remainingForGen(folder, 1, db)).toBe(0);
  });
});

describe('claimNextDir', () => {
  test('hands out the oldest dir first and never hands one out twice', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, ['/first', '/second'], 1, false, db);

    const a = await claimNextDir(folder, 1, 60_000, db);
    const b = await claimNextDir(folder, 1, 60_000, db);
    const c = await claimNextDir(folder, 1, 60_000, db);

    expect(a?.dir_path).toBe('/first');
    expect(b?.dir_path).toBe('/second');
    expect(c).toBeNull();
    // Still on the frontier — claiming leases, it does not dequeue.
    expect(await remainingForGen(folder, 1, db)).toBe(2);
  });

  test('retakes a dir whose lease has expired', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await seedRoot(folder, '/x', 1, db);
    const dead = await claimNextDir(folder, 1, -1, db);
    const retaken = await claimNextDir(folder, 1, 60_000, db);

    expect(dead?.dir_path).toBe('/x');
    expect(retaken?._id).toBe(dead!._id);
    expect(retaken!.claimed_at).toBeGreaterThan(Date.now());
  });

  test('returns null for a generation with nothing in it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await seedRoot(folder, '/x', 1, db);
    expect(await claimNextDir(folder, 2, 60_000, db)).toBeNull();
  });

  test('never returns a dir a rival sweeper claimed after the candidate read', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, ['/first', '/second'], 1, false, db);

    // The rival takes only the first candidate, so a correct claim falls
    // through to the second rather than reporting the frontier empty.
    const rivalLease = Date.now() + 60_000;
    const stolen: number[] = [];
    const racy = withRivalSweeper(db, (ids) => {
      const first = ids[0];
      if (first === undefined) return;
      stolen.push(first);
      run(handle.db, `UPDATE discover_frontier SET claimed_at = ? WHERE id = ?`, rivalLease, first);
    });

    const dir = await claimNextDir(folder, 1, 60_000, racy);

    expect(stolen).toHaveLength(1);
    expect(dir).not.toBeNull();
    expect(dir!._id).not.toBe(stolen[0]!);
    expect(dir!.dir_path).toBe('/second');
  });

  test('returns null when a rival takes every candidate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await enqueueDirs(folder, ['/first', '/second'], 1, false, db);

    const rivalLease = Date.now() + 60_000;
    const racy = withRivalSweeper(db, (ids) => {
      for (const id of ids) {
        run(handle.db, `UPDATE discover_frontier SET claimed_at = ? WHERE id = ?`, rivalLease, id);
      }
    });

    expect(await claimNextDir(folder, 1, 60_000, racy)).toBeNull();
    // The rival's leases are intact — a loser must not stomp them.
    const rows = handle.db.query(`SELECT claimed_at AS at FROM discover_frontier`).all() as Array<{
      at: number;
    }>;
    expect(rows.map((row) => row.at)).toEqual([rivalLease, rivalLease]);
  });
});

describe('completeDir and remainingForGen', () => {
  test('completing a dir drains the generation', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folder = new ObjectId(insertFolder(handle.db));

    await seedRoot(folder, '/srv/photos/Library', 1, db);
    const root = await claimNextDir(folder, 1, 60_000, db);
    await enqueueDirs(folder, ['/srv/photos/Library/2024'], 1, false, db);
    expect(await remainingForGen(folder, 1, db)).toBe(2);

    await completeDir(root!._id, db);
    expect(await remainingForGen(folder, 1, db)).toBe(1);

    const child = await claimNextDir(folder, 1, 60_000, db);
    await completeDir(child!._id, db);
    expect(await remainingForGen(folder, 1, db)).toBe(0);
  });

  test('deleting the library root takes its frontier rows with it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = insertFolder(handle.db);
    const folder = new ObjectId(folderId);

    await seedRoot(folder, '/x', 1, db);
    run(handle.db, `DELETE FROM folders WHERE id = ?`, folderId);

    expect(await remainingForGen(folder, 1, db)).toBe(0);
  });
});
