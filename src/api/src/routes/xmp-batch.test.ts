/**
 * Integration tests for POST /api/xmp/batch.
 *
 * Uses a real temp directory for sidecar files. MongoDB calls from
 * markSidecarMetadataIndexDirty are allowed to fail (they're best-effort),
 * so we don't need a live Mongo for the core sidecar-write path.
 *
 * The endpoint now accepts { address } (slug:relPath) instead of { path }.
 * Tests register a test slug in the in-memory libraries cache via
 * setLibraryBySlugForTests, mirroring the pattern in address.test.ts.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ObjectId } from 'mongodb';
import { Elysia } from 'elysia';
import { xmpBatchRoutes } from './xmp-batch.ts';
import { parseXmpMetadata } from '../xmp/metadata-parser.ts';

// Isolate the shared db-client singleton to a unique test DB and reset it
// around this file, so markSidecarMetadataIndexDirty's Mongo touch neither writes
// the real `maple` DB nor leaves the singleton connected for later test files
// (mirrors the convention in folder.test.ts / imports/repo.test.ts).
process.env.MAPLE_MONGO_DB = `maple_test_xmp_batch_${process.pid}`;
beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});
afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const app = new Elysia().use(xmpBatchRoutes);

// ---------------------------------------------------------------------------
// Temp dir + slug setup
// ---------------------------------------------------------------------------

const TEST_SLUG = 'xmp-batch-test';
const TEST_LIB_ID = new ObjectId();

let tmpDir: string;
const originalMapleRoots = process.env.MAPLE_ROOTS;

beforeEach(async () => {
  // realpath the temp dir: on macOS os.tmpdir() is under /var → /private/var
  // symlink, and writeXmpAtomic realpaths before its root check, so an
  // un-realpath'd MAPLE_ROOTS would look "outside" the registered root.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-batch-test-')));

  // Jail the write path so safeWriteAllowed passes when other test files set
  // a narrow MAPLE_ROOTS concurrently (bun runs test files in parallel).
  process.env.MAPLE_ROOTS = tmpDir;

  // Register the temp dir as a library slug in the in-memory cache so
  // resolveAddressString can look up the slug:relPath address scheme.
  const { setLibraryBySlugForTests } = await import('../indexer/libraries.cache.ts');
  setLibraryBySlugForTests(TEST_SLUG, {
    libraryId: TEST_LIB_ID,
    root: tmpDir,
    label: 'XMP Batch Test Library',
  });
});

afterEach(async () => {
  // Restore MAPLE_ROOTS to avoid leaking the jail into sibling test files.
  if (originalMapleRoots !== undefined) {
    process.env.MAPLE_ROOTS = originalMapleRoots;
  } else {
    delete process.env.MAPLE_ROOTS;
  }
  // Clear the slug from the in-memory cache so it doesn't leak into sibling tests.
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/xmp/batch', {
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

/** Absolute path helper for reading/writing sidecar files directly in tests. */
function rawPath(filename: string): string {
  return path.join(tmpDir, filename);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/xmp/batch', () => {
  test('returns 400 for empty entries array', async () => {
    const res = await post({ entries: [] });
    expect(res.status).toBe(400);
  });

  test('returns 400 for entries exceeding limit', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      address: addr(`img${i}.dng`),
      metadata: { city: 'Paris' },
    }));
    const res = await post({ entries });
    expect(res.status).toBe(400);
  });

  test('writes sidecar for a new file with GPS', async () => {
    const filename = 'test.dng';
    await fs.writeFile(rawPath(filename), '');

    const res = await post({
      entries: [
        {
          address: addr(filename),
          metadata: {
            gpsLatitude: 48.8566,
            gpsLongitude: 2.3522,
            city: 'Paris',
          },
        },
      ],
    });

    // Status 200 (all succeeded)
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].address).toBe(addr(filename));

    // Sidecar was written
    const sidecarPath = rawPath('test.xmp');
    const xml = await fs.readFile(sidecarPath, 'utf-8');
    const parsed = parseXmpMetadata(xml);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 3);
    expect(parsed.gpsLongitude).toBeCloseTo(2.3522, 3);
    expect(parsed.city).toBe('Paris');
  });

  test('merges metadata into existing sidecar without destroying adjustment fields', async () => {
    const filename = 'existing.dng';
    const sidecarFile = rawPath('existing.xmp');
    await fs.writeFile(rawPath(filename), '');
    await fs.writeFile(
      sidecarFile,
      `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="0.75"
   crs:HasSettings="True">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`,
    );

    const res = await post({
      entries: [{ address: addr(filename), metadata: { title: 'Summer Trip', city: 'Rome' } }],
    });

    expect(res.status).toBe(200);
    const sidecarXml = await fs.readFile(sidecarFile, 'utf-8');
    // Adjustment field preserved
    expect(sidecarXml).toContain('crs:Exposure2012="0.75"');
    // New metadata injected
    const parsed = parseXmpMetadata(sidecarXml);
    expect(parsed.title).toBe('Summer Trip');
    expect(parsed.city).toBe('Rome');
  });

  test('returns error for address with unknown slug', async () => {
    const res = await post({
      entries: [{ address: 'unknown-slug:photo.dng', metadata: { city: 'Paris' } }],
    });
    // Either 207 with ok:false
    const body = await res.json();
    const result = body.results[0];
    expect(result.ok).toBe(false);
  });

  test('handles batch of multiple entries', async () => {
    const files = ['a.dng', 'b.dng', 'c.dng'];
    await Promise.all(files.map((f) => fs.writeFile(rawPath(f), '')));

    const entries = files.map((f) => ({
      address: addr(f),
      metadata: { city: 'London' },
    }));

    const res = await post({ entries });
    const body = await res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

    // All sidecars written
    for (const f of files) {
      const xml = await fs.readFile(rawPath(f.replace('.dng', '.xmp')), 'utf-8');
      expect(parseXmpMetadata(xml).city).toBe('London');
    }
  });

  test('partial failure: bad address returns ok:false, good address returns ok:true', async () => {
    const goodFile = 'good.dng';
    await fs.writeFile(rawPath(goodFile), '');

    const res = await post({
      entries: [
        { address: 'no-such-slug:bad.dng', metadata: { city: 'Paris' } },
        { address: addr(goodFile), metadata: { city: 'London' } },
      ],
    });

    // 207 for partial failure
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[1].ok).toBe(true);
  });

  test('writes keywords bag', async () => {
    const filename = 'keywords.dng';
    await fs.writeFile(rawPath(filename), '');

    const res = await post({
      entries: [{ address: addr(filename), metadata: { keywords: ['travel', 'france'] } }],
    });

    expect(res.status).toBe(200);
    const xml = await fs.readFile(rawPath('keywords.xmp'), 'utf-8');
    const parsed = parseXmpMetadata(xml);
    expect(parsed.keywords).toEqual(['travel', 'france']);
  });

  // M5 — #1635: a video writes a metadata-only sidecar at the FULL-NAME path.
  test('video: writes full-name sidecar (clip.mov.xmp) with no CRS adjustment attrs', async () => {
    const filename = 'clip.mov';
    await fs.writeFile(rawPath(filename), '');

    const res = await post({
      entries: [
        {
          address: addr(filename),
          metadata: { gpsLatitude: 37.7749, gpsLongitude: -122.4194 },
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].ok).toBe(true);

    // Sidecar lives at clip.mov.xmp, NOT clip.xmp.
    const fullName = rawPath('clip.mov.xmp');
    const xml = await fs.readFile(fullName, 'utf-8');
    const parsed = parseXmpMetadata(xml);
    expect(parsed.gpsLatitude).toBeCloseTo(37.7749, 3);
    expect(parsed.gpsLongitude).toBeCloseTo(-122.4194, 3);
    // Metadata-only stub: no Camera Raw Settings adjustment markers.
    expect(xml).not.toContain('crs:HasSettings');
    expect(xml).not.toContain('crs:Version');
    // The stem-swap path must NOT have been created.
    await expect(fs.access(rawPath('clip.xmp'))).rejects.toThrow();
  });

  // #1614: culling fields — rating, flag, colorLabel
  describe('culling fields', () => {
    test('rating is written to the sidecar and round-trips', async () => {
      const filename = 'photo.dng';
      await fs.writeFile(rawPath(filename), '');
      const res = await post({
        entries: [{ address: addr(filename), metadata: { rating: 3 } }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ ok: boolean }> };
      expect(body.results[0]!.ok).toBe(true);
      const sidecarContent = await fs.readFile(rawPath('photo.xmp'), 'utf-8');
      expect(sidecarContent).toContain('xmp:Rating="3"');
    });

    test('flag=pick is written to the sidecar', async () => {
      const filename = 'photo2.dng';
      await fs.writeFile(rawPath(filename), '');
      const res = await post({
        entries: [{ address: addr(filename), metadata: { flag: 'pick' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(rawPath('photo2.xmp'), 'utf-8');
      expect(sidecarContent).toContain('papp:Flag="pick"');
    });

    test('colorLabel=red is written to the sidecar', async () => {
      const filename = 'photo3.dng';
      await fs.writeFile(rawPath(filename), '');
      const res = await post({
        entries: [{ address: addr(filename), metadata: { colorLabel: 'red' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(rawPath('photo3.xmp'), 'utf-8');
      expect(sidecarContent).toContain('papp:ColorLabel="red"');
    });

    // #1657: `orange` and `purple` both belong to the canonical six-color
    // vocabulary and must both be writable via the batch route.
    test.each(['orange', 'purple'] as const)(
      'colorLabel=%s is written to the sidecar',
      async (color) => {
        const filename = `photo3-${color}.dng`;
        await fs.writeFile(rawPath(filename), '');
        const res = await post({
          entries: [{ address: addr(filename), metadata: { colorLabel: color } }],
        });
        expect(res.status).toBe(200);
        const sidecarContent = await fs.readFile(rawPath(`photo3-${color}.xmp`), 'utf-8');
        expect(sidecarContent).toContain(`papp:ColorLabel="${color}"`);
      },
    );

    test('culling fields coexist with metadata fields', async () => {
      const filename = 'photo4.dng';
      await fs.writeFile(rawPath(filename), '');
      const res = await post({
        entries: [{ address: addr(filename), metadata: { rating: 5, city: 'Tokyo' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(rawPath('photo4.xmp'), 'utf-8');
      expect(sidecarContent).toContain('xmp:Rating="5"');
      expect(sidecarContent).toContain('photoshop:City="Tokyo"');
    });

    test('rating out of the 0–5 integer range is rejected by schema (not mis-stored)', async () => {
      const filename = 'photo5.dng';
      await fs.writeFile(rawPath(filename), '');
      // 7 is out of range; the 1–5 parser would otherwise silently drop it after
      // the sidecar was already written, so the schema must reject it up front.
      // Elysia returns 422 for body-schema violations (vs the route's own 400 for
      // an empty/oversized entries array).
      const res = await post({ entries: [{ address: addr(filename), metadata: { rating: 7 } }] });
      expect(res.status).toBe(422);
      // No sidecar should have been written.
      await expect(fs.access(rawPath('photo5.xmp'))).rejects.toThrow();
    });

    test('non-integer rating is rejected by schema', async () => {
      const filename = 'photo6.dng';
      await fs.writeFile(rawPath(filename), '');
      const res = await post({
        entries: [{ address: addr(filename), metadata: { rating: 2.5 } }],
      });
      expect(res.status).toBe(422);
    });
  });

  // M5 — #1635: a Live Photo's still and clip never clobber each other.
  test('Live Photo: editing the clip leaves the same-stem still sidecar untouched', async () => {
    const stillFile = rawPath('IMG_1234.heic');
    const stillSidecar = rawPath('IMG_1234.xmp');
    const clipFilename = 'IMG_1234.mov';
    await fs.writeFile(stillFile, '');
    // Pre-existing photo sidecar carrying a pixel adjustment.
    await fs.writeFile(
      stillSidecar,
      `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Exposure2012="0.5"
   crs:HasSettings="True">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`,
    );
    await fs.writeFile(rawPath(clipFilename), '');

    const res = await post({
      entries: [{ address: addr(clipFilename), metadata: { city: 'San Francisco' } }],
    });
    expect(res.status).toBe(200);

    // The still's sidecar is byte-for-byte untouched.
    const stillXml = await fs.readFile(stillSidecar, 'utf-8');
    expect(stillXml).toContain('crs:Exposure2012="0.5"');
    expect(parseXmpMetadata(stillXml).city).toBeUndefined();

    // The clip got its OWN sidecar with the new metadata.
    const clipXml = await fs.readFile(rawPath('IMG_1234.mov.xmp'), 'utf-8');
    expect(parseXmpMetadata(clipXml).city).toBe('San Francisco');
  });
});
