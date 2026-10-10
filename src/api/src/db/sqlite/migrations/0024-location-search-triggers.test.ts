import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../test-sqlite.test-helpers.ts';

test('installs the location triggers over a database that already applied 0022', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0022-asset-vectors'),
  );
  const library = insertFolder(handle.db);
  const asset = insertAsset(handle.db);
  insertLocation(handle.db, {
    assetId: asset,
    libraryId: library,
    missingSince: '2026-10-01T00:00:00.000Z',
  });
  handle.db.run(
    `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'embed', 8)
     ON CONFLICT (asset_id, stage) DO UPDATE SET version = 8`,
    [asset],
  );

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  handle.db.run(`UPDATE asset_locations SET missing_since = NULL WHERE asset_id = ?`, [asset]);
  const row = handle.db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'embed'`)
    .get(asset);

  expect(result.applied).toContain('0024-location-search-triggers');
  expect(row).toEqual({ version: 0 });
});
