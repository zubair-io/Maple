import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('adds the local purge obligation table with its identity columns and indexes', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain('0036-local-purge-obligations');
  const columns = handle.db.query(`PRAGMA table_info(local_purge_obligations)`).all() as {
    name: string;
  }[];
  expect(columns.map((c) => c.name)).toEqual([
    'id',
    'asset_id',
    'library_id',
    'rel_path',
    'owner_rel_path',
    'kind',
    'dev',
    'ino',
    'size',
    'mtime_ns',
    'attempts',
    'next_attempt_at',
    'last_error',
  ]);
  const indexes = handle.db.query(`PRAGMA index_list(local_purge_obligations)`).all() as {
    name: string;
  }[];
  expect(indexes.map((i) => i.name)).toEqual(
    expect.arrayContaining(['local_purge_obligations_due', 'local_purge_obligations_asset']),
  );
});
