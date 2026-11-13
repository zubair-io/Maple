/**
 * Where a PhotoKit backup records the Apple companions beside an original: the
 * slot is written on the asset in the library the companion was uploaded to,
 * and a fill never replaces a companion recorded since.
 */

import { expect, test, describe } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import {
  createTestDatabase,
  insertFolder,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { insertBackupAsset } from './backup.repo.ts';
import { fillAppleCompanionPath, setAppleCompanionPath } from './backup-companions.repo.ts';
import type { SqliteDb } from './db-handle.ts';

function library(db: Database, path?: string): ObjectId {
  return new ObjectId(insertFolder(db, path === undefined ? {} : { path }));
}

function assetRow(db: Database, mapleId: string) {
  return db
    .query(`SELECT apple_rendered_path, apple_live_video_path FROM assets WHERE maple_id = ?`)
    .get(mapleId) as { apple_rendered_path: string | null; apple_live_video_path: string | null };
}

async function seedUpload(db: SqliteDb, lib: ObjectId): Promise<ObjectId> {
  return await insertBackupAsset(
    {
      relPath: '2024/Tokyo/IMG_0001.HEIC',
      libraryId: lib,
      totalBytes: 1234,
      mapleId: 'content-1',
      isScreenshot: false,
      link: {
        device_id: 'device-A',
        phasset_local_id: 'P1',
        first_seen: new Date('2026-05-10T00:00:00.000Z'),
      },
    },
    db,
  );
}

describe('the Apple-rendered companion pointer', () => {
  test('lands on the asset in the library the companion was uploaded to', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);

    const outcome = await setAppleCompanionPath(
      lib,
      'content-1',
      'apple_rendered_path',
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
    const outcome = await setAppleCompanionPath(
      elsewhere,
      'content-1',
      'apple_rendered_path',
      'x.HEIC',
      db,
    );
    expect(outcome.matchedCount).toBe(0);
    expect(assetRow(handle.db, 'content-1').apple_rendered_path).toBeNull();
  });

  test('filling a slot records an empty one and never replaces a recorded companion', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);

    const filled = await fillAppleCompanionPath(
      lib,
      'content-1',
      'apple_rendered_path',
      'a.JPEG',
      db,
    );
    const kept = await fillAppleCompanionPath(
      lib,
      'content-1',
      'apple_rendered_path',
      'b.JPEG',
      db,
    );

    expect([filled.matchedCount, kept.matchedCount]).toEqual([1, 0]);
    expect(assetRow(handle.db, 'content-1').apple_rendered_path).toBe('a.JPEG');
  });

  test("a Live Photo's .mov lands in its own slot and leaves the rendered edit's alone", async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const lib = library(handle.db);
    await seedUpload(db, lib);
    await setAppleCompanionPath(lib, 'content-1', 'apple_rendered_path', 'IMG.rendered.JPEG', db);
    await setAppleCompanionPath(lib, 'content-1', 'apple_live_video_path', 'IMG.mov', db);
    expect(assetRow(handle.db, 'content-1')).toMatchObject({
      apple_rendered_path: 'IMG.rendered.JPEG',
      apple_live_video_path: 'IMG.mov',
    });
  });
});
