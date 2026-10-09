import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset } from '../test-sqlite.test-helpers.ts';

test('adds the live month index over an existing library', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0019-assets-live-month'),
  );
  insertAsset(handle.db);

  const result = await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0019-assets-live-month'),
  );
  const index = handle.db
    .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'assets_live_month'`)
    .get() as { sql: string } | null;

  expect(result.applied).toEqual(['0019-assets-live-month']);
  expect(index?.sql).toContain('(captured_month, hidden, id)');
  expect(index?.sql).toContain('WHERE deleted_at IS NULL AND live_location_count > 0');
});
