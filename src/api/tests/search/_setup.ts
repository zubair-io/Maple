/**
 * Shared scaffolding for the search-route test suites. Each test file in
 * `tests/search/` is self-contained — it sets its own `MAPLE_MONGO_DB`,
 * connects, seeds, and tears down — but they share the same shape of
 * fixture data so assertions can read clearly.
 *
 * Why a `_` prefix? Bun's test runner picks up every `*.test.ts` file
 * under `tests/`; the leading underscore is a hint that this file is
 * helpers, not a test module.
 */

import { MongoClient, ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { signAccessToken } from '../../src/auth/tokens.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`.
// Each test file imports this module before any dynamic `searchRoutes`
// import, so a single env-write here covers them all.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET!;

export const BEARER =
  'Bearer ' +
  signAccessToken(
    {
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
    },
    SECRET,
  );

export function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

export const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

export async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

export interface Seed {
  /** Content-addressed location record. After the
   * drop-abs-path-2026-05-21 migration this is the only on-disk pointer
   * persisted on AssetDoc — `projectAsset` reads filename / folder_id
   * from `fileinfo[0]` and resolves `abs_path` via the libraries cache.
   *
   * Optional on this test-fixture shape: legacy buckets / list tests
   * still describe rows in `{ folder_id, abs_path, filename }` form
   * because their assertions key off those wire fields. The
   * `materializeSeeds` helper converts those into the right
   * `fileinfo[]` shape before insertMany. Tests authored after the
   * migration should set `fileinfo` directly. */
  fileinfo?: Array<{
    library_id: ObjectId;
    path: string;
    filename: string;
    deleted_at: string | null;
  }>;
  /** Legacy convenience field — kept on the test fixture shape so
   * pre-PR-7 fixtures don't need rewriting. Translated to `fileinfo[]`
   * by `materializeSeeds` before the insertMany. NOT persisted on
   * production AssetDocs. */
  folder_id?: ObjectId;
  /** Legacy convenience field — see `folder_id`. */
  abs_path?: string;
  /** Legacy convenience field — see `folder_id`. */
  filename?: string;
  size: number;
  mtime: number;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  exif?: {
    captured_at: string | null;
    camera_make: string | null;
    camera_model: string | null;
    lens: string | null;
    iso: number | null;
    aperture: number | null;
    shutter: string | null;
    focal_length: number | null;
    gps: { lat: number; lng: number } | null;
  } | null;
  deleted_at?: string | null;
}

/**
 * Translate a list of `Seed` rows into the post-PR-7 persisted shape:
 * each row gets a `fileinfo[]` derived from legacy `{folder_id,
 * abs_path, filename}` when those are present, OR keeps the explicit
 * `fileinfo` the test already provided.
 *
 * Callers should run this once before `insertMany`. Drops the legacy
 * fields off the output so the inserted docs match the production
 * schema (`abs_path`, `folder_id`, `filename` no longer exist on
 * AssetDoc post drop-abs-path-2026-05-21).
 */
export function materializeSeeds(
  seeds: Seed[],
): Array<Omit<Seed, 'folder_id' | 'abs_path' | 'filename'>> {
  return seeds.map((s) => {
    const { folder_id, abs_path, filename, ...rest } = s;
    let fileinfo = s.fileinfo;
    if (!fileinfo && folder_id && abs_path && filename) {
      fileinfo = [legacyToFileinfo(folder_id, abs_path, filename)];
    }
    return { ...rest, fileinfo: fileinfo ?? [] };
  });
}

/**
 * The 5-row base seed shared by the list, facets, and buckets suites.
 * Counts: 4 live + 1 soft-deleted; covers all three EXIF cameras + a
 * row with no EXIF + a row with a regex-friendly filename.
 */
export function baseSeeds(folderA: ObjectId, folderB: ObjectId): Seed[] {
  return [
    {
      fileinfo: [
        { library_id: folderA, path: '', filename: 'dji-mavic3pro-100mp.dng', deleted_at: null },
      ],
      size: 1024,
      mtime: Date.now(),
      rating: 5,
      flag: 1,
      color_label: 'red',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2024-06-01T12:00:00.000Z',
        camera_make: 'Hasselblad',
        camera_model: 'L3D-100c',
        lens: 'Hasselblad 24mm f/1.5',
        iso: 100,
        aperture: 2.8,
        shutter: '1/250',
        focal_length: 24,
        gps: { lat: 52.5, lng: 13.4 },
      },
    },
    {
      fileinfo: [{ library_id: folderA, path: '', filename: 'sunset.cr3', deleted_at: null }],
      size: 2048,
      mtime: Date.now() - 1000,
      rating: 3,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2023-12-25T18:30:00.000Z',
        camera_make: 'Canon',
        camera_model: 'EOS R5',
        lens: 'RF 24-70mm f/2.8L IS USM',
        iso: 800,
        aperture: 5.6,
        shutter: '1/60',
        focal_length: 50,
        gps: null,
      },
    },
    {
      fileinfo: [{ library_id: folderB, path: '', filename: 'sony.arw', deleted_at: null }],
      size: 4096,
      mtime: Date.now() - 2000,
      rating: 4,
      flag: 1,
      color_label: 'green',
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: '2024-01-15T09:15:00.000Z',
        camera_make: 'Sony',
        camera_model: 'A7R V',
        lens: 'FE 70-200mm f/2.8 GM',
        iso: 1600,
        aperture: 4.0,
        shutter: '1/1000',
        focal_length: 200,
        gps: null,
      },
    },
    {
      fileinfo: [{ library_id: folderB, path: '', filename: 'no-exif.jpg', deleted_at: null }],
      size: 512,
      mtime: Date.now() - 3000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
    },
    {
      // Soft-deleted row — must NOT appear in search results.
      fileinfo: [{ library_id: folderB, path: '', filename: 'deleted.dng', deleted_at: null }],
      size: 256,
      mtime: Date.now() - 4000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: new Date().toISOString(),
    },
  ];
}

/**
 * Seed the `folders` collection so the search-project's
 * `assetAbsPath(fileinfo, libraries)` call resolves library roots
 * instead of returning empty strings. The roots line up with the
 * legacy `/lib-a` / `/lib-b` paths from earlier fixtures so wire-shape
 * assertions stay the same after the migration.
 */
export async function seedFolders(db: Db, folderA: ObjectId, folderB: ObjectId): Promise<void> {
  await db.collection('folders').insertMany([
    {
      _id: folderA,
      path: '/lib-a',
      label: 'lib-a',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    },
    {
      _id: folderB,
      path: '/lib-b',
      label: 'lib-b',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    },
  ] as never);
  // Invalidate the process-wide library cache so the search route picks
  // up the just-seeded roots on the next request.
  const { invalidateLibraryRoots } = await import('../../src/indexer/libraries.cache.ts');
  invalidateLibraryRoots();
}

/**
 * Translate a legacy `{ folder_id, abs_path, filename }` seed triple
 * into the post-PR-7 fileinfo entry shape. Used by tests that were
 * authored against the pre-migration schema and still describe paths
 * as absolute strings — we keep the readable fixtures but rewrite the
 * shape at insert time so queries hit `fileinfo.*` paths correctly.
 *
 * `path` is computed as the directory portion of `abs_path` MINUS its
 * leading slash (so `/A/B/2.dng` becomes `path: "A/B"`). This matches
 * the convention used by `discover/index.ts` when it writes new rows.
 */
export function legacyToFileinfo(
  folderId: ObjectId,
  absPath: string,
  filename: string,
  deletedAt: string | null = null,
): { library_id: ObjectId; path: string; filename: string; deleted_at: string | null } {
  // Strip filename + its leading slash off the abs_path; what's left is
  // the directory portion. Drop the leading slash to align with the
  // server's relative-path convention.
  const lastSlash = absPath.lastIndexOf('/');
  const dir = lastSlash > 0 ? absPath.slice(0, lastSlash) : '';
  const relDir = dir.replace(/^\/+/, '');
  return { library_id: folderId, path: relDir, filename, deleted_at: deletedAt };
}

/**
 * Backfill exif.captured_year/month so the /buckets index-only path has
 * data to find. Mirrors the migration in `ensureIndexes()`; run inline
 * here because the test bypasses the normal startup flow.
 */
export async function backfillCapturedYearMonth(db: Db): Promise<void> {
  await db.collection('assets').updateMany(
    {
      'exif.captured_at': { $ne: null, $exists: true },
      'exif.captured_year': { $exists: false },
    },
    [
      {
        $set: {
          'exif.captured_year': {
            $year: {
              $dateFromString: {
                dateString: '$exif.captured_at',
                onError: null,
                onNull: null,
              },
            },
          },
          'exif.captured_month': {
            $month: {
              $dateFromString: {
                dateString: '$exif.captured_at',
                onError: null,
                onNull: null,
              },
            },
          },
        },
      },
    ],
  );
}
