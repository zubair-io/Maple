import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from './migrate.ts';
import { ALL_MIGRATIONS } from './migrations/index.ts';
import { assetWorkingSetSortMigration } from './migrations/0007-asset-working-set-sort.ts';
import { listItemsSql } from '../repos/assets.sql.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from './test-sqlite.test-helpers.ts';

const priorMigrations = ALL_MIGRATIONS.filter(
  (migration) => migration.id < assetWorkingSetSortMigration.id,
);

function sortColumns(db: Database): string[] {
  return (db.query('PRAGMA table_xinfo(assets)').all() as { name: string }[]).map(
    (column) => column.name,
  );
}

describe('asset working-set sort migration', () => {
  test('upgrades a populated file, preserves metadata and stays applied across connections', async () => {
    using handle = createBlankTestDatabase('file');
    const { db } = handle;
    await runMigrations(handle.migrationDb, priorMigrations);
    const libraryId = insertFolder(db);
    const dated = insertAsset(db, {
      exif: JSON.stringify({ captured_at: '2026-01-01T00:00:00.000Z' }),
    });
    const undated = insertAsset(db, { exif: JSON.stringify({ iso: 100, maker: 'unchanged' }) });
    for (const [i, assetId] of [dated, undated].entries()) {
      insertLocation(db, { assetId, libraryId, filename: `${i}.dng` });
      run(db, 'UPDATE assets SET indexed_at = ? WHERE id = ?', '2027-01-01T00:00:00.000Z', assetId);
    }
    const metadataSql = 'SELECT id, mtime, indexed_at, exif FROM assets ORDER BY id';
    const before = db.query(metadataSql).all();
    expect(sortColumns(db)).not.toContain('sort_at');
    expect(db.query('SELECT id FROM assets ORDER BY captured_at DESC, id LIMIT 1').get()).toEqual({
      id: dated,
    });

    const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
    expect(result.applied).toContain(assetWorkingSetSortMigration.id);
    expect(db.query(metadataSql).all()).toEqual(before);
    const reopened = new Database(handle.path, { readonly: true });
    try {
      expect(reopened.query(listItemsSql([], true)).get(1)).toMatchObject({ id: undated });
      expect(reopened.query('PRAGMA index_info(assets_live_sorted)').all()).toMatchObject([
        { name: 'sort_at' },
        { name: 'id' },
      ]);
    } finally {
      reopened.close();
    }
    expect((await runMigrations(handle.migrationDb, ALL_MIGRATIONS)).applied).toEqual([]);
  });

  test('updates the generated index when capture metadata or indexing time changes', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db);
    const a = insertAsset(db);
    const b = insertAsset(db);
    for (const [assetId, date] of [
      [a, '2024-01-01'],
      [b, '2023-01-01'],
    ]) {
      insertLocation(db, { assetId, libraryId });
      run(db, 'UPDATE assets SET indexed_at = ? WHERE id = ?', date, assetId);
    }
    const first = () => (db.query(listItemsSql([], true)).get(1) as { id: string }).id;
    expect(first()).toBe(a);
    run(
      db,
      'UPDATE assets SET exif = ? WHERE id = ?',
      JSON.stringify({ captured_at: '2020-01-01' }),
      a,
    );
    expect(first()).toBe(b);
    run(db, 'UPDATE assets SET exif = NULL WHERE id = ?', a);
    expect(first()).toBe(a);
    run(db, 'UPDATE assets SET indexed_at = ? WHERE id = ?', '2022-01-01', a);
    expect(first()).toBe(b);
  });

  test('rolls back the added column and sentinel if index creation fails', async () => {
    using handle = createBlankTestDatabase();
    await runMigrations(handle.migrationDb, priorMigrations);
    handle.db.exec('CREATE INDEX assets_live_sorted ON assets (id)');
    await expect(runMigrations(handle.migrationDb, ALL_MIGRATIONS)).rejects.toThrow(
      assetWorkingSetSortMigration.id,
    );
    expect(sortColumns(handle.db)).not.toContain('sort_at');
    expect(
      handle.db
        .query('SELECT id FROM schema_migrations WHERE id = ?')
        .get(assetWorkingSetSortMigration.id),
    ).toBeNull();
  });
});
