/**
 * Integration tests for POST /api/metadata/snapshots.
 *
 * Two tiers:
 *   1. Validation-only tests — no Mongo needed. Covers 400 responses and
 *      empty-metadata for unknown addresses.
 *   2. Real-Mongo tests — insert fixtures into a unique test DB and assert the
 *      full field mapping. These skip gracefully when Mongo is unreachable.
 *
 * The endpoint now accepts { addresses } (slug:relPath strings) instead of
 * { paths }. Tests register a test slug in the in-memory libraries cache via
 * setLibraryBySlugForTests, mirroring the pattern in address.test.ts.
 *
 * Pure unit tests for `overrideToXmpSnapshot` live in the sibling
 * metadata-snapshots.unit.test.ts (no Mongo / no I/O).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { metadataSnapshotsRoutes } from './metadata-snapshots.ts';

// Isolate db-client singleton to a unique test DB (matches xmp-batch.test.ts convention).
process.env.MAPLE_MONGO_DB = `maple_test_meta_snap_${process.pid}`;

let db: Db | null = null;
let mongoReachable = false;

beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
  // Try to connect so Mongo-backed tests can seed data.
  try {
    const { getDb, isDbConnected } = await import('../db/client.ts');
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
  }
});

afterAll(async () => {
  if (db) {
    try {
      await db.collection('assets').deleteMany({});
      await db.collection('folders').deleteMany({});
    } catch {
      // best-effort cleanup
    }
  }
  await (await import('../db/client.ts')).closeDb();
});

// ---------------------------------------------------------------------------
// Test slug + temp dir
// ---------------------------------------------------------------------------

const TEST_SLUG = 'meta-snap-test';
const TEST_LIB_ID = new ObjectId();

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meta-snap-test-')));

  const { setLibraryBySlugForTests } = await import('../indexer/libraries.cache.ts');
  setLibraryBySlugForTests(TEST_SLUG, {
    libraryId: TEST_LIB_ID,
    root: tmpDir,
    label: 'Meta Snap Test Library',
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/metadata/snapshots — validation tests (no Mongo required)
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
    // Address resolves to a path inside the library but no DB doc exists.
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
// POST /api/metadata/snapshots — real-Mongo tests
// ---------------------------------------------------------------------------

describe('POST /api/metadata/snapshots — real DB', () => {
  // Seed a folder + asset into the test DB.
  let folderId: ObjectId;
  let testRoot: string;

  beforeEach(async () => {
    if (!mongoReachable || !db) return;

    // Clean slate per test.
    await db.collection('assets').deleteMany({});
    await db.collection('folders').deleteMany({});

    // Use the current tmpDir as the library root.
    testRoot = tmpDir;

    // Insert the folder doc BEFORE invalidating the cache so the next
    // loadLibraryRoots() call (inside the route) reads from the DB and
    // picks up both the byId entry (for findAssetDocs) and the bySlug
    // entry (for resolveAddressString). Using setLibraryBySlugForTests
    // here would set byId to an empty Map and break findAssetDocs.
    folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: testRoot,
      slug: TEST_SLUG,
      label: 'Test Library',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);

    // Invalidate the library-roots cache so the route loads the new folder
    // from the DB (populating both byId and bySlug in one read).
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    // Invalidate library cache after cleanup.
    if (mongoReachable) {
      try {
        const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
        invalidateLibraryRoots();
      } catch {
        // best-effort
      }
    }
  });

  function skipIfNoMongo(): boolean {
    if (!mongoReachable || !db) return true;
    return false;
  }

  test('returns full metadata_override snapshot for a known asset', async () => {
    if (skipIfNoMongo()) return;

    const filename = 'known-asset.dng';
    await db!.collection('assets').insertOne({
      fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { captured_at: '2024-03-15T10:00:00Z', gps: { lat: 10, lng: 20 } },
      metadata_override: {
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
    } as never);

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
    if (skipIfNoMongo()) return;

    const filename = 'exif-gps-fallback.dng';
    await db!.collection('assets').insertOne({
      fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { captured_at: null, gps: { lat: 37.7749, lng: -122.4194 } },
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['caption'],
        caption: 'San Francisco bay',
        // no gps override
      },
    } as never);

    const res = await post({ addresses: [addr(filename)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;
    expect(snap.gpsLatitude).toBeCloseTo(37.7749, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-122.4194, 4);
    expect('gpsAltitude' in snap).toBe(false);
  });

  test('dateTimeOriginal falls back to exif.captured_at when override.captured_at absent', async () => {
    if (skipIfNoMongo()) return;

    const filename = 'exif-date-fallback.dng';
    await db!.collection('assets').insertOne({
      fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      exif: { captured_at: '2023-09-01T08:30:00Z', gps: null },
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['caption'],
        caption: 'Autumn light',
        // no captured_at override
      },
    } as never);

    const res = await post({ addresses: [addr(filename)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;
    expect(snap.dateTimeOriginal).toBe('2023-09-01T08:30:00Z');
  });

  test('returns snapshots in request-address order (not DB result order)', async () => {
    if (skipIfNoMongo()) return;

    const filenames = ['order-c.dng', 'order-a.dng', 'order-b.dng'];
    for (const [i, filename] of filenames.entries()) {
      await db!.collection('assets').insertOne({
        fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
        size: 1,
        mtime: 1,
        rating: 0,
        flag: 0,
        color_label: '',
        indexed_at: new Date().toISOString(),
        metadata_override: {
          edited_at: '2026-06-28T00:00:00Z',
          touched_fields: ['caption'],
          caption: `Caption ${i}`,
        },
      } as never);
    }

    // Request them in an order different from insertion order.
    const requestAddresses = filenames.map((f) => addr(f));
    const res = await post({ addresses: requestAddresses });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots.map((s: { address: string }) => s.address)).toEqual(requestAddresses);
  });

  test('returns metadata:{} for an address not in the DB', async () => {
    if (skipIfNoMongo()) return;

    const assetAddr = addr('does-not-exist.dng');
    const res = await post({ addresses: [assetAddr] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('does not leak data from same-named file in a different library', async () => {
    if (skipIfNoMongo()) return;

    const filename = 'ambiguous.dng';

    // First asset: in the test library slug. This one should match.
    await db!.collection('assets').insertOne({
      fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['city'],
        place_text: { city: 'Authorized City' },
      },
    } as never);

    // Second asset: in a DIFFERENT library root not registered under TEST_SLUG.
    const otherFolderId = new ObjectId();
    await db!.collection('folders').insertOne({
      _id: otherFolderId,
      path: '/private/other-library',
      slug: `other-${otherFolderId.toHexString()}`,
      label: 'Other Library',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    await db!.collection('assets').insertOne({
      fileinfo: [{ path: '', filename, library_id: otherFolderId, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['city'],
        place_text: { city: 'Unauthorized City - MUST NOT APPEAR' },
      },
    } as never);

    // Invalidate cache so both folders are loaded from DB on the next request.
    // The folder doc has slug: TEST_SLUG so loadCache() will populate bySlug
    // as well — no need to call setLibraryBySlugForTests here.
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
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
