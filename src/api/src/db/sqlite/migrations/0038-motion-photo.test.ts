import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset, run } from '../test-sqlite.test-helpers.ts';

const ID = '0038-motion-photo';
const BEFORE = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);

function motionStage(db: Database, id: string) {
  return db
    .query(
      "SELECT version, attempts, dead FROM stage_state WHERE asset_id = ? AND stage = 'motion-photo'",
    )
    .get(id);
}

test('existing assets get a motion-photo stage row', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, BEFORE);
  const id = insertAsset(handle.db, {});

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toEqual([ID]);
  expect(motionStage(handle.db, id)).toEqual({
    version: 0,
    attempts: 0,
    dead: 0,
  });
});

test('a size or mtime change re-arms the stage; other updates leave it alone', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const id = insertAsset(handle.db, {});
  run(
    handle.db,
    `INSERT INTO stage_state(asset_id, stage, version, attempts, dead)
     VALUES(?, 'motion-photo', 1, 2, 1)`,
    id,
  );

  run(handle.db, "UPDATE assets SET maple_id = 'x' WHERE id = ?", id);
  expect(motionStage(handle.db, id)).toEqual({
    version: 1,
    attempts: 2,
    dead: 1,
  });

  run(handle.db, 'UPDATE assets SET size = size + 1 WHERE id = ?', id);
  expect(motionStage(handle.db, id)).toEqual({
    version: 0,
    attempts: 0,
    dead: 0,
  });
});

test('the clip columns reject impossible ranges and unknown content types', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const id = insertAsset(handle.db, {});

  expect(() =>
    run(handle.db, 'UPDATE assets SET motion_video_length = 0 WHERE id = ?', id),
  ).toThrow();
  expect(() =>
    run(handle.db, "UPDATE assets SET motion_video_mime = 'video/webm' WHERE id = ?", id),
  ).toThrow();
});
