import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../test-sqlite.test-helpers.ts';

test('destination coverage counts backfill correctly and track location and Trash changes', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0015-person-segmentations'),
  );
  const libraryId = insertFolder(handle.db);
  const zeroLibraryId = insertFolder(handle.db);
  const liveAsset = insertAsset(handle.db);
  const missingAsset = insertAsset(handle.db);
  const reapedAsset = insertAsset(handle.db);
  insertLocation(handle.db, {
    assetId: liveAsset,
    libraryId,
    filename: 'live.dng',
  });
  insertLocation(handle.db, {
    assetId: missingAsset,
    libraryId,
    filename: 'missing.dng',
    missingSince: '2026-10-01T00:00:00Z',
  });
  insertLocation(handle.db, {
    assetId: reapedAsset,
    libraryId,
    filename: 'reaped.dng',
  });
  run(handle.db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, reapedAsset);

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toEqual(['0016-cloud-backup-destination-status']);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(libraryId),
  ).toEqual({ live_locations: 1 });
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(zeroLibraryId),
  ).toEqual({ live_locations: 0 });
  expect(
    handle.db
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND name IN
        ('asset_locations_library_missing','assets_reaped') ORDER BY name`,
      )
      .all(),
  ).toEqual([{ name: 'asset_locations_library_missing' }, { name: 'assets_reaped' }]);

  run(handle.db, `UPDATE asset_locations SET missing_since=NULL WHERE asset_id=?`, missingAsset);
  run(handle.db, `UPDATE assets SET deleted_reason=NULL WHERE id=?`, reapedAsset);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(libraryId),
  ).toEqual({ live_locations: 3 });
  run(
    handle.db,
    `UPDATE asset_locations SET deleted_at='2026-10-02T00:00:00Z' WHERE asset_id=?`,
    liveAsset,
  );
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(libraryId),
  ).toEqual({ live_locations: 2 });
  run(handle.db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, reapedAsset);
  run(handle.db, `DELETE FROM assets WHERE id=?`, reapedAsset);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(libraryId),
  ).toEqual({ live_locations: 1 });
  run(handle.db, `DELETE FROM assets WHERE id=?`, missingAsset);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(libraryId),
  ).toEqual({ live_locations: 0 });
  expect(handle.db.query('PRAGMA foreign_key_check').all()).toEqual([]);

  const emptyLibraryId = insertFolder(handle.db);
  const initiallyReaped = insertAsset(handle.db);
  run(handle.db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, initiallyReaped);
  insertLocation(handle.db, {
    assetId: initiallyReaped,
    libraryId: emptyLibraryId,
    filename: 'rediscovered.dng',
    missingSince: '2026-10-03T00:00:00Z',
  });
  run(handle.db, `UPDATE asset_locations SET missing_since=NULL WHERE asset_id=?`, initiallyReaped);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(emptyLibraryId),
  ).toBeNull();
  run(handle.db, `UPDATE assets SET deleted_reason=NULL WHERE id=?`, initiallyReaped);
  expect(
    handle.db
      .query(`SELECT live_locations FROM backup_coverage_counts WHERE library_id=?`)
      .get(emptyLibraryId),
  ).toEqual({ live_locations: 1 });
});
