import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { removeUnusedStageHandlersMigration } from './0042-remove-unused-stage-handlers.ts';
import { createBlankTestDatabase, createTestDatabase } from '../test-sqlite.test-helpers.ts';

const previous = ALL_MIGRATIONS.filter(
  (migration) => migration.id < removeUnusedStageHandlersMigration.id,
);
const handlerTable = "SELECT name FROM sqlite_master WHERE name = 'stage_handlers'";

function seedOverride(db: Database): void {
  db.run(
    "INSERT INTO stage_handlers (stage, impl, url, timeout_ms, enabled) VALUES ('ai', 'http', 'http://ai.test', 1000, 1)",
  );
}

test('an existing file drops the unused handler overrides and keeps worker settings', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  seedOverride(handle.db);
  handle.db.run("INSERT INTO worker_config (name, concurrency) VALUES ('thumb', 3)");
  const settings = handle.db.query('SELECT * FROM worker_config').all();
  using reopened = new Database(handle.path);
  const applied = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  expect(applied.applied).toEqual(
    ALL_MIGRATIONS.filter((migration) => migration.id >= removeUnusedStageHandlersMigration.id).map(
      (migration) => migration.id,
    ),
  );
  expect(reopened.query(handlerTable).all()).toEqual([]);
  expect(reopened.query('SELECT * FROM worker_config').all()).toEqual(settings);
  expect((await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS)).applied).toEqual([]);
});

test('fresh installs have no handler override table', async () => {
  using handle = await createTestDatabase();
  expect(handle.db.query(handlerTable).all()).toEqual([]);
});

test('a failed upgrade keeps the overrides and does not record completion', async () => {
  using handle = createBlankTestDatabase();
  await runMigrations(handle.migrationDb, previous);
  seedOverride(handle.db);
  const failed = {
    ...removeUnusedStageHandlersMigration,
    async up(db: typeof handle.migrationDb) {
      await removeUnusedStageHandlersMigration.up(db);
      throw new Error('interrupted handler cleanup');
    },
  };
  await expect(runMigrations(handle.migrationDb, [...previous, failed])).rejects.toThrow(
    'interrupted handler cleanup',
  );
  expect(handle.db.query('SELECT stage FROM stage_handlers').all()).toEqual([{ stage: 'ai' }]);
  expect(
    handle.db.query('SELECT id FROM schema_migrations WHERE id = ?').get(failed.id),
  ).toBeNull();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(handle.db.query(handlerTable).all()).toEqual([]);
});
