import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import { loadStageDocuments } from '../../repos/stage-documents.repo.ts';

const ID = '0041-drop-vector-fingerprint-index';
const COLUMN = 'semantic_vector_fingerprint';
const INDEX = 'assets_vector_fingerprint';
const FINGERPRINT = 'f'.repeat(64);
const THROUGH_THIS_MIGRATION = ALL_MIGRATIONS.filter((migration) => migration.id <= ID);

async function migratedUpTo40(): Promise<TestDatabase> {
  const handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < ID),
  );
  return handle;
}

function fingerprintedAsset(handle: TestDatabase): string {
  const library = insertFolder(handle.db);
  const asset = insertAsset(handle.db, { exif: JSON.stringify({ iso: 400 }) });
  insertLocation(handle.db, { assetId: asset, libraryId: library, filename: 'IMG_1.dng' });
  handle.db.run(`UPDATE assets SET ${COLUMN} = ?, maple_id = 'abc', rating = 4 WHERE id = ?`, [
    FINGERPRINT,
    asset,
  ]);
  return asset;
}

function indexNames(handle: TestDatabase): string[] {
  return (
    handle.db
      .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assets'`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

test('the index is dropped and every other assets index survives', async () => {
  using handle = await migratedUpTo40();
  fingerprintedAsset(handle);
  const before = indexNames(handle);
  expect(before).toContain(INDEX);
  expect(handle.db.query(`SELECT COUNT(*) AS n FROM assets INDEXED BY ${INDEX}`).get()).toEqual({
    n: 1,
  });

  const result = await runMigrations(handle.migrationDb, THROUGH_THIS_MIGRATION);

  expect(result.applied).toEqual([ID]);
  expect(indexNames(handle)).toEqual(before.filter((name) => name !== INDEX));
  expect(handle.db.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
});

test('the asset row is untouched and still loads as a stage document without the fingerprint', async () => {
  using handle = await migratedUpTo40();
  const asset = fingerprintedAsset(handle);
  const row = () => handle.db.query(`SELECT * FROM assets WHERE id = ?`).get(asset);
  const before = row();

  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  expect(row()).toEqual(before);
  expect(before).toMatchObject({ [COLUMN]: FINGERPRINT });
  const doc = (await loadStageDocuments([asset], testSqliteDb(handle.db))).get(asset)!;
  expect(doc).toMatchObject({ maple_id: 'abc', rating: 4, exif: { iso: 400 } });
  expect(doc.fileinfo?.[0]).toMatchObject({ filename: 'IMG_1.dng' });
  expect(doc).not.toHaveProperty(COLUMN);
});

test('a database that already lost the index migrates cleanly', async () => {
  using handle = await migratedUpTo40();
  handle.db.run(`DROP INDEX ${INDEX}`);

  const result = await runMigrations(handle.migrationDb, THROUGH_THIS_MIGRATION);

  expect(result.applied).toEqual([ID]);
  expect(indexNames(handle)).not.toContain(INDEX);
});
