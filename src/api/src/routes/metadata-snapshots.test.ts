/**
 * Integration tests for POST /api/metadata/snapshots.
 *
 * Two tiers:
 *   1. Validation-only tests — no Mongo needed (mirrors backup-refile.test.ts
 *      pattern). Covers 400 responses, auth jail, and empty-metadata for
 *      unknown paths.
 *   2. Real-Mongo tests — insert fixtures into a unique test DB and assert the
 *      full field mapping. These skip gracefully when Mongo is unreachable
 *      (mirrors assets-list.test.ts pattern).
 *
 * Unit tests for `overrideToXmpSnapshot` run standalone (pure function, no I/O).
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { metadataSnapshotsRoutes, overrideToXmpSnapshot } from './metadata-snapshots.ts';

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
// Temp dir for MAPLE_ROOTS
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalMapleRoots = process.env.MAPLE_ROOTS;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'meta-snap-test-')));
  process.env.MAPLE_ROOTS = tmpDir;
});

// Note: we intentionally do NOT tear down tmpDir per-test — DB-backed tests
// use a stable root that must persist for the full test run.

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

function rawPath(filename: string): string {
  return path.join(tmpDir, filename);
}

// ---------------------------------------------------------------------------
// overrideToXmpSnapshot — unit tests (pure, no I/O)
// ---------------------------------------------------------------------------

describe('overrideToXmpSnapshot', () => {
  test('returns empty object when no override and no exif', () => {
    expect(overrideToXmpSnapshot({})).toEqual({});
  });

  test('returns empty object when override and exif are null', () => {
    expect(overrideToXmpSnapshot({ exif: null, metadata_override: null })).toEqual({});
  });

  test('maps full override GPS + place + text fields', () => {
    const snap = overrideToXmpSnapshot({
      exif: null,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        gps: { lat: 48.8566, lng: 2.3522, alt: 35 },
        captured_at: '2026-01-01T12:00:00+01:00',
        time_zone: 'Europe/Paris',
        place_text: {
          sublocation: 'Eiffel Tower',
          city: 'Paris',
          state: 'Île-de-France',
          country: 'France',
          country_code: 'fr',
        },
        keywords: ['travel', 'france'],
        title: 'Eiffel at dusk',
        caption: 'Tower at dusk',
        headline: 'Paris 2026',
        instructions: 'For editorial use only',
        creator: 'Jane Doe',
        creator_job_title: 'Photographer',
        copyright_notice: '© 2026 Jane Doe',
        copyright_status: 'copyrighted',
        usage_terms: 'Editorial only',
        credit: 'Jane Doe / Agency',
        source: 'Maple',
      },
    });

    expect(snap.gpsLatitude).toBeCloseTo(48.8566, 4);
    expect(snap.gpsLongitude).toBeCloseTo(2.3522, 4);
    expect(snap.gpsAltitude).toBe(35);
    expect(snap.dateTimeOriginal).toBe('2026-01-01T12:00:00+01:00');
    expect(snap.timeZone).toBe('Europe/Paris');
    expect(snap.sublocation).toBe('Eiffel Tower');
    expect(snap.city).toBe('Paris');
    expect(snap.state).toBe('Île-de-France');
    expect(snap.country).toBe('France');
    expect(snap.countryCode).toBe('fr');
    expect(snap.keywords).toEqual(['travel', 'france']);
    expect(snap.title).toBe('Eiffel at dusk');
    expect(snap.caption).toBe('Tower at dusk');
    expect(snap.headline).toBe('Paris 2026');
    expect(snap.instructions).toBe('For editorial use only');
    expect(snap.creator).toBe('Jane Doe');
    expect(snap.creatorJobTitle).toBe('Photographer');
    expect(snap.copyrightNotice).toBe('© 2026 Jane Doe');
    expect(snap.copyrightStatus).toBe('copyrighted');
    expect(snap.usageTerms).toBe('Editorial only');
    expect(snap.credit).toBe('Jane Doe / Agency');
    expect(snap.source).toBe('Maple');
  });

  test('falls back to exif.gps when override.gps is absent', () => {
    const snap = overrideToXmpSnapshot({
      exif: {
        gps: { lat: 51.5074, lng: -0.1278 },
        captured_at: '2025-06-01T10:00:00Z',
      } as never,
      metadata_override: {
        edited_at: '2026-01-01T00:00:00Z',
        touched_fields: [],
      },
    });
    expect(snap.gpsLatitude).toBeCloseTo(51.5074, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-0.1278, 4);
    expect('gpsAltitude' in snap).toBe(false);
  });

  test('falls back to exif.captured_at when override.captured_at is absent', () => {
    const snap = overrideToXmpSnapshot({
      exif: { captured_at: '2025-05-01T08:00:00Z', gps: null } as never,
      metadata_override: {
        edited_at: '2026-01-01T00:00:00Z',
        touched_fields: [],
      },
    });
    expect(snap.dateTimeOriginal).toBe('2025-05-01T08:00:00Z');
  });

  test('override.captured_at takes precedence over exif.captured_at', () => {
    const snap = overrideToXmpSnapshot({
      exif: { captured_at: '2020-01-01T00:00:00Z', gps: null } as never,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['captured_at'],
        captured_at: '2025-06-15T14:30:00+02:00',
      },
    });
    expect(snap.dateTimeOriginal).toBe('2025-06-15T14:30:00+02:00');
  });

  test('override.gps takes precedence over exif.gps', () => {
    const snap = overrideToXmpSnapshot({
      exif: { gps: { lat: 0, lng: 0 }, captured_at: null } as never,
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['gps'],
        gps: { lat: 40.7128, lng: -74.006 },
      },
    });
    expect(snap.gpsLatitude).toBeCloseTo(40.7128, 4);
    expect(snap.gpsLongitude).toBeCloseTo(-74.006, 4);
  });

  test('includes empty keywords array when override.keywords is []', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: ['keywords'],
        keywords: [],
      },
    });
    expect(snap.keywords).toEqual([]);
  });

  test('skips keywords key when override.keywords is null', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        keywords: null,
      },
    });
    expect('keywords' in snap).toBe(false);
  });

  test('skips null place_text subfields', () => {
    const snap = overrideToXmpSnapshot({
      metadata_override: {
        edited_at: '2026-06-28T00:00:00Z',
        touched_fields: [],
        place_text: { city: null, country: 'Spain' },
      },
    });
    expect('city' in snap).toBe(false);
    expect(snap.country).toBe('Spain');
  });
});

// ---------------------------------------------------------------------------
// POST /api/metadata/snapshots — validation tests (no Mongo required)
// ---------------------------------------------------------------------------

describe('POST /api/metadata/snapshots — validation', () => {
  test('returns 400 for empty paths array', async () => {
    const res = await post({ paths: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for paths exceeding 1000', async () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `/some/root/img${i}.dng`);
    const res = await post({ paths });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing paths field', async () => {
    const res = await post({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('route is registered (not 404)', async () => {
    const res = await post({ paths: [rawPath('photo.dng')] });
    expect(res.status).not.toBe(404);
  });

  test('returns metadata:{} for path that fails auth (outside MAPLE_ROOTS)', async () => {
    const res = await post({ paths: ['/etc/passwd'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].path).toBe('/etc/passwd');
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('returns metadata:{} for path not found in DB (unknown path, authorized)', async () => {
    // This path is inside MAPLE_ROOTS but no doc exists for it.
    // The route must return 200 with empty metadata — missing-asset is not an
    // error condition (mirrors the real-DB test at the bottom of this file).
    const unknownPath = rawPath('nonexistent-file.dng');
    const res = await post({ paths: [unknownPath] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0].path).toBe(unknownPath);
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('preserves request order in response', async () => {
    // All unauthorized — auth failure returns empty snapshots in order.
    const paths = ['/a/photo1.dng', '/b/photo2.dng', '/c/photo3.dng'];
    const res = await post({ paths });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots.map((s: { path: string }) => s.path)).toEqual(paths);
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
    process.env.MAPLE_ROOTS = testRoot;

    // Invalidate the library-roots cache so the route picks up the new folder.
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: testRoot,
      slug: `test-${folderId.toHexString()}`,
      label: 'Test Library',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
  });

  afterAll(async () => {
    // Restore original MAPLE_ROOTS.
    if (originalMapleRoots !== undefined) {
      process.env.MAPLE_ROOTS = originalMapleRoots;
    } else {
      delete process.env.MAPLE_ROOTS;
    }
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

    const absPath = path.join(testRoot, filename);
    const res = await post({ paths: [absPath] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots).toHaveLength(1);
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

    const absPath = path.join(testRoot, filename);
    const res = await post({ paths: [absPath] });
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

    const absPath = path.join(testRoot, filename);
    const res = await post({ paths: [absPath] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;
    expect(snap.dateTimeOriginal).toBe('2023-09-01T08:30:00Z');
  });

  test('returns snapshots in request-path order (not DB result order)', async () => {
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
    const requestPaths = filenames.map((f) => path.join(testRoot, f));
    const res = await post({ paths: requestPaths });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots.map((s: { path: string }) => s.path)).toEqual(requestPaths);
  });

  test('returns metadata:{} for a path not in the DB', async () => {
    if (skipIfNoMongo()) return;

    const absPath = path.join(testRoot, 'does-not-exist.dng');
    const res = await post({ paths: [absPath] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots[0].metadata).toEqual({});
  });

  test('does not leak data from same-named file in a different library', async () => {
    if (skipIfNoMongo()) return;

    const filename = 'ambiguous.dng';

    // First asset: in MAPLE_ROOTS (tmpDir). This one should match.
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

    // Second asset: in a DIFFERENT library root not in MAPLE_ROOTS.
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

    // Invalidate cache so both folders are loaded.
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    // Request the path inside MAPLE_ROOTS only.
    const absPath = path.join(testRoot, filename);
    const res = await post({ paths: [absPath] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const snap = body.snapshots[0].metadata;

    // Must get the authorized city, not the other library's data.
    expect(snap.city).toBe('Authorized City');
    expect(JSON.stringify(snap)).not.toContain('MUST NOT APPEAR');
  });
});
