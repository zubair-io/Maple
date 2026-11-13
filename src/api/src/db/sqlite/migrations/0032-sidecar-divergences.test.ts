import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset, insertFolder } from '../test-sqlite.test-helpers.ts';

const ID = '0032-sidecar-divergences';

test('sidecar_divergences keeps every displaced version with its digests', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const columns = handle.db.query(`PRAGMA table_info(sidecar_divergences)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  expect(Object.fromEntries(columns.map((c) => [c.name, c.notnull]))).toEqual({
    id: 1,
    asset_id: 1,
    library_id: 1,
    sidecar_rel_path: 1,
    device_id: 1,
    base_sha256: 0,
    displaced_sha256: 1,
    displaced_xmp: 1,
    incoming_sha256: 1,
    created_at: 1,
  });
  const indexes = handle.db.query(`PRAGMA index_list(sidecar_divergences)`).all() as Array<{
    name: string;
  }>;
  expect(indexes.map((i) => i.name)).toContain('sidecar_divergences_asset');
});

test('deleting an asset removes its divergence rows with it', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  handle.db.exec('PRAGMA foreign_keys = ON');
  const libraryId = insertFolder(handle.db, { path: '/photos' });
  const assetId = insertAsset(handle.db);
  handle.db
    .query(
      `INSERT INTO sidecar_divergences (id, asset_id, library_id, sidecar_rel_path, device_id,
         base_sha256, displaced_sha256, displaced_xmp, incoming_sha256, created_at)
       VALUES ('0123456789abcdef01234567', ?, ?, 'a/IMG.HEIC.xmp', 'd', NULL, 'x', '<x/>', 'y', 'now')`,
    )
    .run(assetId, libraryId);
  handle.db.query(`DELETE FROM assets WHERE id = ?`).run(assetId);
  expect(handle.db.query(`SELECT COUNT(*) AS n FROM sidecar_divergences`).get()).toEqual({ n: 0 });
});
