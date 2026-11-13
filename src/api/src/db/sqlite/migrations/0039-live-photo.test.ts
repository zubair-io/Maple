import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset, run } from '../test-sqlite.test-helpers.ts';

const ID = '0039-live-photo';
const BEFORE = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);

function liveStage(db: Database, id: string) {
  return db
    .query(
      "SELECT version, attempts, dead FROM stage_state WHERE asset_id = ? AND stage = 'live-photo'",
    )
    .get(id);
}

test('existing assets get a live-photo stage row', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, BEFORE);
  const id = insertAsset(handle.db, {});

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toEqual([ID]);
  expect(liveStage(handle.db, id)).toEqual({ version: 0, attempts: 0, dead: 0 });
});

test('a size or mtime change re-arms the stage; other updates leave it alone', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const id = insertAsset(handle.db, {});
  run(
    handle.db,
    `INSERT INTO stage_state(asset_id, stage, version, attempts, dead)
     VALUES(?, 'live-photo', 1, 2, 1)`,
    id,
  );

  run(handle.db, "UPDATE assets SET maple_id = 'x' WHERE id = ?", id);
  expect(liveStage(handle.db, id)).toEqual({ version: 1, attempts: 2, dead: 1 });

  run(handle.db, 'UPDATE assets SET size = size + 1 WHERE id = ?', id);
  expect(liveStage(handle.db, id)).toEqual({ version: 0, attempts: 0, dead: 0 });
});

test('the identifier column accepts a plausible token and rejects an implausible one', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const id = insertAsset(handle.db, {});

  run(handle.db, 'UPDATE assets SET live_content_id = ? WHERE id = ?', 'ABCDEF12-3456', id);
  expect(() =>
    run(handle.db, 'UPDATE assets SET live_content_id = ? WHERE id = ?', 'short', id),
  ).toThrow();
});
