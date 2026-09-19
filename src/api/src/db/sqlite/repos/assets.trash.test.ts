/**
 * Trash, purge and restore.
 *
 * The cases that matter are the multi-location ones: trash moves one location
 * and must leave the others exactly where they were, and restore has to clear
 * the destination before it can claim it, because two assets cannot name the
 * same file.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from '../../object-id.ts';
import { hardDelete, markSoftDeleted, restoreFromTrash } from './assets.trash.ts';
import {
  insertDetail,
  insertFaceRow,
  insertPersonRow,
  insertPhassetLink,
  insertStageState,
  stageState,
} from './assets.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  liveLocationCount,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { Database } from 'bun:sqlite';

const oid = (hex: string): ObjectId => new ObjectId(hex);
const ROOT = '/libraries/main';

interface LocationSnapshot {
  ordinal: number;
  library_id: string;
  path: string;
  filename: string;
  deleted_at: string | null;
  missing_since: string | null;
  keep: number;
}

function locations(db: Database, assetId: string): LocationSnapshot[] {
  return db
    .query(
      `SELECT ordinal, library_id, path, filename, deleted_at, missing_since, keep
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(assetId) as LocationSnapshot[];
}

function asset(
  db: Database,
  assetId: string,
): { deleted_at: string | null; original_path: string | null; size: number; mtime: number } {
  return db
    .query(`SELECT deleted_at, original_path, size, mtime FROM assets WHERE id = ?`)
    .get(assetId) as {
    deleted_at: string | null;
    original_path: string | null;
    size: number;
    mtime: number;
  };
}

/** An asset with two locations in one library, and seeded stage bookkeeping. */
function seedTwoLocationAsset(db: Database): { assetId: string; libraryId: string } {
  const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId, ordinal: 0, path: 'photos', filename: 'IMG_1.dng' });
  insertLocation(db, { assetId, libraryId, ordinal: 1, path: 'backup', filename: 'IMG_1.dng' });
  for (const stage of ['meili', 'thumb', 'preview']) {
    insertStageState(db, assetId, stage, {
      version: 7,
      attempts: 3,
      dead: true,
      processedAt: '2026-01-01T00:00:00Z',
    });
  }
  return { assetId, libraryId };
}

describe('markSoftDeleted', () => {
  test('repoints only the moved entry and leaves the others alone', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { assetId, libraryId } = seedTwoLocationAsset(db);

    const result = await markSoftDeleted({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/.maple/trash/IMG_1.dng`,
      originalAbsPath: `${ROOT}/photos/IMG_1.dng`,
      source: { libraryId: oid(libraryId), path: 'photos', filename: 'IMG_1.dng' },
      dbOverride: testSqliteDb(db),
    });

    expect(result.matchedCount).toBe(1);
    const rows = locations(db, assetId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: '.maple/trash', filename: 'IMG_1.dng', ordinal: 0 });
    expect(rows[1]).toMatchObject({ path: 'backup', filename: 'IMG_1.dng', ordinal: 1 });

    const row = asset(db, assetId);
    expect(row.deleted_at).not.toBeNull();
    expect(row.original_path).toBe(`${ROOT}/photos/IMG_1.dng`);
    // The rewritten entry is still live per-entry — only the asset is trashed.
    expect(liveLocationCount(db, assetId)).toBe(2);
  });

  test('re-arms the search stage and both path-keyed caches', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { assetId, libraryId } = seedTwoLocationAsset(db);

    await markSoftDeleted({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/.maple/trash/IMG_1.dng`,
      originalAbsPath: `${ROOT}/photos/IMG_1.dng`,
      source: { libraryId: oid(libraryId), path: 'photos', filename: 'IMG_1.dng' },
      dbOverride: testSqliteDb(db),
    });

    // The meili re-arm clears `processed_at`; the cache re-arm deliberately
    // does not — the asymmetry is inherited from the Mongo fragments.
    expect(stageState(db, assetId, 'meili')).toEqual({
      version: 0,
      attempts: 0,
      dead: 0,
      processed_at: null,
    });
    for (const stage of ['thumb', 'preview']) {
      expect(stageState(db, assetId, stage)).toEqual({
        version: 0,
        attempts: 0,
        dead: 0,
        processed_at: '2026-01-01T00:00:00Z',
      });
    }
  });

  test('without a source it falls back to replacing the whole location set', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { assetId, libraryId } = seedTwoLocationAsset(db);

    await markSoftDeleted({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/.maple/trash/only.dng`,
      originalAbsPath: `${ROOT}/photos/IMG_1.dng`,
      dbOverride: testSqliteDb(db),
    });

    expect(locations(db, assetId)).toEqual([
      {
        ordinal: 0,
        library_id: libraryId,
        path: '.maple/trash',
        filename: 'only.dng',
        deleted_at: null,
        missing_since: null,
        keep: 0,
      },
    ]);
  });

  test('clears the non-live tags on the entry it rewrites', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });
    const assetId = insertAsset(db);
    insertLocation(db, {
      assetId,
      libraryId,
      path: 'photos',
      filename: 'IMG_1.dng',
      missingSince: '2026-02-01T00:00:00Z',
    });
    run(
      db,
      `UPDATE asset_locations SET keep = 1, missing_reason = 'watch-removed' WHERE asset_id = ?`,
      assetId,
    );

    await markSoftDeleted({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/.maple/trash/IMG_1.dng`,
      originalAbsPath: `${ROOT}/photos/IMG_1.dng`,
      source: { libraryId: oid(libraryId), path: 'photos', filename: 'IMG_1.dng' },
      dbOverride: testSqliteDb(db),
    });

    expect(locations(db, assetId)[0]).toMatchObject({
      path: '.maple/trash',
      missing_since: null,
      keep: 0,
    });
  });

  test('refuses a destination outside the library root', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { assetId, libraryId } = seedTwoLocationAsset(db);
    await expect(
      markSoftDeleted({
        id: oid(assetId),
        libraryRoot: ROOT,
        libraryId: oid(libraryId),
        newAbsPath: '/elsewhere/IMG_1.dng',
        originalAbsPath: `${ROOT}/photos/IMG_1.dng`,
        dbOverride: testSqliteDb(db),
      }),
    ).rejects.toThrow(/outside libraryRoot/);
  });

  test('is a no-op for an unknown asset rather than a constraint failure', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });

    const result = await markSoftDeleted({
      id: new ObjectId(),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/.maple/trash/ghost.dng`,
      originalAbsPath: `${ROOT}/photos/ghost.dng`,
      dbOverride: testSqliteDb(db),
    });
    expect(result.matchedCount).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM asset_locations`).get()).toEqual({ n: 0 });
  });
});

describe('hardDelete', () => {
  test('drops the asset and everything that hangs off it', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const { assetId } = seedTwoLocationAsset(db);
    insertDetail(db, assetId, { description: 'gone soon' });
    insertFaceRow(db, { assetId, personId: insertPersonRow(db, 'Ada') });
    insertPhassetLink(db, { assetId, deviceId: 'device-a', phassetLocalId: 'local-1' });
    run(db, `INSERT INTO asset_search (asset_id, search_blob) VALUES (?, 'gone soon')`, assetId);

    const result = await hardDelete(oid(assetId), testSqliteDb(db));
    expect(result).toEqual({ acknowledged: true, deletedCount: 1 });

    for (const table of [
      'asset_locations',
      'asset_detail',
      'faces',
      'asset_phasset_links',
      'asset_search',
      'stage_state',
    ]) {
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  test('reports zero deleted for an unknown id', async () => {
    using handle = await createTestDatabase();
    const result = await hardDelete(new ObjectId(), testSqliteDb(handle.db));
    expect(result.deletedCount).toBe(0);
  });
});

describe('restoreFromTrash', () => {
  test('repoints the entry, clears the trash markers and refreshes the stat', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });
    const assetId = insertAsset(db, { deletedAt: '2026-04-01T00:00:00Z' });
    insertLocation(db, { assetId, libraryId, path: '.maple/trash', filename: 'IMG_1.dng' });
    run(
      db,
      `UPDATE assets SET original_path = ? WHERE id = ?`,
      `${ROOT}/photos/IMG_1.dng`,
      assetId,
    );
    for (const stage of ['meili', 'thumb', 'preview'])
      insertStageState(db, assetId, stage, { version: 9 });

    const result = await restoreFromTrash({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/photos/IMG_1.dng`,
      size: 4096,
      mtimeMs: 1_700_000_000_000,
      source: { libraryId: oid(libraryId), path: '.maple/trash', filename: 'IMG_1.dng' },
      dbOverride: testSqliteDb(db),
    });

    expect(result.matchedCount).toBe(1);
    expect(asset(db, assetId)).toEqual({
      deleted_at: null,
      original_path: null,
      size: 4096,
      mtime: 1_700_000_000_000,
    });
    expect(locations(db, assetId)[0]).toMatchObject({ path: 'photos', filename: 'IMG_1.dng' });
    expect(stageState(db, assetId, 'meili')?.version).toBe(0);
    expect(stageState(db, assetId, 'thumb')?.version).toBe(0);
  });

  test('removes the transient row the watcher may have inserted at the destination', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });
    const assetId = insertAsset(db, { deletedAt: '2026-04-01T00:00:00Z' });
    insertLocation(db, { assetId, libraryId, path: '.maple/trash', filename: 'IMG_1.dng' });
    // The discover watcher saw the file land back and indexed it as a new asset.
    const transientId = insertAsset(db);
    insertLocation(db, { assetId: transientId, libraryId, path: 'photos', filename: 'IMG_1.dng' });

    await restoreFromTrash({
      id: oid(assetId),
      libraryRoot: ROOT,
      libraryId: oid(libraryId),
      newAbsPath: `${ROOT}/photos/IMG_1.dng`,
      size: 4096,
      mtimeMs: 1_700_000_000_000,
      source: { libraryId: oid(libraryId), path: '.maple/trash', filename: 'IMG_1.dng' },
      dbOverride: testSqliteDb(db),
    });

    expect(db.query(`SELECT COUNT(*) AS n FROM assets WHERE id = ?`).get(transientId)).toEqual({
      n: 0,
    });
    expect(locations(db, assetId)[0]).toMatchObject({ path: 'photos', filename: 'IMG_1.dng' });
  });

  test('refuses a destination outside the library root', async () => {
    using handle = await createTestDatabase();
    const { db } = handle;
    const libraryId = insertFolder(db, { path: ROOT, slug: 'main' });
    const assetId = insertAsset(db);
    await expect(
      restoreFromTrash({
        id: oid(assetId),
        libraryRoot: ROOT,
        libraryId: oid(libraryId),
        newAbsPath: '/elsewhere/IMG_1.dng',
        size: 1,
        mtimeMs: 1,
        dbOverride: testSqliteDb(db),
      }),
    ).rejects.toThrow(/outside libraryRoot/);
  });
});
