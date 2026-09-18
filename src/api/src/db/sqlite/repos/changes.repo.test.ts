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
  listChangesSince,
  recordAndPublishAssetChange,
  recordAssetChange,
  recordAssetChangeRow,
  __resetFolderPathCacheForTests,
  type RecordChangeInput,
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
  __resetFolderPathCacheForTests();
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
