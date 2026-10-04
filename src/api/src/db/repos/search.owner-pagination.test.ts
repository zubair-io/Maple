import { expect, test } from 'bun:test';
import { runMigrations } from '../sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../sqlite/migrations/index.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { searchPage, type SeekPosition } from './search.page.ts';
import { pageSql, seekPredicate } from './search.sql.ts';
import { buildSearchWhere } from './search.where.ts';

const ownerId = '1'.repeat(24);
const migrationId = '0013-owner-capture-pagination';

function ownerWhere() {
  const where = buildSearchWhere({ ownerId });
  if ('error' in where) throw new Error(where.error);
  return where;
}

test.each(['desc', 'asc'] as const)(
  'owner %s pages seek a live ordered index without sorting',
  async (direction) => {
    using handle = await createTestDatabase();
    const index =
      direction === 'desc' ? 'assets_live_owner_captured' : 'assets_live_owner_captured_asc';
    for (const cursor of [
      undefined,
      { v: '2024-01-01', i: 'a'.repeat(24), d: direction },
      { v: null, i: 'a'.repeat(24), d: direction },
    ]) {
      const statement = pageSql(
        ownerWhere(),
        `captured_${direction}`,
        20,
        0,
        cursor ? seekPredicate(cursor) : undefined,
      );
      const rows = handle.db
        .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...statement.params) as { detail: string }[];
      const plan = rows.map((row) => row.detail).join('\n');
      expect(plan).toContain(`SEARCH assets USING INDEX ${index} (owner_id=?`);
      expect(plan).not.toContain('TEMP B-TREE');
    }
  },
);

test.each(['desc', 'asc'] as const)(
  'owner %s cursor pages preserve ties, null dates and visibility',
  async (direction) => {
    using handle = await createTestDatabase();
    const db = handle.db;
    run(
      db,
      'INSERT INTO users (id, role, created_at) VALUES (?, ?, ?)',
      ownerId,
      'owner',
      'created',
    );
    const libraryId = insertFolder(db);
    const specs = [
      { date: null, visible: true },
      { date: '2024-01-01', visible: true },
      { date: '2024-01-01', visible: true },
      { date: '2025-01-01', visible: true },
      { date: '2026-01-01', visible: true, hidden: true },
      { date: '2026-01-01', visible: false },
      { date: '2026-01-01', visible: true, deleted: true },
      { date: '2026-01-01', visible: true, unassigned: true },
    ];
    const ids = specs.map((spec, index) => {
      const id = insertAsset(db, {
        id: String(index + 2).padStart(24, '0'),
        exif: JSON.stringify({ captured_at: spec.date }),
        deletedAt: spec.deleted ? 'deleted' : null,
      });
      if (spec.visible) insertLocation(db, { assetId: id, libraryId });
      run(
        db,
        'UPDATE assets SET owner_id = ?, hidden = ? WHERE id = ?',
        spec.unassigned ? null : ownerId,
        spec.hidden ? 1 : 0,
        id,
      );
      return id;
    });
    const expected = direction === 'desc' ? [ids[3], ids[1], ids[2], ids[0]] : ids.slice(0, 4);
    const adapter = testSqliteDb(db);
    const offset = await searchPage(
      ownerWhere(),
      { sort: `captured_${direction}`, limit: 2, skip: 1 },
      adapter,
    );
    expect(offset.map((row) => row._id.toHexString())).toEqual(expected.slice(1, 3));
    const actual: string[] = [];
    let cursor: SeekPosition | null = null;
    for (let page = 0; page < 10; page++) {
      const rows = await searchPage(
        ownerWhere(),
        { sort: `captured_${direction}`, limit: 1, skip: 0, cursor },
        adapter,
      );
      if (rows.length === 0) break;
      const row = rows[0]!;
      actual.push(row._id.toHexString());
      cursor = { v: row.exif?.captured_at ?? null, i: row._id.toHexString(), d: direction };
    }
    expect(actual).toEqual(expected);
  },
);

test('upgrades the shipped schema once without changing assets', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < migrationId),
  );
  const id = insertAsset(handle.db, { exif: JSON.stringify({ captured_at: '2024-01-01' }) });
  const before = handle.db.query('SELECT * FROM assets WHERE id = ?').get(id);
  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toEqual(
    ALL_MIGRATIONS.filter((migration) => migration.id >= migrationId).map(
      (migration) => migration.id,
    ),
  );
  expect((await runMigrations(handle.migrationDb, ALL_MIGRATIONS)).applied).toEqual([]);
  expect(handle.db.query('SELECT * FROM assets WHERE id = ?').get(id)).toEqual(before);
  expect(handle.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});
