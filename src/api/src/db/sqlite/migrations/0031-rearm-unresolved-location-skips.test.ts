import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../test-sqlite.test-helpers.ts';

const ID = '0031-rearm-unresolved-location-skips';

test('rows that recorded the unresolved-location skip are re-armed, other rows keep their state', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id !== ID),
  );
  const libraryId = insertFolder(handle.db, { slug: 'lib', path: '/lib' });
  const assetWith = (filename: string) => {
    const id = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: id, libraryId, path: '', filename });
    return id;
  };
  const skipped = assetWith('a.dng');
  const healthy = assetWith('b.dng');
  const sidecarSkipped = assetWith('c.dng');
  const insertRow = (assetId: string, version: number, lastError: string | null, stage = 'exif') =>
    handle.db.run(
      `INSERT INTO stage_state (asset_id, stage, version, processed_at, last_error)
       VALUES (?, ?, ?, '2026-10-01T00:00:00Z', ?)`,
      [assetId, stage, version, lastError],
    );
  insertRow(skipped, 3, 'skip: no-resolvable-location');
  insertRow(healthy, 3, 'skip: not-an-image');
  insertRow(sidecarSkipped, 2, 'skip: no-path', 'sidecar-metadata-index');

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toEqual([ID]);

  const row = (assetId: string) =>
    handle.db
      .query(`SELECT version, processed_at, last_error FROM stage_state WHERE asset_id = ?`)
      .get(assetId);
  expect(row(skipped)).toEqual({ version: 0, processed_at: null, last_error: null });
  expect(row(sidecarSkipped)).toEqual({ version: 0, processed_at: null, last_error: null });
  expect(row(healthy)).toEqual({
    version: 3,
    processed_at: '2026-10-01T00:00:00Z',
    last_error: 'skip: not-an-image',
  });
});
