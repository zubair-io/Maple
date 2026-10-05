import { expect, test } from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import { appendOrRefreshLocation } from '../db/repos/assets.discover.dedup.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

test('discovery cannot append or transfer a location into a purge-admitted identity', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db);
  const assetId = insertAsset(live.db);
  const otherId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '.maple/trash', filename: 'photo.dng' });
  insertLocation(live.db, { assetId: otherId, libraryId, filename: 'other.dng' });
  const before = live.db.query('SELECT * FROM assets WHERE id=?').get(assetId);
  await live.handle.write(
    `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at) VALUES(?,?,'purge','committed',?)`,
    [crypto.randomUUID(), assetId, new Date().toISOString()],
  );
  await expect(
    appendOrRefreshLocation(
      {
        id: new ObjectId(assetId),
        deletedAt: null,
        locations: [],
      },
      {
        library_id: new ObjectId(libraryId),
        path: '',
        filename: 'appended.dng',
        keep: false,
      },
      { indexedAt: new Date().toISOString(), mtime: 123, size: 456 },
      undefined,
      live.handle,
    ),
  ).rejects.toThrow('durable backup purge intent');
  expect(live.db.query('SELECT * FROM assets WHERE id=?').get(assetId)).toEqual(before);
  await expect(
    live.handle.write('UPDATE asset_locations SET asset_id=? WHERE asset_id=?', [assetId, otherId]),
  ).rejects.toThrow('durable backup purge intent');
  expect(
    live.db.query('SELECT COUNT(*) AS n FROM asset_locations WHERE asset_id=?').get(assetId),
  ).toEqual({ n: 1 });
  expect(
    live.db.query('SELECT asset_id FROM asset_locations WHERE filename=?').get('other.dng'),
  ).toEqual({ asset_id: otherId });
  // Indexing a different identity is unaffected, including at a reused path.
  insertLocation(live.db, { assetId: otherId, ordinal: 1, libraryId, filename: 'appended.dng' });
});
