/**
 * Integration tests for POST /api/metadata/snapshots.
 *
 * Two tiers:
 *   1. Validation — 400 responses and empty-metadata for unknown addresses.
 *   2. Field mapping — fixtures in the database, asserting the full snapshot.
 *
 * The endpoint accepts { addresses } (slug:relPath strings). The library row
 * is seeded for real rather than stubbed into the cache, because the route
 * needs BOTH halves of that cache: `bySlug` to resolve the address and `byId`
 * to rebuild each row's absolute path.
 *
 * Pure unit tests for `overrideToXmpSnapshot` live in the sibling
 * metadata-snapshots.unit.test.ts (no database / no I/O).
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { metadataSnapshotsRoutes } from './metadata-snapshots.ts';

const TEST_SLUG = 'meta-snap-test';

let live: LiveTestDatabase;
let tmpDir: string;
let folderId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meta-snap-test-')));
  folderId = insertFolder(live.db, { path: tmpDir, slug: TEST_SLUG });
  // One read populates both `bySlug` (address resolution) and `byId` (path
  // rebuilding), which is why the row is seeded rather than the cache stubbed.
  invalidateLibraryRoots();
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const app = new Elysia().use(metadataSnapshotsRoutes);

async function post(body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/metadata/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** Build an address string for a filename relative to the test library root. */
function addr(relPath: string): string {
  return `${TEST_SLUG}:${relPath}`;
}

/**
 * One asset at the library root, with its EXIF and its user-edit overlay.
 *
 * `metadata_override` lives in `asset_detail` rather than on the grid row, so
 * a fixture that only wrote the asset would silently produce an empty snapshot.
 */
function seedAsset(args: {
  libraryId?: string;
  filename: string;
  exif?: unknown;
  override?: unknown;
}): string {
  const assetId = insertAsset(live.db, {
    exif: args.exif === undefined ? null : JSON.stringify(args.exif),
  });
  insertLocation(live.db, {
    assetId,
    libraryId: args.libraryId ?? folderId,
    path: '',
    filename: args.filename,
  });
  if (args.override !== undefined) {
    run(
      live.db,
      `INSERT INTO asset_detail (asset_id, metadata_override) VALUES (?, ?)`,
      assetId,
      JSON.stringify(args.override),
    );
  }
  return assetId;
}

// ---------------------------------------------------------------------------
// POST /api/metadata/snapshots — validation
// ---------------------------------------------------------------------------

describe('POST /api/metadata/snapshots — validation', () => {
  test('returns 400 for empty addresses array', async () => {
    const res = await post({ addresses: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for addresses exceeding 1000', async () => {
    const addresses = Array.from({ length: 1001 }, (_, i) => addr(`img${i}.dng`));
    const res = await post({ addresses });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing addresses field', async () => {
    const res = await post({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('route is registered (not 404)', async () => {
    const res = await post({ addresses: [addr('photo.dng')] });
    expect(res.status).not.toBe(404);
  });

  test('returns metadata:{} for address with unknown slug', async () => {
    const res = await post({ addresses: ['no-such-slug:photo.dng'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].address).toBe('no-such-slug:photo.dng');
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('returns metadata:{} for address not found in DB (unknown file, authorized)', async () => {
    // Address resolves to a path inside the library but no row exists.
    const unknownAddr = addr('nonexistent-file.dng');
    const res = await post({ addresses: [unknownAddr] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].address).toBe(unknownAddr);
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('preserves request order in response', async () => {
    const addresses = [addr('photo1.dng'), addr('photo2.dng'), addr('photo3.dng')];
    const res = await post({ addresses });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots.map((s: { address: string }) => s.address)).toEqual(addresses);
  });
});

// ---------------------------------------------------------------------------
// POST /api/metadata/snapshots — field mapping
// ---------------------------------------------------------------------------

describe('POST /api/metadata/snapshots — real DB', () => {
  test('returns full metadata_override snapshot for a known asset', async () => {
    const filename = 'known-asset.dng';
    seedAsset({
      filename,
      exif: { captured_at: '2024-03-15T10:00:00Z', gps: { lat: 10, lng: 20 } },
      override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['gps', 'caption', 'city', 'copyright_status'],
        gps: { lat: 48.8566, lng: 2.3522, alt: 50 },
        captured_at: '2026-01-10T14:00:00+01:00',
        time_zone: 'Europe/Paris',
        place_text: {
          sublocation: 'Eiffel Tower',
          city: 'Paris',
          state: 'Île-de-France',
          country: 'France',
          country_code: 'fr',
        },
        keywords: ['landmark', 'paris'],
        title: 'Eiffel Tower',
        caption: 'The tower at golden hour',
        headline: 'Paris Golden Hour',
        instructions: 'For editorial use',
        creator: 'Alice',
        creator_job_title: 'Photographer',
        copyright_notice: '© 2026 Alice',
        copyright_status: 'copyrighted',
        usage_terms: 'Editorial only',
        credit: 'Alice / Maple',
        source: 'Maple Photos',
      },
    });

    const assetAddr = addr(filename);
    const res = await post({ addresses: [assetAddr] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].address).toBe(assetAddr);
    const snap = body.snapshots[0].metadata;
    expect(snap.gpsLatitude).toBeCloseTo(48.8566, 4);
    expect(snap.gpsLongitude).toBeCloseTo(2.3522, 4);
    expect(snap.gpsAltitude).toBe(50);
    expect(snap.dateTimeOriginal).toBe('2026-01-10T14:00:00+01:00');
    expect(snap.timeZone).toBe('Europe/Paris');
    expect(snap.sublocation).toBe('Eiffel Tower');
    expect(snap.city).toBe('Paris');
    expect(snap.state).toBe('Île-de-France');
    expect(snap.country).toBe('France');
    expect(snap.countryCode).toBe('fr');
    expect(snap.keywords).toEqual(['landmark', 'paris']);
    expect(snap.caption).toBe('The tower at golden hour');
    expect(snap.copyrightStatus).toBe('copyrighted');
    expect(snap.creator).toBe('Alice');
  });

  test('GPS falls back to exif.gps when metadata_override.gps is absent', async () => {
    const filename = 'exif-gps-fallback.dng';
    seedAsset({
      filename,
      exif: { captured_at: null, gps: { lat: 37.7749, lng: -122.4194 } },
      override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['caption'],
        caption: 'San Francisco bay',
        // no gps override
      },
    });

    const res = await post({ addresses: [addr(filename)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;
    expect(snap.gpsLatitude).toBeCloseTo(37.7749, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-122.4194, 4);
    expect('gpsAltitude' in snap).toBe(false);
  });

  test('dateTimeOriginal falls back to exif.captured_at when override.captured_at absent', async () => {
    const filename = 'exif-date-fallback.dng';
    seedAsset({
      filename,
      exif: { captured_at: '2023-09-01T08:30:00Z', gps: null },
      override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['caption'],
        caption: 'Autumn light',
        // no captured_at override
      },
    });

    const res = await post({ addresses: [addr(filename)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;
    expect(snap.dateTimeOriginal).toBe('2023-09-01T08:30:00Z');
  });

  test('returns snapshots in request-address order (not DB result order)', async () => {
    const filenames = ['order-c.dng', 'order-a.dng', 'order-b.dng'];
    for (const [i, filename] of filenames.entries()) {
      seedAsset({
        filename,
        override: {
          edited_at: '2026-06-28T00:00:00Z',
          touched_fields: ['caption'],
          caption: `Caption ${i}`,
        },
      });
    }

    // Request them in an order different from insertion order.
    const requestAddresses = filenames.map((f) => addr(f));
    const res = await post({ addresses: requestAddresses });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots.map((s: { address: string }) => s.address)).toEqual(requestAddresses);
  });

  test('returns metadata:{} for an address not in the DB', async () => {
    const assetAddr = addr('does-not-exist.dng');
    const res = await post({ addresses: [assetAddr] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('does not leak data from same-named file in a different library', async () => {
    const filename = 'ambiguous.dng';

    // First asset: in the test library slug. This one should match.
    seedAsset({
      filename,
      override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['city'],
        place_text: { city: 'Authorized City' },
      },
    });

    // Second asset: in a DIFFERENT library root not registered under TEST_SLUG.
    const otherFolderId = insertFolder(live.db, {
      path: '/private/other-library',
      slug: 'other-library',
    });
    seedAsset({
      libraryId: otherFolderId,
      filename,
      override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['city'],
        place_text: { city: 'Unauthorized City - MUST NOT APPEAR' },
      },
    });

    // Both folders are loaded from the database on the next request; the
    // TEST_SLUG row populates `bySlug` as well as `byId`.
    invalidateLibraryRoots();

    // Request only the address inside the test slug.
    const assetAddr = addr(filename);
    const res = await post({ addresses: [assetAddr] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;

    // Must get the authorized city, not the other library's data.
    expect(snap.city).toBe('Authorized City');
    expect(JSON.stringify(snap)).not.toContain('MUST NOT APPEAR');
  });
});
