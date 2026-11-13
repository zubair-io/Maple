import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  run,
} from '../test-sqlite.test-helpers.ts';

const ID = '0044-raw-jpeg-stacks';
const BEFORE = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);

function locate(db: Database, library: string, path: string, filename: string, trashed = false) {
  const id = insertAsset(db, trashed ? { deletedAt: '2026-11-01T00:00:00.000Z' } : {});
  run(
    db,
    'INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename) VALUES (?, 0, ?, ?, ?)',
    id,
    library,
    path,
    filename,
  );
  return id;
}

function primaryOf(db: Database, id: string): string | null {
  return (
    db
      .query<
        { p: string | null },
        [string]
      >('SELECT stack_primary_id AS p FROM assets WHERE id = ?')
      .get(id)?.p ?? null
  );
}

test('existing pairs are backfilled by the listing rule, folder by folder', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, BEFORE);
  const lib = insertFolder(handle.db, { slug: 'photos' });
  const raw = locate(handle.db, lib, 'trip', 'IMG_1.CR3');
  const jpeg = locate(handle.db, lib, 'trip', 'img_1.jpeg');
  const otherFolder = locate(handle.db, lib, 'elsewhere', 'IMG_1.JPG');
  const ambiguousRaw = locate(handle.db, lib, '', 'b.NEF');
  const ambiguous = [locate(handle.db, lib, '', 'b.jpg'), locate(handle.db, lib, '', 'b.JPG')];
  const trashedRaw = locate(handle.db, lib, '', 'c.ARW', true);
  const besideTrashed = locate(handle.db, lib, '', 'c.jpg');

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(result.applied).toEqual([ID]);
  expect(primaryOf(handle.db, jpeg)).toBe(raw);
  for (const id of [raw, otherFolder, ambiguousRaw, ...ambiguous, trashedRaw, besideTrashed]) {
    expect(primaryOf(handle.db, id)).toBeNull();
  }
});

test('the count and histogram indexes carry the pointer, so the fold stays index-only', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  for (const index of ['assets_live', 'assets_live_captured_ym']) {
    const columns = handle.db
      .query<{ name: string }, []>(`PRAGMA index_info(${index})`)
      .all()
      .map((row) => row.name);
    expect(columns).toContain('hidden');
    expect(columns.at(-1)).toBe('stack_primary_id');
  }
});
