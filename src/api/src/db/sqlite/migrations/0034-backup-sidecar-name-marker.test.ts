import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('assets gain a nullable backup_sidecar_name_version marker', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain('0034-backup-sidecar-name-marker');
  const columns = handle.db.query(`PRAGMA table_info(assets)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  expect(columns.find((c) => c.name === 'backup_sidecar_name_version')).toMatchObject({
    notnull: 0,
  });
});
