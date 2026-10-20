import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('worker_config gains a nullable stall_after_minutes column', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain('0033-worker-stall-threshold');
  const columns = handle.db.query(`PRAGMA table_info(worker_config)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  expect(columns.find((c) => c.name === 'stall_after_minutes')).toMatchObject({ notnull: 0 });
});
