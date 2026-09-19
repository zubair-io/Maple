/**
 * Cursor monotonicity under writers that genuinely overlap.
 *
 * The rest of the change-feed suite drives a synchronous `bun:sqlite`
 * connection, which cannot race with itself: every batch runs start to finish
 * inside one microtask, so a two-step allocator would look perfectly safe. This
 * file therefore opens the real worker-backed pool against a file-backed
 * database, which is where a caller's `await` actually yields to its
 * neighbours.
 *
 * Two assertions, and the first is what gives the second its teeth. The naive
 * allocator — read the counter, add one, write it back — is exercised here
 * deliberately, and it collides: every request is posted before any reply comes
 * back, so all of them read the same value. The ported repository, allocating
 * and inserting inside one `BEGIN IMMEDIATE`, hands out each cursor exactly
 * once instead.
 *
 * Test shape note — round trips first, assertions afterwards, because Bun 1.4.3
 * can drop a worker message when an `expect()` runs between two round trips.
 */

import { afterEach, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import { recordAssetChange, type RecordChangeInput } from './changes.repo.ts';
import { SqlitePool } from '../sqlite/pool.ts';
import { createTestDatabase, type TestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';

/** Concurrent writers. Large enough that a collision is a certainty, not luck. */
const WRITERS = 50;

const CURSOR_ROW_ID = 'asset_changes_cursor';

let handle: TestDatabase | null = null;
let pool: SqlitePool | null = null;

afterEach(() => {
  pool?.close();
  pool = null;
  handle?.close();
  handle = null;
});

/**
 * A pool over a database with the schema already applied.
 *
 * `createTestDatabase('file')` owns the file and the schema; the pool attaches
 * to the same path with its own writer and reader threads, which is the only
 * way to get two callers of this repository to overlap in a test.
 */
async function poolOnFreshDatabase(): Promise<SqlitePool> {
  handle = await createTestDatabase('file');
  pool = await SqlitePool.open({ path: handle.path, readers: 2 });
  return pool;
}

function change(): RecordChangeInput {
  return {
    kind: 'create',
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    abs_path: '/srv/photos/a.dng',
  };
}

test('the naive read-then-write allocator collides under concurrency', async () => {
  const db = await poolOnFreshDatabase();
  await db.write(`INSERT INTO server_state (id, seq) VALUES (?, 0)`, [CURSOR_ROW_ID]);

  /** What this repository deliberately does not do. */
  const naiveAllocate = async (): Promise<number> => {
    const rows = await db.read<{ seq: number }>(`SELECT seq FROM server_state WHERE id = ?`, [
      CURSOR_ROW_ID,
    ]);
    const next = (rows[0]?.seq ?? 0) + 1;
    await db.write(`UPDATE server_state SET seq = ? WHERE id = ?`, [next, CURSOR_ROW_ID]);
    return next;
  };

  const allocated = await Promise.all(Array.from({ length: WRITERS }, naiveAllocate));

  expect(new Set(allocated).size).toBeLessThan(WRITERS);
});

test('every concurrent writer gets a distinct, contiguous cursor', async () => {
  const db = await poolOnFreshDatabase();

  const cursors = await Promise.all(
    Array.from({ length: WRITERS }, () => recordAssetChange(db, change())),
  );
  const stored = await db.read<{ cursor: number }>(
    `SELECT cursor FROM asset_changes ORDER BY cursor`,
  );
  const counter = await db.read<{ seq: number }>(`SELECT seq FROM server_state WHERE id = ?`, [
    CURSOR_ROW_ID,
  ]);

  const expected = Array.from({ length: WRITERS }, (_, i) => i + 1);
  // Every cursor handed out is unique, and the set is exactly 1..N — so none
  // was skipped either, which is what rules out a spent-but-unused allocation.
  expect([...cursors].sort((a, b) => a - b)).toEqual(expected);
  expect(stored.map((row) => row.cursor)).toEqual(expected);
  expect(counter[0]?.seq).toBe(WRITERS);
});
