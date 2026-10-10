import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase, insertAsset } from '../test-sqlite.test-helpers.ts';

test('creates the vector table and seeds an embed row for every existing asset', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0022-asset-vectors'),
  );
  const first = insertAsset(handle.db);
  const second = insertAsset(handle.db);

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const seeded = handle.db
    .query(`SELECT asset_id, version FROM stage_state WHERE stage = 'embed' ORDER BY asset_id`)
    .all() as Array<{ asset_id: string; version: number }>;
  const columns = (
    handle.db.query(`PRAGMA table_info(asset_vectors)`).all() as Array<{ name: string }>
  ).map((column) => column.name);

  expect(result.applied).toEqual(['0022-asset-vectors']);
  expect(seeded).toEqual([first, second].sort().map((asset_id) => ({ asset_id, version: 0 })));
  expect(columns).toEqual([
    'maple_id',
    'version',
    'model',
    'endpoint',
    'dims',
    'vector',
    'embedded_at',
  ]);
});

test('refuses a vector whose length disagrees with its dimensions', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(() =>
    handle.db.run(
      `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
       VALUES ('abc', 8, 'bge-m3', 'http://gpu', 2, x'00000000', '2026-10-09T00:00:00Z')`,
    ),
  ).toThrow();
  handle.db.run(
    `INSERT INTO asset_vectors (maple_id, version, model, endpoint, dims, vector, embedded_at)
     VALUES ('abc', 8, 'bge-m3', 'http://gpu', 1, x'0000803f', '2026-10-09T00:00:00Z')`,
  );
});
