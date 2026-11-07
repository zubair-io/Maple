import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createBlankTestDatabase,
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { runMigrations } from '../db/sqlite/migrate.ts';
import { ALL_MIGRATIONS } from '../db/sqlite/migrations/index.ts';
import { destinationStatus, type DestinationStatus } from './destination-status.ts';
import { recountedCovered, recountedStatus } from './destination-status-legacy.test-helpers.ts';
import { removedDestinationStatements } from './destination-removal.ts';
import { BackupRepository } from './repository.ts';

type Kind = 'google-drive' | 'folder';
interface Destination {
  id: string;
  kind: Kind;
  libraryId: string;
}

async function expectInSync(db: Database, destination: Destination): Promise<DestinationStatus> {
  const status = await destinationStatus(testSqliteDb(db), destination);
  expect(status).toEqual(recountedStatus(db, destination));
  expect(
    db
      .query(`SELECT covered FROM backup_entry_counts WHERE destination_id=?`)
      .get(destination.id) ?? { covered: 0 },
  ).toEqual({ covered: recountedCovered(db, destination) });
  return status;
}

function manifest(...sizes: number[]): string {
  return JSON.stringify({
    files: sizes.map((size, i) => ({ path: `f${i}`, role: 'original', object: { size } })),
  });
}

function insertDestination(db: Database, libraryId: string, kind: Kind): Destination {
  const id = crypto.randomUUID();
  run(
    db,
    `INSERT INTO backup_destinations(id,library_id,kind,name,path,created_at) VALUES(?,?,?,?,?,?)`,
    id,
    libraryId,
    kind,
    kind,
    kind === 'folder' ? `/mirror/${id}` : null,
    new Date().toISOString(),
  );
  return { id, kind, libraryId };
}

function insertEntry(db: Database, destination: Destination, assetId: string, ordinal = 0): string {
  const id = crypto.randomUUID();
  run(
    db,
    `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,source_path) VALUES(?,?,?,?,?)`,
    id,
    destination.id,
    assetId,
    ordinal,
    `${assetId}.dng`,
  );
  return id;
}

function verify(db: Database, entryId: string, sizes: number[]): void {
  run(
    db,
    `UPDATE backup_entries SET manifest=?,verified_sequence=sequence,attempts=0,last_error=NULL,
      error_kind=NULL,lease_owner=NULL,lease_until=0 WHERE id=?`,
    manifest(...sizes),
    entryId,
  );
}

function fail(db: Database, entryId: string, message: string, retryAt: number): void {
  run(
    db,
    `UPDATE backup_entries SET attempts=attempts+1,retry_at=?,last_error=?,lease_owner=NULL,lease_until=0
      WHERE id=?`,
    retryAt,
    message,
    entryId,
  );
}

function library(db: Database, count: number) {
  const libraryId = insertFolder(db);
  const assets = Array.from({ length: count }, () => insertAsset(db));
  assets.forEach((assetId) => insertLocation(db, { assetId, libraryId }));
  return { libraryId, assets };
}

test('counters follow entries from first insert through verify, edit, error and retry', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 4);
  const drive = insertDestination(db, libraryId, 'google-drive');
  const folder = insertDestination(db, libraryId, 'folder');

  expect(await expectInSync(db, drive)).toMatchObject({ pending: 4, verified: 0, bytes: 0 });
  const entries = assets.map((assetId) => insertEntry(db, drive, assetId));
  const mirrored = assets.map((assetId) => insertEntry(db, folder, assetId));
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 4, verified: 0 });
  expect(await expectInSync(db, folder)).toMatchObject({ pending: 4, verified: 0 });

  verify(db, entries[0]!, [100, 20]);
  verify(db, entries[1]!, [300]);
  verify(db, mirrored[0]!, [7]);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2, verified: 2, bytes: 420 });
  expect(await expectInSync(db, folder)).toMatchObject({ pending: 3, verified: 1, bytes: 7 });

  run(db, `UPDATE assets SET mtime=mtime+1 WHERE id=?`, assets[0]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 3, verified: 1, bytes: 420 });
  verify(db, entries[0]!, [150]);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2, verified: 2, bytes: 450 });
  run(db, `UPDATE backup_entries SET manifest=NULL WHERE id=?`, entries[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ bytes: 150 });
  run(db, `UPDATE backup_entries SET manifest='not json' WHERE id=?`, entries[1]!);
  expect(await destinationStatus(testSqliteDb(db), drive)).toMatchObject({ bytes: 150 });
  verify(db, entries[1]!, [300]);

  fail(db, entries[2]!, 'Quota exceeded', 10);
  fail(db, entries[3]!, 'Quota exceeded', 20);
  fail(db, mirrored[1]!, 'Disk full', 5);
  expect(await expectInSync(db, drive)).toMatchObject({
    blocked: 2,
    lastError: 'Quota exceeded',
    lastErrorCount: 2,
  });
  fail(db, entries[3]!, 'Timed out', 30);
  expect(await expectInSync(db, drive)).toMatchObject({
    blocked: 2,
    lastError: 'Timed out',
    lastErrorCount: 1,
  });
  fail(db, entries[2]!, 'Quota exceeded', 40);
  expect(await expectInSync(db, drive)).toMatchObject({ lastError: 'Quota exceeded' });
  expect(await expectInSync(db, folder)).toMatchObject({ blocked: 1, lastError: 'Disk full' });

  run(
    db,
    `UPDATE backup_entries SET retry_at=0,attempts=0,last_error=NULL,error_kind=NULL WHERE destination_id=?`,
    drive.id,
  );
  expect(await expectInSync(db, drive)).toMatchObject({
    blocked: 0,
    lastError: null,
    lastErrorCount: 0,
  });
  expect(
    db.query(`SELECT COUNT(*) AS n FROM backup_entry_errors WHERE destination_id=?`).get(drive.id),
  ).toEqual({ n: 0 });
  expect(await expectInSync(db, folder)).toMatchObject({ blocked: 1 });
});

test('coverage follows trash, purge, missing, reaped, deleted and merged locations', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 6);
  const other = insertFolder(db);
  const drive = insertDestination(db, libraryId, 'google-drive');
  const entries = assets.map((assetId) => insertEntry(db, drive, assetId));
  entries.forEach((entryId, i) => verify(db, entryId, [i + 1]));
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 0, verified: 6, bytes: 21 });

  run(db, `UPDATE backup_entries SET state='trash',sequence=sequence+1 WHERE id=?`, entries[0]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1, trash: 1 });
  verify(db, entries[0]!, [1]);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 0, trash: 1, verified: 6 });
  run(db, `UPDATE backup_entries SET state='purged',sequence=sequence+1 WHERE id=?`, entries[0]!);
  run(
    db,
    `INSERT INTO backup_purges(destination_id,entry_id,record) VALUES(?,?,'{}')`,
    drive.id,
    entries[0]!,
  );
  expect(await expectInSync(db, drive)).toMatchObject({ trash: 0, verified: 5, purgePending: 1 });
  run(db, `UPDATE backup_purges SET completed=1 WHERE entry_id=?`, entries[0]!);
  expect(await expectInSync(db, drive)).toMatchObject({ purgePending: 0 });

  run(db, `UPDATE asset_locations SET missing_since='2026-11-01' WHERE asset_id=?`, assets[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ missing: 1 });
  run(db, `UPDATE asset_locations SET missing_since=NULL WHERE asset_id=?`, assets[1]!);
  run(db, `UPDATE asset_locations SET deleted_at='2026-11-01' WHERE asset_id=?`, assets[2]!);
  run(db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, assets[3]!);
  expect(await expectInSync(db, drive)).toMatchObject({ missing: 1 });
  run(db, `UPDATE assets SET deleted_reason=NULL WHERE id=?`, assets[3]!);
  expect(await expectInSync(db, drive)).toMatchObject({ missing: 0 });

  run(db, `UPDATE asset_locations SET library_id=? WHERE asset_id=?`, other, assets[4]!);
  await expectInSync(db, drive);
  run(db, `UPDATE asset_locations SET library_id=? WHERE asset_id=?`, libraryId, assets[4]!);
  run(db, `UPDATE asset_locations SET ordinal=1 WHERE asset_id=?`, assets[5]!);
  await expectInSync(db, drive);
  run(db, `UPDATE backup_entries SET ordinal=1 WHERE id=?`, entries[5]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2 });

  const survivor = insertAsset(db);
  insertLocation(db, { assetId: survivor, libraryId, filename: 'survivor.dng' });
  run(db, `UPDATE asset_locations SET asset_id=?,ordinal=1 WHERE asset_id=?`, survivor, assets[4]!);
  run(db, `UPDATE backup_entries SET asset_id=?,ordinal=1 WHERE asset_id=?`, survivor, assets[4]!);
  await expectInSync(db, drive);

  run(db, `DELETE FROM assets WHERE id=?`, assets[1]!);
  await expectInSync(db, drive);
  insertLocation(db, { assetId: assets[2]!, libraryId, ordinal: 1, filename: 'restored.dng' });
  run(db, `UPDATE backup_entries SET ordinal=1 WHERE id=?`, entries[2]!);
  await expectInSync(db, drive);
  run(db, `DELETE FROM asset_locations WHERE asset_id=? AND ordinal=1`, assets[2]!);
  await expectInSync(db, drive);

  const vanished = insertAsset(db);
  insertLocation(db, { assetId: vanished, libraryId, missingSince: '2026-11-01' });
  const stray = insertEntry(db, drive, vanished);
  verify(db, stray, [9]);
  await expectInSync(db, drive);
  expect(db.query(`SELECT location_live FROM backup_entries WHERE id=?`).get(stray)).toEqual({
    location_live: 0,
  });

  run(
    db,
    `INSERT INTO backup_lifecycle(id,asset_id,library_id,kind,phase,created_at) VALUES('p',?,?,'trash','prepared',?)`,
    assets[3]!,
    libraryId,
    new Date().toISOString(),
  );
  expect(await expectInSync(db, drive)).toMatchObject({ prepared: 1, lastErrorCount: 1 });
});

test('coverage follows a location set replaced in place, a reaped purged entry and a same-ordinal rekey', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 3);
  const drive = insertDestination(db, libraryId, 'google-drive');
  const entries = assets.map((assetId) => insertEntry(db, drive, assetId));
  verify(db, entries[0]!, [1]);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2 });

  run(db, `DELETE FROM asset_locations WHERE asset_id=?`, assets[0]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2 });
  insertLocation(db, { assetId: assets[0]!, libraryId, filename: 'moved.dng' });
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2 });

  run(db, `UPDATE backup_entries SET state='purged',sequence=sequence+1 WHERE id=?`, entries[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1 });
  run(db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, assets[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1, missing: 1 });
  run(db, `UPDATE assets SET deleted_reason=NULL WHERE id=?`, assets[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1, missing: 0 });

  const survivor = insertAsset(db);
  run(db, `UPDATE backup_entries SET asset_id=? WHERE id=?`, survivor, entries[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2 });
  run(db, `UPDATE asset_locations SET asset_id=? WHERE asset_id=?`, survivor, assets[1]!);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1 });

  db.run('PRAGMA foreign_keys = OFF');
  run(db, `DELETE FROM assets WHERE id=?`, assets[0]!);
  db.run('PRAGMA foreign_keys = ON');
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1 });
});

test('deleting entries of a destination that remains subtracts their counts and errors', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 2);
  const folder = insertDestination(db, libraryId, 'folder');
  verify(db, insertEntry(db, folder, assets[0]!), [5]);
  fail(db, insertEntry(db, folder, assets[1]!), 'Disk full', 1);
  expect(await expectInSync(db, folder)).toMatchObject({ verified: 1, blocked: 1, bytes: 5 });
  run(db, `DELETE FROM backup_entries WHERE destination_id=?`, folder.id);
  expect(await expectInSync(db, folder)).toMatchObject({
    pending: 0,
    verified: 0,
    blocked: 0,
    bytes: 0,
    lastError: null,
  });
  expect(db.query(`SELECT COUNT(*) AS n FROM backup_entry_errors`).get()).toEqual({ n: 0 });
});

test('repository writers keep the counters in step through claim, fail, retry and finish', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 2);
  const drive = insertDestination(db, libraryId, 'google-drive');
  run(db, `UPDATE backup_destinations SET enabled=1,root_id='root' WHERE id=?`, drive.id);
  const repo = new BackupRepository(testSqliteDb(db));
  const destination = (await repo.destination(drive.id))!;
  const entry = await repo.ensureEntry(drive.id, assets[0]!, 0, 'a.dng');
  await repo.ensureEntry(drive.id, assets[0]!, 0, 'a.dng');
  await repo.ensureEntry(drive.id, assets[1]!, 0, 'b.dng');
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 2, verified: 0 });

  expect(await repo.claim(entry, 'worker')).toBe(true);
  await repo.fail(entry, 'worker', 'Drive quota exceeded');
  expect(await expectInSync(db, drive)).toMatchObject({
    blocked: 1,
    lastError: 'Drive quota exceeded',
    lastErrorCount: 1,
  });
  await repo.retry(drive.id);
  expect(await expectInSync(db, drive)).toMatchObject({ blocked: 0, lastError: null });

  const fresh = (await repo.entries(drive.id, assets[0]!))[0]!;
  expect(await repo.claim(fresh, 'worker')).toBe(true);
  expect(
    await repo.finish(fresh, destination, 'worker', {
      version: 1,
      libraryId,
      entryId: fresh.id,
      assetId: assets[0]!,
      sequence: fresh.sequence,
      state: 'active',
      originalPath: 'a.dng',
      currentPath: 'a.dng',
      deletedAt: null,
      hidden: false,
      files: [{ path: 'a.dng', role: 'original', object: { size: 1234 } as never }],
    }),
  ).toBe(true);
  expect(await expectInSync(db, drive)).toMatchObject({ pending: 1, verified: 1, bytes: 1234 });
});

test('destination removal drops its counters and leaves other destinations alone', async () => {
  using handle = await createTestDatabase();
  const { db } = handle;
  const { libraryId, assets } = library(db, 2);
  const drive = insertDestination(db, libraryId, 'google-drive');
  const folder = insertDestination(db, libraryId, 'folder');
  assets.forEach((assetId) => {
    fail(db, insertEntry(db, drive, assetId), 'Offline', 1);
    verify(db, insertEntry(db, folder, assetId), [5]);
  });
  await testSqliteDb(db).transaction([
    { sql: `DELETE FROM backup_destinations WHERE id=?`, params: [drive.id] },
    ...removedDestinationStatements(drive.id),
  ]);
  expect(
    db
      .query(
        `SELECT destination_id FROM backup_entry_counts UNION ALL SELECT destination_id FROM backup_entry_errors`,
      )
      .all(),
  ).toEqual([{ destination_id: folder.id }]);
  expect(await expectInSync(db, folder)).toMatchObject({ verified: 2, bytes: 10 });
});

test('0040 backfills counters from existing entries', async () => {
  using handle = createBlankTestDatabase('file');
  const { db } = handle;
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id < '0040-backup-destination-counts'),
  );
  const { libraryId, assets } = library(db, 5);
  const drive = insertDestination(db, libraryId, 'google-drive');
  const folder = insertDestination(db, libraryId, 'folder');
  const entries = assets.map((assetId) => insertEntry(db, drive, assetId));
  assets.slice(0, 3).forEach((assetId) => insertEntry(db, folder, assetId));
  verify(db, entries[0]!, [10, 2]);
  verify(db, entries[1]!, [30]);
  fail(db, entries[2]!, 'Quota exceeded', 1);
  run(db, `UPDATE backup_entries SET state='trash' WHERE id=?`, entries[1]!);
  run(db, `UPDATE backup_entries SET state='purged' WHERE id=?`, entries[3]!);
  run(db, `UPDATE asset_locations SET missing_since='2026-11-01' WHERE asset_id=?`, assets[0]!);
  run(db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, assets[4]!);
  const before = [recountedStatus(db, drive), recountedStatus(db, folder)];

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toContain('0040-backup-destination-counts');
  expect(await expectInSync(db, drive)).toEqual(before[0]!);
  expect(await expectInSync(db, folder)).toEqual(before[1]!);
  expect(before[0]).toMatchObject({ verified: 2, trash: 1, blocked: 1, bytes: 42, missing: 2 });

  run(db, `UPDATE asset_locations SET missing_since=NULL WHERE asset_id=?`, assets[0]!);
  verify(db, entries[4]!, [1]);
  run(db, `UPDATE assets SET deleted_reason=NULL WHERE id=?`, assets[4]!);
  await expectInSync(db, drive);
});
