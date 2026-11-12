import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset, insertFolder } from '../test-sqlite.test-helpers.ts';

const ID = '0045-backup-sidecar-sends';

test('backup_sidecar_sends keeps a merged send keyed by its sidecar and history entry', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const columns = handle.db.query(`PRAGMA table_info(backup_sidecar_sends)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  expect(columns.map((c) => [c.name, c.notnull, c.pk])).toEqual([
    ['library_id', 1, 1],
    ['sidecar_rel_path', 1, 2],
    ['entry_id', 1, 3],
    ['asset_id', 1, 0],
    ['sent_checkpoint', 1, 0],
  ]);
  const indexes = handle.db.query(`PRAGMA index_list(backup_sidecar_sends)`).all() as Array<{
    name: string;
  }>;
  expect(indexes.map((i) => i.name)).toContain('backup_sidecar_sends_asset');
});

test('deleting an asset removes its sent checkpoints with it', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  handle.db.exec('PRAGMA foreign_keys = ON');
  const libraryId = insertFolder(handle.db, { path: '/photos' });
  const assetId = insertAsset(handle.db);
  handle.db
    .query(
      `INSERT INTO backup_sidecar_sends
         (library_id, sidecar_rel_path, entry_id, asset_id, sent_checkpoint)
       VALUES (?, 'a/IMG.xmp', 'e', ?, '<x/>')`,
    )
    .run(libraryId, assetId);
  handle.db.query(`DELETE FROM assets WHERE id = ?`).run(assetId);
  expect(handle.db.query(`SELECT COUNT(*) AS n FROM backup_sidecar_sends`).get()).toEqual({ n: 0 });
});
