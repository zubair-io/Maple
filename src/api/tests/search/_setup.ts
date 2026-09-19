/**
 * Shared scaffolding for the search-route test suites.
 *
 * Each file in `tests/search/` opens its own in-memory SQLite database,
 * installs it as the process-wide handle for the length of the file, seeds it
 * from the fixtures here, and disposes it. The fixture shape is shared so
 * assertions across the list, facets, buckets and scope suites can be read
 * against one known library.
 *
 * Why a `_` prefix? Bun's test runner picks up every `*.test.ts` file under
 * `tests/`; the leading underscore is a hint that this file is helpers, not a
 * test module.
 */

import type { Database } from 'bun:sqlite';
import { signAccessToken } from '../../src/auth/tokens.ts';
import { seedSearchAsset, type SeedAsset } from '../../src/db/sqlite/repos/search.test-helpers.ts';
import { insertFolder } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`.
// Each test file imports this module before any dynamic `searchRoutes`
// import, so a single env-write here covers them all.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET!;

export const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
      file_access: true,
    },
    SECRET,
  ));

export function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

// ── The two library roots every fixture below lives under ────────────────

export const LIB_A_ROOT = '/lib-a';
export const LIB_B_ROOT = '/lib-b';

/** The library ids a seeded fixture created, for `libraryId=` assertions. */
export interface SeededLibraries {
  folderA: string;
  folderB: string;
}

/** Both library roots, at the paths the wire-shape assertions expect. */
export function seedLibraries(db: Database): SeededLibraries {
  return {
    folderA: insertFolder(db, { path: LIB_A_ROOT, slug: 'lib-a' }),
    folderB: insertFolder(db, { path: LIB_B_ROOT, slug: 'lib-b' }),
  };
}

/**
 * The 5-row base fixture shared by the list, facets and buckets suites.
 *
 * Four live rows plus one soft-deleted; covers all three EXIF cameras, a row
 * with no EXIF at all, and a row whose filename the free-text `q` filter can
 * pick out. `path: ''` puts every file directly under its library root, so
 * `abs_path` is `<root>/<filename>` and the wire assertions stay readable.
 */
export function baseSeeds(folderA: string, folderB: string): Array<[string, SeedAsset]> {
  return [
    [
      folderA,
      {
        filename: 'dji-mavic3pro-100mp.dng',
        path: '',
        rating: 5,
        flag: 1,
        colorLabel: 'red',
        capturedAt: '2024-06-01T12:00:00.000Z',
        cameraMake: 'Hasselblad',
        cameraModel: 'L3D-100c',
        lens: 'Hasselblad 24mm f/1.5',
        iso: 100,
        aperture: 2.8,
        focalLength: 24,
        gps: { lat: 52.5, lng: 13.4 },
      },
    ],
    [
      folderA,
      {
        filename: 'sunset.cr3',
        path: '',
        rating: 3,
        capturedAt: '2023-12-25T18:30:00.000Z',
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
        lens: 'RF 24-70mm f/2.8L IS USM',
        iso: 800,
        aperture: 5.6,
        focalLength: 50,
      },
    ],
    [
      folderB,
      {
        filename: 'sony.arw',
        path: '',
        rating: 4,
        flag: 1,
        colorLabel: 'green',
        capturedAt: '2024-01-15T09:15:00.000Z',
        cameraMake: 'Sony',
        cameraModel: 'A7R V',
        lens: 'FE 70-200mm f/2.8 GM',
        iso: 1600,
        aperture: 4.0,
        focalLength: 200,
      },
    ],
    [folderB, { filename: 'no-exif.jpg', path: '', capturedAt: null }],
    // Soft-deleted row — must NOT appear in search results.
    [
      folderB,
      {
        filename: 'deleted.dng',
        path: '',
        capturedAt: null,
        deletedAt: '2024-07-01T00:00:00.000Z',
      },
    ],
  ];
}

/** Seeds both libraries and the base fixture, and returns the library ids. */
export function seedBaseLibrary(db: Database): SeededLibraries {
  const libraries = seedLibraries(db);
  for (const [libraryId, asset] of baseSeeds(libraries.folderA, libraries.folderB)) {
    seedSearchAsset(db, libraryId, asset);
  }
  return libraries;
}
