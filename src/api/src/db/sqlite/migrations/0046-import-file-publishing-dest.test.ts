import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { fromBunSqlite, runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import { importFilePublishingDestMigration } from './0046-import-file-publishing-dest.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertFolder,
} from '../test-sqlite.test-helpers.ts';

const previous = ALL_MIGRATIONS.filter(
  (migration) => migration.id < importFilePublishingDestMigration.id,
);
const IMPORT = '4'.repeat(24);

const columnsOf = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

function seedRunningImport(db: Database): void {
  const library = insertFolder(db);
  db.run(
    `INSERT INTO imports (id, status, source_root, library_id, library_root, locked_by,
                          created_at, updated_at)
     VALUES (?, 'running', '/src', ?, '/lib', 'attempt-1', 'then', 'then')`,
    [IMPORT, library],
  );
  db.run(
    `INSERT INTO import_files (import_id, idx, src, dest, size, mtime, kind, state)
     VALUES (?, 0, '/src/IMG.dng', '2024/03/IMG.dng', 1, 0, 'image', 'copied'),
            (?, 1, '/src/IMG.xmp', '2024/03/IMG.xmp', 1, 0, 'sidecar', 'pending')`,
    [IMPORT, IMPORT],
  );
}

const fileRows = (db: Database) =>
  db
    .query('SELECT idx, dest, state, publishing_dest FROM import_files ORDER BY idx')
    .all() as unknown[];

test('an existing file gains the marker column, and every import file row keeps its outcome with no marker', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, previous);
  seedRunningImport(handle.db);
  expect(columnsOf(handle.db, 'import_files')).not.toContain('publishing_dest');

  using reopened = new Database(handle.path);
  const applied = await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS);

  expect(applied.applied).toEqual(
    ALL_MIGRATIONS.filter((migration) => migration.id >= importFilePublishingDestMigration.id).map(
      (migration) => migration.id,
    ),
  );
  expect(fileRows(reopened)).toEqual([
    { idx: 0, dest: '2024/03/IMG.dng', state: 'copied', publishing_dest: null },
    { idx: 1, dest: '2024/03/IMG.xmp', state: 'pending', publishing_dest: null },
  ]);
  expect(reopened.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect((await runMigrations(fromBunSqlite(reopened), ALL_MIGRATIONS)).applied).toEqual([]);
});

test('a fresh install has the marker column, empty on a new row and writable', async () => {
  using handle = await createTestDatabase();
  expect(columnsOf(handle.db, 'import_files')).toContain('publishing_dest');
  seedRunningImport(handle.db);

  handle.db.run(`UPDATE import_files SET publishing_dest = '2024/03/IMG-1.dng' WHERE idx = 0`);

  expect(fileRows(handle.db)).toEqual([
    { idx: 0, dest: '2024/03/IMG.dng', state: 'copied', publishing_dest: '2024/03/IMG-1.dng' },
    { idx: 1, dest: '2024/03/IMG.xmp', state: 'pending', publishing_dest: null },
  ]);
});

test('a failed upgrade leaves the table without the column and does not record completion', async () => {
  using handle = createBlankTestDatabase();
  await runMigrations(handle.migrationDb, previous);
  seedRunningImport(handle.db);
  const failed = {
    ...importFilePublishingDestMigration,
    async up(db: typeof handle.migrationDb) {
      await importFilePublishingDestMigration.up(db);
      throw new Error('interrupted marker upgrade');
    },
  };

  await expect(runMigrations(handle.migrationDb, [...previous, failed])).rejects.toThrow(
    'interrupted marker upgrade',
  );

  expect(columnsOf(handle.db, 'import_files')).not.toContain('publishing_dest');
  expect(
    handle.db.query('SELECT id FROM schema_migrations WHERE id = ?').get(failed.id),
  ).toBeNull();
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(columnsOf(handle.db, 'import_files')).toContain('publishing_dest');
});
