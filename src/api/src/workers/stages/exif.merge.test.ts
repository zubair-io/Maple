/**
 * EXIF stage — merge-on-collision tests for `tryMergeWithExistingPrimary`.
 *
 * Covers the runtime safety net the handler reaches for when a `maple_id`
 * upgrade would collide with an existing row's primary id. The expected
 * behaviour mirrors the boot-time duplicate heal but applies one row at a time,
 * as duplicates surface from the worker queue. See `workers/stages/exif.ts` for
 * the production call site.
 *
 * `createLiveTestDatabase` rather than an override handle: the merge reaches
 * `sqliteDb()` through the repository with no override, and the point of these
 * cases is the real schema — `assets_maple_id` is a UNIQUE partial index, so a
 * merge that let two rows hold the same primary id at any point fails loudly
 * here instead of silently passing against a mock.
 */
import { describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { __exifTestInternals } from './exif.ts';

const NO_LOSER_CONTRIBUTION = { exif: null, is_screenshot: false };

interface RowFixture {
  mapleId: string;
  indexedAt: string;
  rating?: number;
  flag?: number;
  colorLabel?: string;
  exif?: Record<string, unknown> | null;
  locations: Array<{ path: string; filename: string; deletedAt?: string | null }>;
}

/** Seeds one asset row with its locations, and returns it in `ImageDoc` shape. */
function seedRow(
  db: Database,
  libraryId: string,
  fixture: RowFixture,
): {
  _id: ObjectId;
  maple_id: string;
  indexed_at: string;
  rating: number;
  flag: number;
  color_label: string;
  exif: Record<string, unknown> | null;
  fileinfo: Array<{
    path: string;
    filename: string;
    library_id: ObjectId;
    deleted_at: string | null;
  }>;
} {
  const id = insertAsset(db, { exif: fixture.exif ? JSON.stringify(fixture.exif) : null });
  run(
    db,
    `UPDATE assets SET maple_id = ?, indexed_at = ?, rating = ?, flag = ?, color_label = ?
      WHERE id = ?`,
    fixture.mapleId,
    fixture.indexedAt,
    fixture.rating ?? 0,
    fixture.flag ?? 0,
    fixture.colorLabel ?? '',
    id,
  );
  fixture.locations.forEach((location, ordinal) => {
    insertLocation(db, {
      assetId: id,
      libraryId,
      ordinal,
      path: location.path,
      filename: location.filename,
      deletedAt: location.deletedAt ?? null,
    });
  });
  return {
    _id: new ObjectId(id),
    maple_id: fixture.mapleId,
    indexed_at: fixture.indexedAt,
    rating: fixture.rating ?? 0,
    flag: fixture.flag ?? 0,
    color_label: fixture.colorLabel ?? '',
    exif: fixture.exif ?? null,
    fileinfo: fixture.locations.map((location) => ({
      path: location.path,
      filename: location.filename,
      library_id: new ObjectId(libraryId),
      deleted_at: location.deletedAt ?? null,
    })),
  };
}

/** `"<path>/<filename>"` for every location of an asset, sorted. */
function locationsOf(db: Database, assetId: ObjectId): string[] {
  return (
    db
      .query(`SELECT path, filename FROM asset_locations WHERE asset_id = ?`)
      .all(assetId.toHexString()) as Array<{ path: string; filename: string }>
  )
    .map((row) => `${row.path}/${row.filename}`)
    .sort();
}

function assetRow(db: Database, assetId: ObjectId): Record<string, unknown> | null {
  return db.query(`SELECT * FROM assets WHERE id = ?`).get(assetId.toHexString()) as Record<
    string,
    unknown
  > | null;
}

describe('exif stage — tryMergeWithExistingPrimary', () => {
  it('returns null when no other row owns the new maple_id', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const loser = seedRow(live.db, libraryId, {
      mapleId: '02' + 'a'.repeat(30),
      indexedAt: '2026-05-01T00:00:00.000Z',
      locations: [{ path: 'a', filename: 'IMG.jpg' }],
    });

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      '01' + 'b'.repeat(30),
      NO_LOSER_CONTRIBUTION,
    );

    expect(result).toBeNull();
    // The row is untouched — including its fallback id, which the caller
    // upgrades itself through the ordinary patch when this returns null.
    expect(assetRow(live.db, loser._id)).toMatchObject({ maple_id: loser.maple_id });
  });

  it('merges locations into the survivor and deletes the condemned when the new id collides', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const collidingId = '01' + 'c'.repeat(30);
    // The other row was indexed earlier, so it survives.
    const other = seedRow(live.db, libraryId, {
      mapleId: collidingId,
      indexedAt: '2026-04-01T00:00:00.000Z',
      locations: [{ path: 'a', filename: 'IMG.jpg' }],
    });
    const loser = seedRow(live.db, libraryId, {
      mapleId: '02' + 'd'.repeat(30),
      indexedAt: '2026-05-01T00:00:00.000Z',
      locations: [{ path: 'b', filename: 'IMG.jpg' }],
    });

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );

    expect(result).not.toBeNull();
    expect(result!.equals(other._id)).toBe(true);
    expect(locationsOf(live.db, other._id)).toEqual(['a/IMG.jpg', 'b/IMG.jpg']);
    expect(assetRow(live.db, loser._id)).toBeNull();
    // The roll-up the triggers maintain followed the rows across, without the
    // explicit recompute the Mongo merge had to issue twice.
    expect(assetRow(live.db, other._id)).toMatchObject({ live_location_count: 2 });
  });

  it('picks the older row as survivor and writes the maple_id upgrade when the loser is older', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const collidingId = '01' + 'a'.repeat(30);
    // The OTHER row is newer, so the survivor pick by `indexed_at` keeps the
    // row this stage is processing — and the merge claims the primary id for
    // it. On Mongo that write had to be ordered strictly after the delete to
    // avoid colliding on the unique index, and a crash in between stranded the
    // survivor on its fallback id; here both are in one transaction.
    const other = seedRow(live.db, libraryId, {
      mapleId: collidingId,
      indexedAt: '2026-05-15T00:00:00.000Z',
      locations: [{ path: 'newer', filename: 'IMG.jpg' }],
    });
    const loser = seedRow(live.db, libraryId, {
      mapleId: '02' + '1'.repeat(30),
      indexedAt: '2026-01-01T00:00:00.000Z',
      rating: 5,
      flag: 1,
      colorLabel: 'red',
      locations: [{ path: 'older', filename: 'IMG.jpg' }],
    });

    const result = await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );

    expect(result).not.toBeNull();
    expect(result!.equals(loser._id)).toBe(true);
    expect(assetRow(live.db, loser._id)).toMatchObject({
      maple_id: collidingId,
      // User-edited fields kept — they were already on the survivor.
      rating: 5,
      flag: 1,
      color_label: 'red',
    });
    expect(locationsOf(live.db, loser._id)).toEqual(['newer/IMG.jpg', 'older/IMG.jpg']);
    expect(assetRow(live.db, other._id)).toBeNull();
  });

  it('migrates user-edited fields (rating, flag, color_label) from condemned onto a default survivor', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const collidingId = '01' + '5'.repeat(30);
    // The survivor holds defaults and the condemned row holds user edits. Rare
    // but real: a user rates a freshly-discovered duplicate before its exif
    // stage finishes.
    const other = seedRow(live.db, libraryId, {
      mapleId: collidingId,
      indexedAt: '2026-04-01T00:00:00.000Z',
      locations: [{ path: 'a', filename: 'IMG.jpg' }],
    });
    const loser = seedRow(live.db, libraryId, {
      mapleId: '02' + '6'.repeat(30),
      indexedAt: '2026-05-01T00:00:00.000Z',
      rating: 4,
      flag: 1,
      colorLabel: 'green',
      locations: [{ path: 'b', filename: 'IMG.jpg' }],
    });

    await __exifTestInternals.tryMergeWithExistingPrimary(
      loser as never,
      collidingId,
      NO_LOSER_CONTRIBUTION,
    );

    expect(assetRow(live.db, other._id)).toMatchObject({
      rating: 4,
      flag: 1,
      color_label: 'green',
    });
  });

  it('writes the freshly-computed exif from the loser when the survivor has none', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    const collidingId = '01' + '7'.repeat(30);
    const other = seedRow(live.db, libraryId, {
      mapleId: collidingId,
      indexedAt: '2026-04-01T00:00:00.000Z',
      exif: null,
      locations: [{ path: 'a', filename: 'IMG.jpg' }],
    });
    const loser = seedRow(live.db, libraryId, {
      mapleId: '02' + '8'.repeat(30),
      indexedAt: '2026-05-01T00:00:00.000Z',
      locations: [{ path: 'b', filename: 'IMG.jpg' }],
    });

    await __exifTestInternals.tryMergeWithExistingPrimary(loser as never, collidingId, {
      exif: {
        captured_at: '2024-01-01T12:00:00.000Z',
        captured_year: 2024,
        captured_month: 1,
        camera_make: 'Hasselblad',
        camera_model: 'L3D-100c',
        lens: null,
        iso: 100,
        aperture: 5.6,
        shutter: '1/250',
        focal_length: 24,
        gps: null,
      } as never,
      is_screenshot: false,
    });

    const survivor = assetRow(live.db, other._id)!;
    expect(JSON.parse(survivor.exif as string)).toMatchObject({ camera_make: 'Hasselblad' });
    // The generated column reads through the JSON the merge just wrote, so the
    // survivor is immediately sortable by capture time.
    expect(survivor.captured_at).toBe('2024-01-01T12:00:00.000Z');
  });

  it('cannot be handed two rows claiming the same file — the schema forbids it', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db);
    seedRow(live.db, libraryId, {
      mapleId: '01' + 'e'.repeat(30),
      indexedAt: '2026-04-01T00:00:00.000Z',
      locations: [{ path: 'shared', filename: 'IMG.jpg' }],
    });

    // The Mongo merge carried a whole branch for this: if both rows listed the
    // same `(library, path, filename)` and the survivor's copy was tombstoned
    // while the loser's was live, an `arrayFilters` pass had to revive it.
    // `asset_locations_lib_path_name` is UNIQUE across the table, so the state
    // that branch existed to repair cannot be reached — which is why the branch
    // is gone rather than ported.
    expect(() =>
      insertLocation(live.db, {
        assetId: insertAsset(live.db),
        libraryId,
        path: 'shared',
        filename: 'IMG.jpg',
      }),
    ).toThrow(/UNIQUE/i);
  });
});
