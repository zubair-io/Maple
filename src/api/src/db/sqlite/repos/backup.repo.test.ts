/**
 * The PhotoKit backup routes' reads and writes.
 *
 * The cases that earn their place are the ones the MongoDB shape got wrong or
 * could only express by accident: a device link is one row rather than two
 * dotted paths, so a lookup cannot be satisfied by two different links; a
 * trashed location must read as absent so the photo is re-uploaded rather than
 * silently skipped forever; and `media_kind` has to follow a Live Photo's
 * `.MOV` onto an asset that was an image a moment ago.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../../object-id.ts';
import { createTestDatabase, insertFolder, testSqliteDb } from '../test-sqlite.test-helpers.ts';
import {
  appendBackupLocation,
  findIngestDedupTarget,
  findMapleIdsPresentInLibrary,
  insertBackupAsset,
  linkPhasset,
  listBackupState,
  markDeletedFromPhotos,
  setAppleRenderedPath,
  type PhassetLink,
} from './backup.repo.ts';
import type { SqliteDb } from './db-handle.ts';

const DEVICE = 'device-A';

function library(db: Database, path?: string): ObjectId {
  return new ObjectId(insertFolder(db, path === undefined ? {} : { path }));
}

function link(overrides: Partial<PhassetLink> = {}): PhassetLink {
  return {
    device_id: DEVICE,
    phasset_local_id: 'P1',
    first_seen: new Date('2026-05-10T00:00:00.000Z'),
    ...overrides,
  };
}

/** The one asset row carrying this content id. */
function assetRow(db: Database, mapleId: string) {
  return db.query(`SELECT * FROM assets WHERE maple_id = ?`).get(mapleId) as {
    id: string;
    media_kind: string;
    live_location_count: number;
    is_screenshot: number | null;
    size: number;
    apple_rendered_path: string | null;
    deleted_from_photos: number;
  };
}

function locations(db: Database, id: ObjectId) {
  return db
    .query(
      `SELECT ordinal, path, filename FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id.toHexString()) as { ordinal: number; path: string; filename: string }[];
}

function links(db: Database, id: ObjectId) {
  return db
    .query(`SELECT device_id, phasset_local_id FROM asset_phasset_links WHERE asset_id = ?`)
    .all(id.toHexString()) as { device_id: string; phasset_local_id: string }[];
}

/** One asset with a live location in `lib`, linked to this device. */
async function seedUpload(
  db: SqliteDb,
  lib: ObjectId,
  overrides: { mapleId?: string; relPath?: string; phassetLocalId?: string } = {},
): Promise<ObjectId> {
  return await insertBackupAsset(
    {
      relPath: overrides.relPath ?? '2024/Tokyo/IMG_0001.HEIC',
      libraryId: lib,
      totalBytes: 1234,
      mapleId: overrides.mapleId ?? 'content-1',
      isScreenshot: false,
      link: link({ phasset_local_id: overrides.phassetLocalId ?? 'P1' }),
    },
    db,
  );
}

describe('the first upload of a photo', () => {
  test('creates the asset, its location and the device link in one go', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib);

    const row = assetRow(handle.db, 'content-1');
    expect(row.id).toBe(id.toHexString());
    expect(row.size).toBe(1234);
    expect(row.media_kind).toBe('image');
    expect(row.is_screenshot).toBe(0);
    // Written by the asset_locations trigger, not by the insert.
    expect(row.live_location_count).toBe(1);

    expect(locations(handle.db, id)).toEqual([
      { ordinal: 0, path: '2024/Tokyo', filename: 'IMG_0001.HEIC' },
    ]);
    expect(links(handle.db, id)).toEqual([{ device_id: DEVICE, phasset_local_id: 'P1' }]);
  });

  test('a file at the library root stores an empty directory, not a dot', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib, { relPath: 'loose.heic' });
    expect(locations(handle.db, id)[0]).toEqual({ ordinal: 0, path: '', filename: 'loose.heic' });
  });

  test('a video upload is classified as one', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib, { relPath: '2024/clip.MOV', mapleId: 'content-video' });
    expect(assetRow(handle.db, 'content-video').media_kind).toBe('video');
  });
});

describe('the dedup lookup the ingest route branches on', () => {
  test('reports nothing for content the server has never seen', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    expect(
      await findIngestDedupTarget(
        { mapleId: 'unknown', libraryId: lib, deviceId: DEVICE, phassetLocalId: 'P1' },
        db,
      ),
    ).toBeNull();
  });

  test('hands back where the copy lives when this library already holds it', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib);
    const found = await findIngestDedupTarget(
      { mapleId: 'content-1', libraryId: lib, deviceId: DEVICE, phassetLocalId: 'P1' },
      db,
    );
    expect(found?.id.toHexString()).toBe(id.toHexString());
    expect(found?.liveRelPathInLibrary).toBe('2024/Tokyo/IMG_0001.HEIC');
    expect(found?.alreadyLinked).toBe(true);
  });

  test('finds the asset but no local copy when the content lives in another library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    const here = library(handle.db, '/libraries/here');
    await seedUpload(db, elsewhere);

    const found = await findIngestDedupTarget(
      { mapleId: 'content-1', libraryId: here, deviceId: DEVICE, phassetLocalId: 'P1' },
      db,
    );
    // Not null — this is the branch that materialises a second copy here.
    expect(found).not.toBeNull();
    expect(found?.liveRelPathInLibrary).toBeNull();
  });

  test('a trashed location does not count as a live copy', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib);
    handle.db.run(`UPDATE asset_locations SET deleted_at = ? WHERE asset_id = ?`, [
      '2026-05-12T00:00:00.000Z',
      id.toHexString(),
    ]);
    const found = await findIngestDedupTarget(
      { mapleId: 'content-1', libraryId: lib, deviceId: DEVICE, phassetLocalId: 'P1' },
      db,
    );
    expect(found?.liveRelPathInLibrary).toBeNull();
  });

  test('a link for a different local id on the same device does not count as linked', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib, { phassetLocalId: 'P1' });
    const found = await findIngestDedupTarget(
      { mapleId: 'content-1', libraryId: lib, deviceId: DEVICE, phassetLocalId: 'P2' },
      db,
    );
    expect(found?.alreadyLinked).toBe(false);
  });

  test('a device and a local id must belong to the SAME link row', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib, { phassetLocalId: 'id1' });
    await linkPhasset(id, link({ device_id: 'device-B', phasset_local_id: 'id2' }), db);

    // On Mongo this pairing matched, because the two dotted paths could be
    // satisfied by different array entries. Here they are columns of one row.
    const found = await findIngestDedupTarget(
      { mapleId: 'content-1', libraryId: lib, deviceId: DEVICE, phassetLocalId: 'id2' },
      db,
    );
    expect(found?.alreadyLinked).toBe(false);
  });
});

describe('linking a device to content it did not upload', () => {
  test('is idempotent, so a client retry cannot accumulate duplicates', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib);
    await linkPhasset(id, link({ device_id: 'device-B', phasset_local_id: 'P9' }), db);
    await linkPhasset(id, link({ device_id: 'device-B', phasset_local_id: 'P9' }), db);
    expect(links(handle.db, id)).toHaveLength(2);
  });
});

describe('materialising a second copy in another library', () => {
  test('appends a location at the next ordinal and records the new device link', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    const here = library(handle.db, '/libraries/here');
    const id = await seedUpload(db, elsewhere);

    await appendBackupLocation(
      id,
      {
        relPath: '2024/Misc/IMG_0001.HEIC',
        libraryId: here,
        link: link({ device_id: 'device-B', phasset_local_id: 'P7' }),
      },
      db,
    );

    expect(locations(handle.db, id)).toEqual([
      { ordinal: 0, path: '2024/Tokyo', filename: 'IMG_0001.HEIC' },
      { ordinal: 1, path: '2024/Misc', filename: 'IMG_0001.HEIC' },
    ]);
    expect(links(handle.db, id)).toHaveLength(2);
    expect(assetRow(handle.db, 'content-1').live_location_count).toBe(2);
  });

  test('a null link appends the location and nothing else', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    const here = library(handle.db, '/libraries/here');
    const id = await seedUpload(db, elsewhere);
    await appendBackupLocation(id, { relPath: 'IMG_0001.HEIC', libraryId: here, link: null }, db);
    expect(links(handle.db, id)).toHaveLength(1);
  });

  test("a Live Photo's .MOV turns a still asset into a video", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const other = library(handle.db, '/libraries/other');
    const id = await seedUpload(db, lib);
    expect(assetRow(handle.db, 'content-1').media_kind).toBe('image');

    await appendBackupLocation(
      id,
      { relPath: '2024/Tokyo/IMG_0001.MOV', libraryId: other, link: null },
      db,
    );
    expect(assetRow(handle.db, 'content-1').media_kind).toBe('video');
  });
});

describe('the batch dedup probe', () => {
  test('answers only for content this library holds live', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    await seedUpload(db, lib, { mapleId: 'here' });
    await seedUpload(db, elsewhere, { mapleId: 'there', relPath: 'b.heic' });
    const trashed = await seedUpload(db, lib, { mapleId: 'trashed', relPath: 'c.heic' });
    handle.db.run(`UPDATE asset_locations SET deleted_at = ? WHERE asset_id = ?`, [
      '2026-05-12T00:00:00.000Z',
      trashed.toHexString(),
    ]);

    const present = await findMapleIdsPresentInLibrary(
      ['here', 'there', 'trashed', 'never-seen'],
      lib,
      db,
    );
    expect([...present]).toEqual(['here']);
  });

  test('an empty request asks the database nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect((await findMapleIdsPresentInLibrary([], library(handle.db), db)).size).toBe(0);
  });
});

describe('the device reconciliation feed', () => {
  test("returns this device's uploads since a cursor, with library-relative paths", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const older = await seedUpload(db, lib, { mapleId: 'old', relPath: 'a.heic' });
    handle.db.run(`UPDATE asset_phasset_links SET first_seen = ? WHERE asset_id = ?`, [
      '2026-05-01T00:00:00.000Z',
      older.toHexString(),
    ]);
    await seedUpload(db, lib, { mapleId: 'new', relPath: 'b.heic', phassetLocalId: 'P2' });

    const all = await listBackupState(lib, DEVICE, new Date(0), db);
    expect(all.map((row) => row.rel_path).sort()).toEqual(['a.heic', 'b.heic']);

    const recent = await listBackupState(lib, DEVICE, new Date('2026-05-05T00:00:00.000Z'), db);
    expect(recent.map((row) => row.maple_id)).toEqual(['new']);
  });

  test("another device's uploads are not this device's business", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);
    expect(await listBackupState(lib, 'device-B', new Date(0), db)).toEqual([]);
  });

  test('an asset with no live location here is left out', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const id = await seedUpload(db, lib);
    handle.db.run(`UPDATE asset_locations SET deleted_at = ? WHERE asset_id = ?`, [
      '2026-05-12T00:00:00.000Z',
      id.toHexString(),
    ]);
    expect(await listBackupState(lib, DEVICE, new Date(0), db)).toEqual([]);
  });
});

describe('a device reporting photos deleted from Apple Photos', () => {
  test('flags the matching assets and counts only the ones it changed', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);

    expect(await markDeletedFromPhotos(lib, DEVICE, ['P1'], db)).toBe(1);
    expect(assetRow(handle.db, 'content-1').deleted_from_photos).toBe(1);
    // Re-reporting the same deletion changes nothing, and says so — which is
    // what `modifiedCount` reported on the Mongo side.
    expect(await markDeletedFromPhotos(lib, DEVICE, ['P1'], db)).toBe(0);
  });

  test('does not reach another library, another device, or an empty list', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    await seedUpload(db, lib);

    expect(await markDeletedFromPhotos(elsewhere, DEVICE, ['P1'], db)).toBe(0);
    expect(await markDeletedFromPhotos(lib, 'device-B', ['P1'], db)).toBe(0);
    expect(await markDeletedFromPhotos(lib, DEVICE, [], db)).toBe(0);
    expect(assetRow(handle.db, 'content-1').deleted_from_photos).toBe(0);
  });
});

describe('the Apple-rendered companion pointer', () => {
  test('lands on the asset in the library the companion was uploaded to', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);

    const outcome = await setAppleRenderedPath(
      lib,
      'content-1',
      '2024/Tokyo/IMG_0001.rendered.HEIC',
      db,
    );
    expect(outcome.matchedCount).toBe(1);
    expect(assetRow(handle.db, 'content-1').apple_rendered_path).toBe(
      '2024/Tokyo/IMG_0001.rendered.HEIC',
    );
  });

  test('matches nothing when the content is not in that library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    const elsewhere = library(handle.db, '/libraries/elsewhere');
    await seedUpload(db, lib);
    expect((await setAppleRenderedPath(elsewhere, 'content-1', 'x.HEIC', db)).matchedCount).toBe(0);
    expect(assetRow(handle.db, 'content-1').apple_rendered_path).toBeNull();
  });
});
