/**
 * The ported change feed.
 *
 * Three things get more attention than a straight re-run of the Mongo suite.
 * The allocation and the insert are one transaction now, so a rejected row must
 * leave the counter exactly where it was. The counter and the journal are
 * separate facts, so a pruned journal must still report what was allocated.
 * And a `delete` event names an asset that has already been removed, which is
 * the case a foreign key on this table would have destroyed.
 *
 * Cursor monotonicity under genuinely concurrent writers needs real threads and
 * lives in `changes.concurrency.test.ts`; a synchronous test connection runs
 * each batch start to finish and cannot race with itself.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  allocatedCursor,
  computeRelativePath,
  highestCursor,
  isChangeCursorTooOld,
  listChangesSince,
  recordAndPublishAssetChange,
  recordAssetChange,
  recordAssetChangeRow,
  __resetChangeFolderPathCacheForTests,
  type RecordChangeInput,
  type SqliteDb,
} from './changes.repo.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import { getChangeBus, __resetChangeBusForTests } from '../../../runtime/change-bus.ts';

const oid = (): ObjectId => new ObjectId();

beforeEach(() => {
  __resetChangeFolderPathCacheForTests();
  __resetChangeBusForTests();
});

/** A change input with the required fields filled in. */
function change(overrides: Partial<RecordChangeInput> = {}): RecordChangeInput {
  return {
    kind: 'create',
    asset_id: oid(),
    folder_id: oid(),
    abs_path: '/srv/photos/a.dng',
    ...overrides,
  };
}

/** Every stored change row, oldest first. */
function storedRows(handle: TestDatabase): Array<Record<string, unknown>> {
  return handle.db.query(`SELECT * FROM asset_changes ORDER BY cursor`).all() as Array<
    Record<string, unknown>
  >;
}

/** Counts write attempts and fails the first `failures` of them with `error`. */
function flakyWriter(
  inner: SqliteDb,
  failures: number,
  error: Error,
): SqliteDb & { attempts: () => number } {
  let attempts = 0;
  return {
    read: inner.read.bind(inner),
    write: inner.write.bind(inner),
    transaction: async (statements) => {
      attempts++;
      if (attempts <= failures) throw error;
      return inner.transaction(statements);
    },
    attempts: () => attempts,
  };
}

/** What the pool reports when a writer could not take the lock in time. */
function busyError(): Error {
  return new Error('database is locked (SQLITE_BUSY)');
}

describe('cursor allocation', () => {
  test('allocates strictly increasing cursors, one per row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const a = await recordAssetChange(db, change());
    const b = await recordAssetChange(db, change());
    const c = await recordAssetChange(db, change());
    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(storedRows(handle).map((row) => row.cursor)).toEqual([1, 2, 3]);
  });

  test('a rejected row spends no cursor', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await recordAssetChange(db, change());

    // `kind` is constrained by a CHECK, so this insert fails after the counter
    // statement has already run inside the batch. On Mongo the `$inc` had
    // already committed by then and the cursor was lost; here the whole batch
    // rolls back. This is the assertion the two-step implementation fails.
    await expect(
      recordAssetChange(db, change({ kind: 'sideways' as RecordChangeInput['kind'] })),
    ).rejects.toThrow();

    expect(await allocatedCursor(db)).toBe(1);
    expect(await highestCursor(db)).toBe(1);
    expect(await recordAssetChange(db, change())).toBe(2);
  });

  test('continues from the journal when the counter row is missing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // What a cutover importer (#3752) that copies `asset_changes` without also
    // seeding `server_state` leaves behind. `cursor` is the primary key, so an
    // allocator that trusted the counter alone would mint 1, collide with the
    // row already there, and be swallowed by the best-effort handler — the feed
    // would emit nothing at all from boot, with one warn line to show for it.
    for (const cursor of [1, 2, 3]) {
      run(
        handle.db,
        `INSERT INTO asset_changes (cursor, kind, abs_path, at) VALUES (?, 'create', ?, ?)`,
        cursor,
        `/srv/photos/${cursor}.dng`,
        new Date().toISOString(),
      );
    }
    expect(await allocatedCursor(db)).toBe(0);

    expect(await recordAssetChange(db, change())).toBe(4);
    expect(await allocatedCursor(db)).toBe(4);
    expect(storedRows(handle).map((row) => row.cursor)).toEqual([1, 2, 3, 4]);
  });

  test('keeps the counter when it is ahead of the journal', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 3; i++) await recordAssetChange(db, change());
    // Retention leaves the counter ahead of every stored row. Reconciling
    // against the journal must never walk it backwards into reissuing cursors
    // clients have already seen.
    run(handle.db, `DELETE FROM asset_changes WHERE cursor < 3`);
    expect(await recordAssetChange(db, change())).toBe(4);
  });

  test('retries a write the writer was too busy to take', async () => {
    using handle = await createTestDatabase();
    const db = flakyWriter(testSqliteDb(handle.db), 1, busyError());
    // Mongo had no global write lock; SQLite funnels every writer in every
    // child process through one. A change row emitted mid-batch that lost that
    // race used to be logged and dropped, and the client is told it is current.
    expect(await recordAssetChange(db, change())).toBe(1);
    expect(db.attempts()).toBe(2);
    expect(storedRows(handle)).toHaveLength(1);
  });

  test('gives up once the retries are spent', async () => {
    using handle = await createTestDatabase();
    const db = flakyWriter(testSqliteDb(handle.db), 99, busyError());
    await expect(recordAssetChange(db, change())).rejects.toThrow(/locked/i);
    // Three delays, so four attempts in total.
    expect(db.attempts()).toBe(4);
  });

  test('does not retry an error a retry cannot fix', async () => {
    using handle = await createTestDatabase();
    const db = flakyWriter(testSqliteDb(handle.db), 99, new Error('CHECK constraint failed'));
    await expect(recordAssetChange(db, change())).rejects.toThrow(/CHECK/);
    expect(db.attempts()).toBe(1);
  });

  test('records a delete for an asset that has already been removed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = insertAsset(handle.db);
    run(handle.db, `DELETE FROM assets WHERE id = ?`, assetId);

    // The hard-delete route emits its change event after the asset row is gone.
    // A foreign key on `asset_changes.asset_id` would reject this insert, and
    // the File Provider extension would never learn to drop the item.
    const cursor = await recordAssetChange(
      db,
      change({ kind: 'delete', asset_id: new ObjectId(assetId) }),
    );
    expect(storedRows(handle)).toHaveLength(1);
    expect((await listChangesSince(db, { since: cursor - 1, limit: 10 }))[0]!.asset_id).toEqual(
      new ObjectId(assetId),
    );
  });
});

describe('the retention floor', () => {
  test('a pruned journal still reports what was allocated', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) await recordAssetChange(db, change());
    expect(await highestCursor(db)).toBe(5);

    // What a retention sweep does to a fully-idle feed.
    run(handle.db, `DELETE FROM asset_changes`);

    expect(await highestCursor(db)).toBe(0);
    expect(await allocatedCursor(db)).toBe(5);
    // And the next row continues the sequence rather than restarting at 1,
    // which is why the counter cannot be derived from the journal.
    expect(await recordAssetChange(db, change())).toBe(6);
  });

  test('reports zero on a server that has never emitted a change', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await highestCursor(db)).toBe(0);
    expect(await allocatedCursor(db)).toBe(0);
  });
});

describe('isChangeCursorTooOld', () => {
  test('refuses a cursor whose next row was pruned, and names where to resume', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) await recordAssetChange(db, change());
    // A sweep keeps the tail. The floor is now 4, so the next row a client at
    // 2 wants (3) no longer exists and it has to re-enumerate.
    run(handle.db, `DELETE FROM asset_changes WHERE cursor < 4`);

    expect(await isChangeCursorTooOld(db, 2)).toEqual({ tooOld: true, current: 5 });
    expect(await isChangeCursorTooOld(db, 0)).toEqual({ tooOld: true, current: 5 });
    // 3 + 1 is the floor itself — nothing was lost, so this is servable.
    expect(await isChangeCursorTooOld(db, 3)).toEqual({ tooOld: false, current: 5 });
    expect(await isChangeCursorTooOld(db, 5)).toEqual({ tooOld: false, current: 5 });
  });

  test('falls back to the counter once the journal is empty', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 3; i++) await recordAssetChange(db, change());
    run(handle.db, `DELETE FROM asset_changes`);

    // Nothing is left to compare against, so the allocation counter decides:
    // a client that had seen everything is current, anyone behind it is not.
    expect(await isChangeCursorTooOld(db, 3)).toEqual({ tooOld: false, current: 3 });
    expect(await isChangeCursorTooOld(db, 2)).toEqual({ tooOld: true, current: 3 });
  });

  test('accepts every cursor on a server that has emitted nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await isChangeCursorTooOld(db, 0)).toEqual({ tooOld: false, current: 0 });
  });

  test('serves an unpruned journal from the beginning', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 3; i++) await recordAssetChange(db, change());
    expect(await isChangeCursorTooOld(db, 0)).toEqual({ tooOld: false, current: 3 });
  });

  test('treats a gap at the bottom as a prune, even when nothing was pruned', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 3; i++) await recordAssetChange(db, change());
    // Nothing has been swept. The journal simply does not start at 1 — which is
    // what a client holding a cursor it leaked from an earlier era sees.
    run(handle.db, `UPDATE asset_changes SET cursor = cursor + 10`);

    // Pinning the accepted difference from the Mongo guard (#3784), not
    // endorsing it. Deriving the floor from the surviving minimum cannot tell
    // "these rows were pruned" from "these rows never existed down here", so a
    // client at 0 is sent to re-enumerate where the Mongo path, which compared
    // against a persisted retention floor, would have served it. The cost is an
    // expensive-but-correct re-enumeration; the opposite error, serving a page
    // that silently skips rows, is the one that loses data. The owner accepted
    // this form for the cutover. If #3784 gives the guard the retention floor,
    // this expectation flips to `tooOld: false` — deliberately, here.
    expect(await isChangeCursorTooOld(db, 0)).toEqual({ tooOld: true, current: 13 });
  });

  test('never admits a page that skips a row without saying so', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) await recordAssetChange(db, change());
    run(handle.db, `DELETE FROM asset_changes WHERE cursor < 4`);

    // The guarantee the polling route rests on, stated as an invariant rather
    // than as a table of cases: a page it is allowed to serve always starts at
    // the row immediately after the cursor the client asked from. Anything else
    // is a gap the client would advance its anchor straight past. This is
    // exactly what the missing check let happen — a client at 2 was handed
    // rows 4 and 5 with a 200 and never learned 3 was gone.
    for (const since of [0, 1, 2, 3, 4, 5]) {
      const { tooOld } = await isChangeCursorTooOld(db, since);
      const rows = await listChangesSince(db, { since, limit: 1000 });
      if (tooOld) {
        expect(rows.length > 0 && rows[0]!.cursor > since + 1).toBe(true);
        continue;
      }
      if (rows.length > 0) expect(rows[0]!.cursor).toBe(since + 1);
    }
  });
});

describe('recordAssetChangeRow', () => {
  test('returns the row it persisted', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const input = change({ kind: 'update', relative_path: 'a/b.dng' });
    const row = await recordAssetChangeRow(db, input);

    const [listed] = await listChangesSince(db, { since: 0, limit: 10 });
    expect(listed).toEqual(row);
    expect(row.kind).toBe('update');
    expect(row.relative_path).toBe('a/b.dng');
    expect(row.at.toISOString()).toBe((storedRows(handle)[0]! as { at: string }).at);
  });

  test('stores a null relative_path when the caller supplies none', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await recordAssetChange(db, change());
    expect(storedRows(handle)[0]!.relative_path).toBeNull();
  });
});

describe('recordAndPublishAssetChange', () => {
  test('computes relative_path from the library root and publishes the row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = insertFolder(handle.db, { path: '/srv/photos' });
    await recordAndPublishAssetChange(
      change({
        folder_id: new ObjectId(folderId),
        abs_path: '/srv/photos/2024/holiday/IMG_0001.dng',
      }),
      db,
    );

    expect(storedRows(handle)[0]!.relative_path).toBe('2024/holiday/IMG_0001.dng');
    const published = getChangeBus().snapshot();
    expect(published).toHaveLength(1);
    expect(published[0]!.relative_path).toBe('2024/holiday/IMG_0001.dng');
    expect(published[0]!.cursor).toBe(1);
  });

  test('tolerates a trailing slash on the library root', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = insertFolder(handle.db, { path: '/srv/photos/' });
    await recordAndPublishAssetChange(
      change({ folder_id: new ObjectId(folderId), abs_path: '/srv/photos/IMG_0002.dng' }),
      db,
    );
    expect(storedRows(handle)[0]!.relative_path).toBe('IMG_0002.dng');
  });

  test('stores null when abs_path falls outside the library root', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const folderId = insertFolder(handle.db, { path: '/srv/photos' });
    await recordAndPublishAssetChange(
      change({ folder_id: new ObjectId(folderId), abs_path: '/elsewhere/oops.dng' }),
      db,
    );
    expect(storedRows(handle)).toHaveLength(1);
    expect(storedRows(handle)[0]!.relative_path).toBeNull();
  });

  test('stores null when the library root is an empty path', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // `folders.path` is NOT NULL UNIQUE but carries no non-empty CHECK. An
    // empty root is a prefix of everything, so the defensive "outside the root"
    // branch never fires and the whole absolute path would be stored as if it
    // were relative — a plausible-looking path the File Provider would route
    // per-folder invalidation on.
    const folderId = insertFolder(handle.db, { path: '' });
    await recordAndPublishAssetChange(
      change({ folder_id: new ObjectId(folderId), abs_path: '/srv/photos/a.dng' }),
      db,
    );
    expect(storedRows(handle)[0]!.relative_path).toBeNull();
  });

  test('keeps a caller-supplied relative path and skips the lookup', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    // No folders row exists, so a lookup would resolve to null.
    await recordAndPublishAssetChange(change({ relative_path: 'given/by/caller.dng' }), db);
    expect(storedRows(handle)[0]!.relative_path).toBe('given/by/caller.dng');
  });

  test('swallows a write failure rather than failing the asset mutation', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await recordAndPublishAssetChange(
      change({ kind: 'sideways' as RecordChangeInput['kind'] }),
      db,
    );
    expect(storedRows(handle)).toHaveLength(0);
    expect(getChangeBus().snapshot()).toHaveLength(0);
  });
});

describe('listChangesSince', () => {
  test('returns rows in cursor order', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) await recordAssetChange(db, change());
    const rows = await listChangesSince(db, { since: 0, limit: 100 });
    expect(rows.map((row) => row.cursor)).toEqual([1, 2, 3, 4, 5]);
  });

  test('respects the since cursor', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 5; i++) await recordAssetChange(db, change());
    const tail = await listChangesSince(db, { since: 3, limit: 100 });
    expect(tail.map((row) => row.cursor)).toEqual([4, 5]);
  });

  test('clamps the limit to the route ceiling', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    for (let i = 0; i < 10; i++) await recordAssetChange(db, change());
    expect(await listChangesSince(db, { since: 0, limit: 3 })).toHaveLength(3);
    expect(await listChangesSince(db, { since: 0, limit: 0 })).toHaveLength(1);
    expect(await listChangesSince(db, { since: 0, limit: 100_000 })).toHaveLength(10);
  });

  test('round-trips the nullable columns', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await recordAssetChange(db, {
      kind: 'delete',
      asset_id: null,
      folder_id: null,
      abs_path: null,
    });
    const [row] = await listChangesSince(db, { since: 0, limit: 10 });
    expect(row!.asset_id).toBeNull();
    expect(row!.folder_id).toBeNull();
    expect(row!.abs_path).toBeNull();
    expect(row!.relative_path).toBeNull();
    expect(row!.at).toBeInstanceOf(Date);
  });
});

describe('computeRelativePath', () => {
  test('returns an empty string when absPath equals the folder root', () => {
    expect(computeRelativePath('/srv/photos', '/srv/photos')).toBe('');
  });
  test('strips the folder prefix for nested paths', () => {
    expect(computeRelativePath('/srv/photos', '/srv/photos/a/b/c.dng')).toBe('a/b/c.dng');
  });
  test('normalises a trailing slash on the folder root', () => {
    expect(computeRelativePath('/srv/photos/', '/srv/photos/x.dng')).toBe('x.dng');
  });
  test('returns null when absPath is outside the folder root', () => {
    expect(computeRelativePath('/srv/photos', '/elsewhere/x.dng')).toBeNull();
  });
  test('does not false-match a sibling with a shared prefix', () => {
    expect(computeRelativePath('/srv/photos', '/srv/photos2/x.dng')).toBeNull();
  });
});
