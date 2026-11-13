import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { createBlankTestDatabase } from '../test-sqlite.test-helpers.ts';
import { flaggedPersonIdsSql } from '../../repos/people.sql.ts';

const PEOPLE_FLAG_COLUMNS = ['excluded', 'hidden'] as const;

test('the flag lookups read a partial index and never scan people', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0027-people-flag-indexes'),
  );

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toContain('0027-people-flag-indexes');
  for (const column of PEOPLE_FLAG_COLUMNS) {
    const plan = (
      handle.db.query(`EXPLAIN QUERY PLAN ${flaggedPersonIdsSql(column)}`).all() as Array<{
        detail: string;
      }>
    )
      .map((row) => row.detail)
      .join(' | ');
    expect(plan).toContain(`COVERING INDEX people_${column}`);
    expect(plan).not.toMatch(/SCAN people(?! USING)/);
  }
});

test('the indexes hold exactly the flagged people', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  const insert = handle.db.query(
    `INSERT INTO people (id, name, name_key, created_at, updated_at, hidden, excluded)
     VALUES (?, ?, ?, '2026-10-12', '2026-10-12', ?, ?)`,
  );
  insert.run('a'.repeat(24), 'Plain', 'plain', 0, 0);
  insert.run('b'.repeat(24), 'Hidden', 'hidden', 1, 0);
  insert.run('c'.repeat(24), 'Excluded', 'excluded', 0, 1);

  const ids = (column: (typeof PEOPLE_FLAG_COLUMNS)[number]): string[] =>
    (handle.db.query(flaggedPersonIdsSql(column)).all() as Array<{ id: string }>).map(
      (row) => row.id,
    );

  expect(ids('hidden')).toEqual(['b'.repeat(24)]);
  expect(ids('excluded')).toEqual(['c'.repeat(24)]);
});
