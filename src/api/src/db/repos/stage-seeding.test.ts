import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import { ALL_STAGE_NAMES } from '../../workers/stages/stage-names.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { appendOrRefreshLocation } from './assets.discover.dedup.ts';
import { upsertAssetByMapleId } from './assets.upsert.ts';
import { insertBackupAsset } from './backup.repo.ts';
import { claimStageBatch } from './stage-claim.ts';

function stagesOf(db: Database, assetId: string): string[] {
  return (
    db.query(`SELECT stage FROM stage_state WHERE asset_id = ? ORDER BY stage`).all(assetId) as {
      stage: string;
    }[]
  ).map((row) => row.stage);
}

async function exifClaimIds(db: Database): Promise<string[]> {
  const outcome = await claimStageBatch(
    { stage: 'exif', targetVersion: 1, dependsOn: [], limit: 20, maxAttempts: 5 },
    testSqliteDb(db),
  );
  return outcome.claimed.map((row) => row.asset_id);
}

const EVERY_STAGE = [...ALL_STAGE_NAMES].sort();

describe('assets created outside discover are enrolled in every stage', () => {
  test('a backup-ingested asset gets one row per stage and is claimable by exif', async () => {
    using handle = await createTestDatabase();
    const libraryId = new ObjectId(insertFolder(handle.db));

    const id = await insertBackupAsset(
      {
        relPath: '2024/IMG_0001.HEIC',
        libraryId,
        totalBytes: 10,
        mapleId: 'device-content-1',
        isScreenshot: false,
        link: { device_id: 'dev', phasset_local_id: 'P1', first_seen: new Date(0) },
      },
      testSqliteDb(handle.db),
    );

    expect(stagesOf(handle.db, id.toHexString())).toEqual(EVERY_STAGE);
    expect(await exifClaimIds(handle.db)).toEqual([id.toHexString()]);
  });

  test('a pano-stitched asset gets one row per stage and is claimable by exif', async () => {
    using handle = await createTestDatabase();
    const libraryId = new ObjectId(insertFolder(handle.db));

    const { id } = await upsertAssetByMapleId(
      {
        libraryId,
        relDir: 'pano',
        filename: 'stitch.tif',
        size: 5,
        mtime: 1,
        mapleId: 'pano-id',
        sha1Head: 'c'.repeat(40),
      },
      () => new Date(0),
      testSqliteDb(handle.db),
    );

    expect(stagesOf(handle.db, id.toHexString())).toEqual(EVERY_STAGE);
    expect(await exifClaimIds(handle.db)).toEqual([id.toHexString()]);
  });

  test('re-upserting a pano does not reset a stage that already ran', async () => {
    using handle = await createTestDatabase();
    const libraryId = new ObjectId(insertFolder(handle.db));
    const input = {
      libraryId,
      relDir: 'pano',
      filename: 'stitch.tif',
      size: 5,
      mtime: 1,
      mapleId: 'pano-id',
      sha1Head: 'c'.repeat(40),
    };
    const db = testSqliteDb(handle.db);
    const { id } = await upsertAssetByMapleId(input, () => new Date(0), db);
    handle.db.run(`UPDATE stage_state SET version = 3 WHERE asset_id = ? AND stage = 'exif'`, [
      id.toHexString(),
    ]);

    await upsertAssetByMapleId({ ...input, size: 6 }, () => new Date(0), db);

    const version = handle.db
      .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'exif'`)
      .get(id.toHexString()) as { version: number };
    expect(version.version).toBe(3);
  });

  test('a new location on an asset that was never enrolled enrolls it', async () => {
    using handle = await createTestDatabase();
    const first = insertFolder(handle.db, { slug: 'a', path: '/a' });
    const second = insertFolder(handle.db, { slug: 'b', path: '/b' });
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId: first, path: '', filename: 'p.dng' });
    expect(stagesOf(handle.db, assetId)).toEqual([]);

    const outcome = await appendOrRefreshLocation(
      { id: new ObjectId(assetId), deletedAt: null, locations: [] },
      { library_id: new ObjectId(second), path: '', filename: 'p.dng', keep: false },
      { indexedAt: new Date(0).toISOString(), mtime: 1, size: 1 },
      undefined,
      testSqliteDb(handle.db),
    );

    expect(outcome).toBe('append');
    expect(stagesOf(handle.db, assetId)).toEqual(EVERY_STAGE);
  });
});
