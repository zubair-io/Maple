import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';

const ID = '0035-native-code-issued-ip';

test('native_auth_codes gains a nullable issued_ip column', async () => {
  using handle = createBlankTestDatabase('file');
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain(ID);
  const columns = (
    handle.db.query(`PRAGMA table_info(native_auth_codes)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).filter((column) => column.name === 'issued_ip');
  expect(columns).toHaveLength(1);
  expect(columns[0]).toMatchObject({ name: 'issued_ip', notnull: 0, dflt_value: null });
});
