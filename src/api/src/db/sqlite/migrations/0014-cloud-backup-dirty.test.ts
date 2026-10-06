import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import { appendOrRefreshLocation } from '../../repos/assets.discover.dedup.ts';
import { ObjectId } from '../../object-id.ts';

function seedVerified(handle: TestDatabase, assetId: string, libraryId: string) {
  run(
    handle.db,
    `INSERT INTO backup_destinations(id,library_id,kind,name,enabled,created_at)
    VALUES('drive',?,'google-drive','Drive',1,'2026-10-04')`,
    libraryId,
  );
  run(
    handle.db,
    `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,sequence,
    verified_sequence,snapshot_hash,manifest,source_path)
    VALUES('entry','drive',?,0,7,7,'captured-hash','{}','photo.dng')`,
    assetId,
  );
  run(
    handle.db,
    `INSERT INTO stage_state(asset_id,stage,version,processed_at)
    VALUES(?,'cloud-backup',9,'2026-10-04') ON CONFLICT(asset_id,stage)
    DO UPDATE SET version=9,processed_at='2026-10-04'`,
    assetId,
  );
}

function state(handle: TestDatabase, assetId: string) {
  return {
    entry: handle.db.query('SELECT * FROM backup_entries WHERE asset_id=?').get(assetId),
    stage: handle.db
      .query("SELECT * FROM stage_state WHERE asset_id=? AND stage='cloud-backup'")
      .get(assetId),
  };
}

function expectDirty(handle: TestDatabase, assetId: string) {
  expect(
    handle.db
      .query(
        `SELECT sequence,verified_sequence,snapshot_hash,lease_owner,lease_until,
    retry_at FROM backup_entries WHERE asset_id=?`,
      )
      .get(assetId),
  ).toEqual({
    sequence: 8,
    verified_sequence: 7,
    snapshot_hash: null,
    lease_owner: null,
    lease_until: 0,
    retry_at: 0,
  });
  expect(
    handle.db
      .query(
        `SELECT version,attempts,dead,next_attempt_at FROM stage_state
    WHERE asset_id=? AND stage='cloud-backup'`,
      )
      .get(assetId),
  ).toEqual({
    version: 0,
    attempts: 0,
    dead: 0,
    next_attempt_at: null,
  });
}

test('0014 upgrades an existing SQLite database with guarded backup triggers and preserves completed work on no-ops', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((m) => m.id < '0014-cloud-backup'),
  );
  const assetId = insertAsset(handle.db);
  const libraryId = insertFolder(handle.db);
  insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  expect(
    handle.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'backup_%dirty'").all(),
  ).toEqual([]);
  expect(
    (
      await runMigrations(
        handle.migrationDb,
        ALL_MIGRATIONS.filter((m) => m.id <= '0014-cloud-backup'),
      )
    ).applied,
  ).toEqual(['0014-cloud-backup']);
  seedVerified(handle, assetId, libraryId);
  const before = state(handle, assetId);
  run(
    handle.db,
    `UPDATE assets SET mtime=mtime,size=size,sidecar_ver=sidecar_ver,hidden=hidden,
    apple_rendered_path=apple_rendered_path,original_path=original_path,deleted_at=deleted_at,
    deleted_reason=deleted_reason,indexed_at='2026-10-05' WHERE id=?`,
    assetId,
  );
  run(
    handle.db,
    'UPDATE asset_locations SET path=path,filename=filename,library_id=library_id WHERE asset_id=?',
    assetId,
  );
  expect(state(handle, assetId)).toEqual(before);
  expect(
    (
      await runMigrations(
        handle.migrationDb,
        ALL_MIGRATIONS.filter((m) => m.id <= '0014-cloud-backup'),
      )
    ).applied,
  ).toEqual([]);
  run(handle.db, 'UPDATE assets SET size=size+1 WHERE id=?', assetId);
  expectDirty(handle, assetId);
  expect(handle.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('the real dedup refresh preserves verified backups until indexed byte metadata changes', async () => {
  using handle = await createTestDatabase();
  const assetId = insertAsset(handle.db);
  const libraryId = insertFolder(handle.db);
  insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  seedVerified(handle, assetId, libraryId);
  const location = { library_id: new ObjectId(libraryId), path: '', filename: 'photo.dng' };
  const existing = { id: new ObjectId(assetId), deletedAt: null, locations: [location] };
  const stat = handle.db.query('SELECT mtime,size FROM assets WHERE id=?').get(assetId) as {
    mtime: number;
    size: number;
  };
  const before = state(handle, assetId);
  expect(
    await appendOrRefreshLocation(
      existing,
      { ...location, keep: false },
      {
        ...stat,
        indexedAt: '2026-10-05',
      },
      false,
      testSqliteDb(handle.db),
    ),
  ).toBe('refresh');
  expect(state(handle, assetId)).toEqual(before);
  expect(
    await appendOrRefreshLocation(
      existing,
      { ...location, keep: false },
      {
        ...stat,
        size: stat.size + 1,
        indexedAt: '2026-10-06',
      },
      false,
      testSqliteDb(handle.db),
    ),
  ).toBe('refresh');
  expectDirty(handle, assetId);
});

test.each([
  'mtime=mtime+1',
  'size=size+1',
  'sidecar_ver=sidecar_ver+1',
  'hidden=1',
  "apple_rendered_path='rendered.jpg'",
  "original_path='/library/photo.dng'",
  "deleted_at='2026-10-05'",
  "deleted_reason='reaped'",
])('an actual tracked asset change (%s) invalidates its verified snapshot', async (assignment) => {
  using handle = await createTestDatabase();
  const assetId = insertAsset(handle.db);
  const libraryId = insertFolder(handle.db);
  insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  seedVerified(handle, assetId, libraryId);
  run(handle.db, `UPDATE assets SET ${assignment} WHERE id=?`, assetId);
  expectDirty(handle, assetId);
});

test.each(['path', 'filename', 'library_id'])(
  'an actual location %s change invalidates its verified snapshot',
  async (field) => {
    using handle = await createTestDatabase();
    const assetId = insertAsset(handle.db);
    const libraryId = insertFolder(handle.db);
    insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
    seedVerified(handle, assetId, libraryId);
    const value = field === 'library_id' ? insertFolder(handle.db) : 'changed';
    run(handle.db, `UPDATE asset_locations SET ${field}=? WHERE asset_id=?`, value, assetId);
    expectDirty(handle, assetId);
  },
);

test('nullable companion metadata changes back to null once and repeated null assignments remain clean', async () => {
  using handle = await createTestDatabase();
  const assetId = insertAsset(handle.db);
  const libraryId = insertFolder(handle.db);
  insertLocation(handle.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  run(handle.db, "UPDATE assets SET apple_rendered_path='rendered.jpg' WHERE id=?", assetId);
  seedVerified(handle, assetId, libraryId);
  run(handle.db, 'UPDATE assets SET apple_rendered_path=NULL WHERE id=?', assetId);
  expectDirty(handle, assetId);
  const after = state(handle, assetId);
  run(handle.db, 'UPDATE assets SET apple_rendered_path=NULL WHERE id=?', assetId);
  expect(state(handle, assetId)).toEqual(after);
});
