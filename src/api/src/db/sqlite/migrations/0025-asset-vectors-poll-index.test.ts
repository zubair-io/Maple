import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('the search child reads changes and counts from the index alone', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0025-asset-vectors-poll-index'),
  );

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const plans = [
    `SELECT maple_id, embedded_at FROM asset_vectors
      WHERE embedded_at > '2026-10-10' AND dims = 1024 AND model IN ('bge-m3', 'bge-m3:latest')
      ORDER BY embedded_at, maple_id`,
    `SELECT COUNT(*) FROM asset_vectors WHERE dims = 1024 AND model IN ('bge-m3', 'bge-m3:latest')`,
  ].map((sql) =>
    (handle.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(' | '),
  );

  expect(result.applied).toEqual(['0025-asset-vectors-poll-index']);
  for (const plan of plans) expect(plan).toContain('COVERING INDEX asset_vectors_poll');
  // Both spellings of the model are ranges on the index; only the window's rows are sorted.
  expect(plans[0]).toContain('(model=? AND embedded_at>?)');
});
