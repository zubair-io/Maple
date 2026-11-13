/**
 * Repair coalescing onto an already-catalogued sibling copy (#5155): the
 * sibling's cloud-backup history follows the ordinal that survives.
 */
import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { appendBackupLocation, insertBackupAsset } from './backup.repo.ts';

const MISSING = 'album/photo.HEIC';
const SIBLING = 'album/photo-1.HEIC';

async function seedMissingWithSibling(db: Database) {
  const lib = new ObjectId(insertFolder(db, {}));
  const sql = testSqliteDb(db);
  const link = {
    device_id: 'd',
    phasset_local_id: 'P1',
    first_seen: new Date('2026-05-10T00:00:00.000Z'),
  };
  const id = await insertBackupAsset(
    { relPath: MISSING, libraryId: lib, totalBytes: 1, mapleId: 'm', isScreenshot: false, link },
    sql,
  );
  await appendBackupLocation(id, { relPath: SIBLING, libraryId: lib, link: null }, sql);
  db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z' WHERE ordinal = 0`);
  db.run(
    `INSERT INTO backup_destinations(id,library_id,kind,name,enabled,created_at)
     VALUES('dest',?,'google-drive','Drive',1,'2026-10-04')`,
    [lib.toHexString()],
  );
  return { id: id.toHexString(), lib, sql };
}

function entry(db: Database, id: string, assetId: string, ordinal: number, path: string) {
  db.run(
    `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,sequence,verified_sequence,
       snapshot_hash,manifest,source_path)
     VALUES(?,'dest',?,?,3,3,'hash','{}',?)`,
    [id, assetId, ordinal, path],
  );
}

function entries(db: Database) {
  return db
    .query(
      `SELECT id, ordinal, source_path, sequence, snapshot_hash FROM backup_entries ORDER BY id`,
    )
    .all();
}

describe('repair coalescing onto a catalogued sibling', () => {
  test("the sibling's backup history moves onto the surviving ordinal", async () => {
    using handle = await createTestDatabase();
    const { id, lib, sql } = await seedMissingWithSibling(handle.db);
    entry(handle.db, 'sibling-entry', id, 1, SIBLING);

    await appendBackupLocation(
      new ObjectId(id),
      { relPath: SIBLING, libraryId: lib, link: null, replacedRelPath: MISSING },
      sql,
    );

    expect(
      handle.db.query(`SELECT ordinal, filename FROM asset_locations WHERE asset_id = ?`).all(id),
    ).toEqual([{ ordinal: 0, filename: 'photo-1.HEIC' }]);
    expect(entries(handle.db)).toEqual([
      { id: 'sibling-entry', ordinal: 0, source_path: SIBLING, sequence: 5, snapshot_hash: null },
    ]);
  });

  test("an overlapping entry of the surviving ordinal keeps its place and the sibling's stays put", async () => {
    using handle = await createTestDatabase();
    const { id, lib, sql } = await seedMissingWithSibling(handle.db);
    entry(handle.db, 'kept-entry', id, 0, MISSING);
    entry(handle.db, 'sibling-entry', id, 1, SIBLING);

    await appendBackupLocation(
      new ObjectId(id),
      { relPath: SIBLING, libraryId: lib, link: null, replacedRelPath: MISSING },
      sql,
    );

    expect(entries(handle.db)).toEqual([
      { id: 'kept-entry', ordinal: 0, source_path: MISSING, sequence: 4, snapshot_hash: null },
      { id: 'sibling-entry', ordinal: 1, source_path: SIBLING, sequence: 3, snapshot_hash: 'hash' },
    ]);
  });

  test('the overlap skip is per destination', async () => {
    using handle = await createTestDatabase();
    const { id, lib, sql } = await seedMissingWithSibling(handle.db);
    handle.db.run(
      `INSERT INTO backup_destinations(id,library_id,kind,name,enabled,created_at)
       VALUES('dest2',?,'google-drive','Drive 2',1,'2026-10-04')`,
      [lib.toHexString()],
    );
    entry(handle.db, 'kept-entry', id, 0, MISSING);
    entry(handle.db, 'sibling-entry', id, 1, SIBLING);
    handle.db.run(
      `INSERT INTO backup_entries(id,destination_id,asset_id,ordinal,source_path)
       VALUES('sibling-entry-2','dest2',?,1,?)`,
      [id, SIBLING],
    );

    await appendBackupLocation(
      new ObjectId(id),
      { relPath: SIBLING, libraryId: lib, link: null, replacedRelPath: MISSING },
      sql,
    );

    const ordinals = handle.db.query(`SELECT id, ordinal FROM backup_entries ORDER BY id`).all();
    expect(ordinals).toEqual([
      { id: 'kept-entry', ordinal: 0 },
      { id: 'sibling-entry', ordinal: 1 },
      { id: 'sibling-entry-2', ordinal: 0 },
    ]);
  });
});
