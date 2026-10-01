import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { repointAssetLocation } from './assets.relocate.repo.ts';

function seedMove(handle: TestDatabase) {
  const libraryId = insertFolder(handle.db);
  const incomingId = insertAsset(handle.db);
  const deletedId = insertAsset(handle.db, { deletedAt: '2026-01-01T00:00:00.000Z' });
  insertLocation(handle.db, { assetId: incomingId, libraryId, path: 'a', filename: 'x.dng' });
  insertLocation(handle.db, { assetId: deletedId, libraryId, path: 'b', filename: 'y.dng' });
  return {
    incomingId,
    deletedId,
    args: {
      id: new ObjectId(incomingId),
      from: { libraryId: new ObjectId(libraryId), path: 'a', filename: 'x.dng' },
      to: { libraryId: new ObjectId(libraryId), path: 'b', filename: 'y.dng' },
    },
  };
}

function locations(handle: TestDatabase) {
  return handle.db.query('SELECT * FROM asset_locations ORDER BY asset_id, ordinal').all();
}

describe('relocate dead-claim transaction', () => {
  test.each(['moved', 'tombstoned'] as const)(
    'leaves the destination claim intact when the source was %s concurrently',
    async (sourceState) => {
      using handle = await createTestDatabase();
      const { incomingId, args } = seedMove(handle);
      const sql =
        sourceState === 'moved'
          ? "UPDATE asset_locations SET path = 'elsewhere' WHERE asset_id = ?"
          : "UPDATE asset_locations SET deleted_at = '2026-02-01' WHERE asset_id = ?";
      run(handle.db, sql, incomingId);
      const before = locations(handle);

      expect(await repointAssetLocation(args, testSqliteDb(handle.db))).toBe(false);
      expect(locations(handle)).toEqual(before);
    },
  );

  test('rolls back the dead-claim removal if the incoming location update fails', async () => {
    using handle = await createTestDatabase();
    const { args } = seedMove(handle);
    const before = locations(handle);
    handle.db.exec(`
      CREATE TRIGGER reject_repoint BEFORE UPDATE ON asset_locations
      WHEN NEW.path = 'b'
      BEGIN SELECT RAISE(ABORT, 'repoint rejected'); END;
    `);

    await expect(repointAssetLocation(args, testSqliteDb(handle.db))).rejects.toThrow(
      'repoint rejected',
    );
    expect(locations(handle)).toEqual(before);
  });

  test('releases a tombstoned location without deleting its still-live asset or other copies', async () => {
    using handle = await createTestDatabase();
    const { deletedId, args } = seedMove(handle);
    run(handle.db, 'UPDATE assets SET deleted_at = NULL WHERE id = ?', deletedId);
    run(
      handle.db,
      "UPDATE asset_locations SET deleted_at = '2026-01-01' WHERE asset_id = ?",
      deletedId,
    );
    insertLocation(handle.db, {
      assetId: deletedId,
      libraryId: args.to.libraryId.toHexString(),
      ordinal: 1,
      path: 'other',
      filename: 'copy.dng',
    });
    const before = handle.db.query('SELECT * FROM assets WHERE id = ?').get(deletedId);

    expect(await repointAssetLocation(args, testSqliteDb(handle.db))).toBe(true);
    expect(handle.db.query('SELECT * FROM assets WHERE id = ?').get(deletedId)).toEqual(before);
    expect(
      handle.db
        .query('SELECT path, filename FROM asset_locations WHERE asset_id = ?')
        .all(deletedId),
    ).toEqual([{ path: 'other', filename: 'copy.dng' }]);
  });
});
