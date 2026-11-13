import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset, run } from '../test-sqlite.test-helpers.ts';

const ID = '0035-apple-live-video-path';
const BEFORE = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);

function companions(db: Database, id: string) {
  return db
    .query('SELECT apple_rendered_path, apple_live_video_path FROM assets WHERE id = ?')
    .get(id);
}

test('a Live twin already recorded as the rendered companion moves to its own slot', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, BEFORE);
  const twin = insertAsset(handle.db, {});
  const rendered = insertAsset(handle.db, {});
  run(handle.db, 'UPDATE assets SET apple_rendered_path = ? WHERE id = ?', '2024/IMG_1.MOV', twin);
  run(
    handle.db,
    'UPDATE assets SET apple_rendered_path = ? WHERE id = ?',
    '2024/IMG_2.rendered.JPEG',
    rendered,
  );

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toEqual([ID]);
  expect(companions(handle.db, twin)).toEqual({
    apple_rendered_path: null,
    apple_live_video_path: '2024/IMG_1.MOV',
  });
  expect(companions(handle.db, rendered)).toEqual({
    apple_rendered_path: '2024/IMG_2.rendered.JPEG',
    apple_live_video_path: null,
  });
});

test('recording a Live twin re-arms the asset for cloud backup', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const id = insertAsset(handle.db, {});
  run(
    handle.db,
    `INSERT INTO stage_state(asset_id,stage,version,processed_at)
     VALUES(?,'cloud-backup',9,'2026-10-04') ON CONFLICT(asset_id,stage)
     DO UPDATE SET version=9,processed_at='2026-10-04'`,
    id,
  );

  run(handle.db, 'UPDATE assets SET apple_live_video_path = ? WHERE id = ?', 'IMG.mov', id);

  expect(
    handle.db
      .query("SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'cloud-backup'")
      .get(id),
  ).toEqual({ version: 0 });
});
