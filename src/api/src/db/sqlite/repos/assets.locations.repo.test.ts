/**
 * The location-shaped reads: what a file-management orchestrator asks before it
 * moves bytes.
 *
 * Three properties carry the correctness of this module, and each has its own
 * block below. A folder query must not reach a sibling whose name merely starts
 * with the same characters. It must return the entry it matched on, not just the
 * asset, so the caller cannot re-derive a different one. And it must answer per
 * asset exactly once, whatever the shape of that asset's location set.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
  type TestDatabase,
} from '../test-sqlite.test-helpers.ts';
import {
  listLiveAssetLocationsUnderFolder,
  listTrashedAssetLocationsUnderFolder,
  loadAssetLocationView,
  loadAssetLocationViews,
  loadNearbyAssetCandidates,
} from './assets.locations.repo.ts';

const oid = (hex: string): ObjectId => new ObjectId(hex);

function exifAt(iso: string): string {
  return JSON.stringify({ captured_at: iso });
}

/** An asset with one location, the shape most of these tests want. */
function seedAt(
  handle: TestDatabase,
  libraryId: string,
  args: { path: string; filename: string; capturedAt?: string; deletedAt?: string | null },
): string {
  const assetId = insertAsset(handle.db, {
    exif: args.capturedAt === undefined ? null : exifAt(args.capturedAt),
    deletedAt: args.deletedAt ?? null,
  });
  insertLocation(handle.db, {
    assetId,
    libraryId,
    path: args.path,
    filename: args.filename,
  });
  return assetId;
}

describe('loadAssetLocationViews', () => {
  test('returns the fileinfo array and the capture time for each id', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const withExif = seedAt(handle, libraryId, {
      path: '2024/03',
      filename: 'a.dng',
      capturedAt: '2024-03-01T10:00:00.000Z',
    });
    const withoutExif = seedAt(handle, libraryId, { path: '', filename: 'b.dng' });

    const views = await loadAssetLocationViews([oid(withExif), oid(withoutExif)], db);

    expect(views.get(withExif)?.capturedAt).toBe('2024-03-01T10:00:00.000Z');
    expect(views.get(withExif)?.fileinfo).toEqual([
      { path: '2024/03', filename: 'a.dng', library_id: oid(libraryId), deleted_at: null },
    ]);
    expect(views.get(withoutExif)?.capturedAt).toBeNull();
  });

  test('locations come back in array order, with their non-live tags', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, { assetId, libraryId, ordinal: 1, path: 'b', filename: 'x.dng' });
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: 'a',
      filename: 'x.dng',
      missingSince: '2026-01-01T00:00:00.000Z',
    });

    const view = await loadAssetLocationView(oid(assetId), db);

    expect(view?.fileinfo.map((entry) => entry.path)).toEqual(['a', 'b']);
    expect(view?.fileinfo[0]?.missing_since).toBe('2026-01-01T00:00:00.000Z');
    expect(view?.fileinfo[1]?.missing_since).toBeUndefined();
  });

  test('an unknown id is absent rather than empty, and an empty list asks nothing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    expect(await loadAssetLocationView(new ObjectId(), db)).toBeNull();
    expect(await loadAssetLocationViews([], db)).toEqual(new Map());
  });

  test('an asset with no location yet reports an empty array, not absence', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = insertAsset(handle.db);
    expect(await loadAssetLocationView(oid(assetId), db)).toEqual({
      fileinfo: [],
      capturedAt: null,
    });
  });
});

describe('listLiveAssetLocationsUnderFolder', () => {
  test('matches the directory itself and every descendant', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const here = seedAt(handle, libraryId, { path: 'photos', filename: 'here.dng' });
    const deep = seedAt(handle, libraryId, { path: 'photos/2024/03', filename: 'deep.dng' });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'photos', db);

    expect(matches.map((m) => m.filename).sort()).toEqual(['deep.dng', 'here.dng']);
    expect(matches.map((m) => m.assetId.toHexString()).sort()).toEqual([here, deep].sort());
  });

  test('a sibling whose name starts with the same characters is not a descendant', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    seedAt(handle, libraryId, { path: 'photos', filename: 'wanted.dng' });
    seedAt(handle, libraryId, { path: 'photos2', filename: 'unwanted.dng' });
    seedAt(handle, libraryId, { path: 'photos2/inner', filename: 'also-unwanted.dng' });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'photos', db);

    expect(matches.map((m) => m.filename)).toEqual(['wanted.dng']);
  });

  test('a directory containing LIKE metacharacters matches only itself', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    seedAt(handle, libraryId, { path: 'a_b', filename: 'wanted.dng' });
    seedAt(handle, libraryId, { path: 'axb/inner', filename: 'unwanted.dng' });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'a_b', db);

    expect(matches.map((m) => m.filename)).toEqual(['wanted.dng']);
  });

  test('skips a trashed asset, a tombstoned entry and another library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const otherLibrary = insertFolder(handle.db);
    seedAt(handle, libraryId, { path: 'photos', filename: 'live.dng' });
    seedAt(handle, libraryId, {
      path: 'photos',
      filename: 'trashed.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    seedAt(handle, otherLibrary, { path: 'photos', filename: 'elsewhere.dng' });
    const tombstoned = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: tombstoned,
      libraryId,
      path: 'photos',
      filename: 'replaced.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'photos', db);

    expect(matches.map((m) => m.filename)).toEqual(['live.dng']);
  });

  test('an asset with two locations under the folder is reported once, lowest ordinal first', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: 'photos/b',
      filename: 'second.dng',
    });
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: 'photos/a',
      filename: 'first.dng',
    });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'photos', db);

    expect(matches).toEqual([{ assetId: oid(assetId), path: 'photos/a', filename: 'first.dng' }]);
  });

  test('a missing-tagged entry still belongs to the folder', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      path: 'photos',
      filename: 'offline.dng',
      missingSince: '2026-01-01T00:00:00.000Z',
    });

    const matches = await listLiveAssetLocationsUnderFolder(oid(libraryId), 'photos', db);

    expect(matches.map((m) => m.filename)).toEqual(['offline.dng']);
  });
});

describe('listTrashedAssetLocationsUnderFolder', () => {
  const ROOT = '/srv/lib';

  /** A trashed asset whose file used to live at `originalPath`. */
  function seedTrashed(
    handle: TestDatabase,
    libraryId: string,
    originalPath: string,
    filename: string,
  ): string {
    const assetId = insertAsset(handle.db, { deletedAt: '2026-01-01T00:00:00.000Z' });
    run(handle.db, `UPDATE assets SET original_path = ? WHERE id = ?`, originalPath, assetId);
    insertLocation(handle.db, {
      assetId,
      libraryId,
      path: '.maple/trash/photos',
      filename,
    });
    return assetId;
  }

  test('matches by the recorded original path, itself or below', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db, { path: ROOT });
    seedTrashed(handle, libraryId, `${ROOT}/photos/a.dng`, 'a.dng');
    seedTrashed(handle, libraryId, `${ROOT}/photos/2024/b.dng`, 'b.dng');
    seedTrashed(handle, libraryId, `${ROOT}/photos2/c.dng`, 'c.dng');

    const matches = await listTrashedAssetLocationsUnderFolder(oid(libraryId), ROOT, 'photos', db);

    expect(matches.map((m) => m.filename).sort()).toEqual(['a.dng', 'b.dng']);
  });

  test('an empty relPath means the whole library', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db, { path: ROOT });
    seedTrashed(handle, libraryId, `${ROOT}/photos/a.dng`, 'a.dng');
    seedTrashed(handle, libraryId, `${ROOT}/other/b.dng`, 'b.dng');

    const matches = await listTrashedAssetLocationsUnderFolder(oid(libraryId), ROOT, '', db);

    expect(matches.map((m) => m.filename).sort()).toEqual(['a.dng', 'b.dng']);
  });

  test('a live asset under the same path is not a restore candidate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db, { path: ROOT });
    const live = insertAsset(handle.db);
    run(
      handle.db,
      `UPDATE assets SET original_path = ? WHERE id = ?`,
      `${ROOT}/photos/l.dng`,
      live,
    );
    insertLocation(handle.db, { assetId: live, libraryId, path: 'photos', filename: 'l.dng' });

    const matches = await listTrashedAssetLocationsUnderFolder(oid(libraryId), ROOT, 'photos', db);

    expect(matches).toEqual([]);
  });
});

describe('loadNearbyAssetCandidates', () => {
  test('returns the live, in-window assets of one library with their folders', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const otherLibrary = insertFolder(handle.db);
    seedAt(handle, libraryId, {
      path: '2024/03',
      filename: 'inside.dng',
      capturedAt: '2024-03-15T00:00:00.000Z',
    });
    seedAt(handle, libraryId, {
      path: '2020/01',
      filename: 'before.dng',
      capturedAt: '2020-01-01T00:00:00.000Z',
    });
    seedAt(handle, otherLibrary, {
      path: '2024/03',
      filename: 'elsewhere.dng',
      capturedAt: '2024-03-15T00:00:00.000Z',
    });

    const { candidates, truncated } = await loadNearbyAssetCandidates(
      oid(libraryId),
      Date.parse('2024-03-01T00:00:00.000Z'),
      Date.parse('2024-03-31T00:00:00.000Z'),
      db,
    );

    expect(truncated).toBe(false);
    expect(candidates).toEqual([
      { capturedAtMs: Date.parse('2024-03-15T00:00:00.000Z'), folderPath: '2024/03' },
    ]);
  });

  test('a trashed asset and a non-live location are both excluded', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    seedAt(handle, libraryId, {
      path: '2024/03',
      filename: 'trashed.dng',
      capturedAt: '2024-03-15T00:00:00.000Z',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    const missing = insertAsset(handle.db, { exif: exifAt('2024-03-15T00:00:00.000Z') });
    insertLocation(handle.db, {
      assetId: missing,
      libraryId,
      path: '2024/03',
      filename: 'gone.dng',
      missingSince: '2026-01-01T00:00:00.000Z',
    });

    const { candidates } = await loadNearbyAssetCandidates(
      oid(libraryId),
      Date.parse('2024-03-01T00:00:00.000Z'),
      Date.parse('2024-03-31T00:00:00.000Z'),
      db,
    );

    expect(candidates).toEqual([]);
  });

  test('an asset with two live locations in the library contributes one candidate', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    const assetId = insertAsset(handle.db, { exif: exifAt('2024-03-15T00:00:00.000Z') });
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 0,
      path: '2024/03',
      filename: 'primary.dng',
    });
    insertLocation(handle.db, {
      assetId,
      libraryId,
      ordinal: 1,
      path: '2024/04',
      filename: 'dupe.dng',
    });

    const { candidates } = await loadNearbyAssetCandidates(
      oid(libraryId),
      Date.parse('2024-03-01T00:00:00.000Z'),
      Date.parse('2024-03-31T00:00:00.000Z'),
      db,
    );

    expect(candidates).toEqual([
      { capturedAtMs: Date.parse('2024-03-15T00:00:00.000Z'), folderPath: '2024/03' },
    ]);
  });
});
