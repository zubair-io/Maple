import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset } from '../test-sqlite.test-helpers.ts';

test('adds the unlisted-asset index over an existing library', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0020-assets-unlisted'),
  );
  insertAsset(handle.db);

  const result = await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0020-assets-unlisted'),
  );
  const index = handle.db
    .query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'assets_unlisted'`)
    .get() as { sql: string } | null;

  expect(result.applied).toEqual(['0020-assets-unlisted']);
  expect(index?.sql).toContain(
    'WHERE deleted_at IS NOT NULL OR live_location_count <= 0 OR hidden = 1',
  );
});
