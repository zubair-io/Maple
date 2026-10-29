/**
 * `findAssetLocationsByFilenames` — the lookup a pano request uses to turn the
 * paths it names into asset ids. A trashed holder comes back marked.
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

test('answers every holder of the name and marks the trashed one', async () => {
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

  const state = new Map(found.map((row) => [row._id.toHexString(), row.deleted_at !== null]));
  expect(state).toEqual(
    new Map([
      [live, false],
      [trashed, true],
    ]),
  );
});

test('answers nothing when no location carries the name', async () => {
  using handle = await createTestDatabase();
  expect(await findAssetLocationsByFilenames(['none.dng'], testSqliteDb(handle.db))).toEqual([]);
});
