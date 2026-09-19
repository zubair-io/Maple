/**
 * `findListingAssetsByFilenames` — the filename lookup `/api/fs/dir` runs to decide
 * which names on disk are indexed assets.
 *
 * The cases that matter are the ones browse's own logic depends on: every
 * location of a matched asset comes back (not just the one whose filename
 * matched), soft-deleted rows are reported rather than filtered out, and a
 * name that belongs to two libraries yields both assets so the caller's
 * absolute-path comparison is the thing that disambiguates them.
 */

import { describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { findListingAssetsByFilenames } from './assets.by-filename.ts';

describe('findListingAssetsByFilenames', () => {
  test('skips the round trip on an empty name list', async () => {
    using handle = await createTestDatabase();
    expect(await findListingAssetsByFilenames([], testSqliteDb(handle.db))).toEqual([]);
  });

  test('answers nothing when no location carries the name', async () => {
    using handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: asset, libraryId: library, filename: 'a.dng' });

    expect(await findListingAssetsByFilenames(['b.dng'], testSqliteDb(handle.db))).toEqual([]);
  });

  test('returns the asset with its exif payload parsed', async () => {
    using handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db, { exif: JSON.stringify({ lens: '35mm' }) });
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      path: 'vacation',
      filename: 'a.dng',
    });

    const found = await findListingAssetsByFilenames(['a.dng'], testSqliteDb(handle.db));
    expect(found).toHaveLength(1);
    expect(found[0]!._id.toHexString()).toBe(asset);
    expect((found[0]!.exif as { lens?: string } | null)?.lens).toBe('35mm');
    expect(found[0]!.deleted_at).toBeNull();
    expect(found[0]!.fileinfo).toHaveLength(1);
    expect(found[0]!.fileinfo[0]!.path).toBe('vacation');
    expect(found[0]!.fileinfo[0]!.filename).toBe('a.dng');
    expect(found[0]!.fileinfo[0]!.library_id.toHexString()).toBe(library);
  });

  /**
   * The reason the loader fetches locations by asset id rather than reusing the
   * rows the name matched. `assetAbsPath` resolves through the first *live*
   * entry, so an asset whose matched copy is the deleted one has to arrive with
   * the live copy attached or browse resolves it to the wrong path.
   */
  test('carries every location of a matched asset, in array order', async () => {
    using handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 0,
      path: 'old',
      filename: 'a.dng',
      deletedAt: '2026-01-01T00:00:00.000Z',
    });
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 1,
      path: 'new',
      filename: 'a.dng',
    });

    const found = await findListingAssetsByFilenames(['a.dng'], testSqliteDb(handle.db));
    expect(found).toHaveLength(1);
    expect(found[0]!.fileinfo.map((entry) => entry.path)).toEqual(['old', 'new']);
  });

  test('reports a soft-deleted asset rather than hiding it, so browse can trash its path', async () => {
    using handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db, { deletedAt: '2026-02-02T00:00:00.000Z' });
    insertLocation(handle.db, { assetId: asset, libraryId: library, filename: 'gone.dng' });

    const found = await findListingAssetsByFilenames(['gone.dng'], testSqliteDb(handle.db));
    expect(found).toHaveLength(1);
    expect(found[0]!.deleted_at).toBe('2026-02-02T00:00:00.000Z');
  });

  test('returns both assets when two libraries hold the same filename', async () => {
    using handle = await createTestDatabase();
    const first = insertFolder(handle.db);
    const second = insertFolder(handle.db);
    const a = insertAsset(handle.db);
    const b = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: a, libraryId: first, filename: 'shared.dng' });
    insertLocation(handle.db, { assetId: b, libraryId: second, filename: 'shared.dng' });

    const found = await findListingAssetsByFilenames(['shared.dng'], testSqliteDb(handle.db));
    expect(found.map((row) => row._id.toHexString()).sort()).toEqual([a, b].sort());
  });

  test('matches every name in the batch, deduplicating an asset that answers two of them', async () => {
    using handle = await createTestDatabase();
    const library = insertFolder(handle.db);
    const asset = insertAsset(handle.db);
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 0,
      path: 'one',
      filename: 'a.dng',
    });
    insertLocation(handle.db, {
      assetId: asset,
      libraryId: library,
      ordinal: 1,
      path: 'two',
      filename: 'b.dng',
    });
    const other = insertAsset(handle.db);
    insertLocation(handle.db, { assetId: other, libraryId: library, filename: 'c.dng' });

    const found = await findListingAssetsByFilenames(
      ['a.dng', 'b.dng', 'c.dng'],
      testSqliteDb(handle.db),
    );
    expect(found.map((row) => row._id.toHexString()).sort()).toEqual([asset, other].sort());
  });
});
