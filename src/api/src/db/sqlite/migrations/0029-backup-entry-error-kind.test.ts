import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

const ID = '0029-backup-entry-error-kind';

test('backup entries gain a nullable error_kind column', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const columns = (
    handle.db.query(`PRAGMA table_info(backup_entries)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).filter((column) => column.name === 'error_kind');
  expect(columns).toHaveLength(1);
  expect(columns[0]).toMatchObject({ name: 'error_kind', notnull: 0, dflt_value: null });
});

test('the reconnect sweep probes the partial connection-failure index, not the table', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const plan = (
    handle.db
      .query(
        `EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM backup_entries
          WHERE destination_id=? AND error_kind='connection'
          AND (lease_owner IS NULL OR lease_until<=?)) AS found`,
      )
      .all('dest', 0) as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join(' | ');
  expect(plan).toContain('INDEX backup_entries_connection_failures');
});
