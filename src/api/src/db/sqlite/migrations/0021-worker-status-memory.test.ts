import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('adds the memory column to an existing worker_status row', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0021-worker-status-memory'),
  );
  handle.db.run(
    `INSERT INTO worker_status (id, statuses, updated_at) VALUES ('singleton', '{}', 0)`,
  );

  const result = await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0021-worker-status-memory'),
  );
  const columns = (
    handle.db.query(`PRAGMA table_info(worker_status)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const row = handle.db.query(`SELECT memory FROM worker_status`).get() as { memory: unknown };

  expect(result.applied).toEqual(['0021-worker-status-memory']);
  expect(columns).toContain('memory');
  expect(row.memory).toBeNull();
  expect(() =>
    handle.db.run(`UPDATE worker_status SET memory = 'not json' WHERE id = 'singleton'`),
  ).toThrow();
});
