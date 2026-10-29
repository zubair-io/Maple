/**
 * `findAssetLocationsByFilenames` — the lookup a pano request uses to turn the
 * paths it names into asset ids. An asset in the trash is never an answer.
 */

import { expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { findAssetLocationsByFilenames } from './assets.by-filename.ts';

test('answers live assets and leaves trashed ones out', async () => {
  using handle = await createTestDatabase();
  const library = insertFolder(handle.db);
  const live = insertAsset(handle.db);
  const trashed = insertAsset(handle.db);
  insertLocation(handle.db, { assetId: live, libraryId: library, filename: 'a.dng' });
  insertLocation(handle.db, { assetId: trashed, libraryId: library, path: 'x', filename: 'a.dng' });
  run(
    handle.db,
    `UPDATE assets SET deleted_at = ? WHERE id = ?`,
    new Date().toISOString(),
    trashed,
  );

  const found = await findAssetLocationsByFilenames(['a.dng'], testSqliteDb(handle.db));

  expect(found.map((row) => row._id.toHexString())).toEqual([live]);
});

test('answers nothing when no location carries the name', async () => {
  using handle = await createTestDatabase();
  expect(await findAssetLocationsByFilenames(['none.dng'], testSqliteDb(handle.db))).toEqual([]);
});
