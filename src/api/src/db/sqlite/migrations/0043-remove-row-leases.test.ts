import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { removeRowLeasesMigration } from './0043-remove-row-leases.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertFolder,
} from '../test-sqlite.test-helpers.ts';
import { NEXT_JOB_SQL } from '../../repos/jobs.sql.ts';

const previous = ALL_MIGRATIONS.filter((migration) => migration.id < removeRowLeasesMigration.id);
const JOB = '1'.repeat(24);
const IMPORT = '2'.repeat(24);
const LEASE = '2026-01-01T00:05:00.000Z';

const columnsOf = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

const indexesOf = (db: Database, table: string): string[] =>
  (
    db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
      )
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);

function seedLeasedRows(db: Database): void {
  db.run(
    `INSERT INTO jobs (id, kind, status, locked_by, lease_expires_at, created_at, updated_at)
     VALUES (?, 'batch_jpeg_export', 'running', 'attempt-1', ?, 'then', 'then')`,
    [JOB, LEASE],
  );
  const library = insertFolder(db);
  db.run(
    `INSERT INTO imports (id, status, source_root, library_id, library_root, locked_by,
                          lease_expires_at, created_at, updated_at)
     VALUES (?, 'running', '/src', ?, '/lib', 'attempt-2', ?, 'then', 'then')`,
    [IMPORT, library, LEASE],
  );
}

test('an existing file drops both leases and keeps every job and import as it was', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  seedLeasedRows(handle.db);
  using reopened = new Database(handle.path);
  const applied = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);
  expect(applied.applied).toEqual(
    ALL_MIGRATIONS.filter((migration) => migration.id >= removeRowLeasesMigration.id).map(
      (migration) => migration.id,
    ),
  );
  expect(columnsOf(reopened, 'jobs')).not.toContain('lease_expires_at');
  expect(columnsOf(reopened, 'imports')).not.toContain('lease_expires_at');
  expect(reopened.query('SELECT status, locked_by FROM jobs WHERE id = ?').get(JOB)).toEqual({
    status: 'running',
    locked_by: 'attempt-1',
  });
  expect(reopened.query('SELECT status, locked_by FROM imports WHERE id = ?').get(IMPORT)).toEqual({
    status: 'running',
    locked_by: 'attempt-2',
  });
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect((await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS)).applied).toEqual([]);
});

test('fresh installs have no lease columns, and the relay still finds the next job by status', async () => {
  using handle = await createTestDatabase();
  expect(columnsOf(handle.db, 'jobs')).not.toContain('lease_expires_at');
  expect(columnsOf(handle.db, 'imports')).not.toContain('lease_expires_at');
  expect(indexesOf(handle.db, 'jobs')).toEqual(['jobs_list', 'jobs_status']);
  expect(indexesOf(handle.db, 'imports')).toEqual(['imports_list']);
  const plan = (
    handle.db.query(`EXPLAIN QUERY PLAN ${NEXT_JOB_SQL}`).all() as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join(' | ');
  expect(plan).toContain('jobs_status');
});

test('a failed upgrade keeps both leases and does not record completion', async () => {
  using handle = createBlankTestDatabase();
  await runMigrations(handle.migrationDb, previous);
  seedLeasedRows(handle.db);
  const failed = {
    ...removeRowLeasesMigration,
    async up(db: typeof handle.migrationDb) {
      await removeRowLeasesMigration.up(db);
      throw new Error('interrupted lease cleanup');
    },
  };
  await expect(runMigrations(handle.migrationDb, [...previous, failed])).rejects.toThrow(
    'interrupted lease cleanup',
  );
  expect(handle.db.query('SELECT lease_expires_at FROM jobs').all()).toEqual([
    { lease_expires_at: LEASE },
  ]);
  expect(handle.db.query('SELECT lease_expires_at FROM imports').all()).toEqual([
    { lease_expires_at: LEASE },
  ]);
  expect(
    handle.db.query('SELECT id FROM schema_migrations WHERE id = ?').get(failed.id),
  ).toBeNull();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(columnsOf(handle.db, 'jobs')).not.toContain('lease_expires_at');
});
