import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset } from '../test-sqlite.test-helpers.ts';

const ID = '0045-backup-sidecar-sends';

test('backup_sidecar_sends keeps a device send keyed by asset, digest and history entry', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const columns = handle.db.query(`PRAGMA table_info(backup_sidecar_sends)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  expect(columns.map((c) => [c.name, c.notnull, c.pk])).toEqual([
    ['asset_id', 1, 1],
    ['sent_sha256', 1, 2],
    ['entry_id', 1, 3],
    ['sent_checkpoint', 1, 0],
  ]);
});

test('deleting an asset removes its kept sends with it', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  handle.db.exec('PRAGMA foreign_keys = ON');
  const assetId = insertAsset(handle.db);
  handle.db
    .query(
      `INSERT INTO backup_sidecar_sends (asset_id, sent_sha256, entry_id, sent_checkpoint)
       VALUES (?, 'd', 'e', '<x/>')`,
    )
    .run(assetId);
  handle.db.query(`DELETE FROM assets WHERE id = ?`).run(assetId);
  expect(handle.db.query(`SELECT COUNT(*) AS n FROM backup_sidecar_sends`).get()).toEqual({ n: 0 });
});
