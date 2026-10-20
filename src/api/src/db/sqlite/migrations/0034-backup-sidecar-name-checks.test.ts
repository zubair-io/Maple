import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

test('adds the canonical-backup-sidecars done table and leaves assets unchanged', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain('0034-backup-sidecar-name-checks');
  const columns = handle.db.query(`PRAGMA table_info(backup_sidecar_name_checks)`).all() as {
    name: string;
  }[];
  expect(columns.map((c) => c.name)).toEqual(['asset_id', 'checked']);
  const assetColumns = handle.db.query(`PRAGMA table_info(assets)`).all() as { name: string }[];
  expect(assetColumns.map((c) => c.name)).not.toContain('backup_sidecar_name_version');
});
