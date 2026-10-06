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

test('existing active and Trash photos receive backup stage rows without resetting other work', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((m) => m.id < '0014-cloud-backup'),
  );
  const active = insertAsset(handle.db);
  const trashed = insertAsset(handle.db, { deletedAt: '2026-10-04T00:00:00Z' });
  const libraryId = insertFolder(handle.db);
  insertLocation(handle.db, { assetId: active, libraryId, path: '', filename: 'active.dng' });
  insertLocation(handle.db, {
    assetId: trashed,
    libraryId,
    path: '.maple/trash',
    filename: 'trash.dng',
  });
  run(
    handle.db,
    `INSERT INTO stage_state(asset_id,stage,version,attempts) VALUES(?,'thumb',3,2)`,
    active,
  );
  const before = handle.db.query('SELECT * FROM assets ORDER BY id').all();
  expect(
    handle.db.query(`SELECT COUNT(*) AS n FROM stage_state WHERE stage='cloud-backup'`).get(),
  ).toEqual({ n: 0 });
  expect(
    (
      await runMigrations(
        handle.migrationDb,
        ALL_MIGRATIONS.filter((m) => m.id <= '0014-cloud-backup'),
      )
    ).applied,
  ).toEqual(['0014-cloud-backup']);
  const rows = handle.db
    .query(
      `SELECT asset_id,version,attempts,dead FROM stage_state WHERE stage='cloud-backup' ORDER BY asset_id`,
    )
    .all();
  expect(rows).toEqual(
    [active, trashed].sort().map((asset_id) => ({ asset_id, version: 0, attempts: 0, dead: 0 })),
  );
  expect(
    handle.db
      .query(`SELECT version,attempts FROM stage_state WHERE stage='thumb' AND asset_id=?`)
      .get(active),
  ).toEqual({ version: 3, attempts: 2 });
  expect(handle.db.query('SELECT * FROM assets ORDER BY id').all()).toEqual(before);
  expect(
    (
      await runMigrations(
        handle.migrationDb,
        ALL_MIGRATIONS.filter((m) => m.id <= '0014-cloud-backup'),
      )
    ).applied,
  ).toEqual([]);
  expect(
    handle.db.query(`SELECT COUNT(*) AS n FROM stage_state WHERE stage='cloud-backup'`).get(),
  ).toEqual({ n: 2 });
  expect(handle.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});
