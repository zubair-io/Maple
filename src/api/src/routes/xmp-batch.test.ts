/**
 * Integration tests for POST /api/xmp/batch.
 *
 * Uses a real temp directory for sidecar files. MongoDB calls from
 * markSidecarMetadataIndexDirty are allowed to fail (they're best-effort),
 * so we don't need a live Mongo for the core sidecar-write path.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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
// Temp dir setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const originalMapleRoots = process.env.MAPLE_ROOTS;

beforeEach(async () => {
  // realpath the temp dir: on macOS os.tmpdir() is under /var → /private/var
  // symlink, and writeXmpAtomic realpaths before its root check, so an
  // un-realpath'd MAPLE_ROOTS would look "outside" the registered root.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-batch-test-')));
  process.env.MAPLE_ROOTS = tmpDir;
});

afterEach(async () => {
  if (originalMapleRoots !== undefined) {
    process.env.MAPLE_ROOTS = originalMapleRoots;
  } else {
    delete process.env.MAPLE_ROOTS;
  }
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
      path: rawPath(`img${i}.dng`),
      metadata: { city: 'Paris' },
    }));
    const res = await post({ entries });
    expect(res.status).toBe(400);
  });

  test('writes sidecar for a new file with GPS', async () => {
    const rawFile = rawPath('test.dng');
    await fs.writeFile(rawFile, '');

    const res = await post({
      entries: [
        {
          path: rawFile,
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

    // Sidecar was written
    const sidecarPath = rawPath('test.xmp');
    const xml = await fs.readFile(sidecarPath, 'utf-8');
    const parsed = parseXmpMetadata(xml);
    expect(parsed.gpsLatitude).toBeCloseTo(48.8566, 3);
    expect(parsed.gpsLongitude).toBeCloseTo(2.3522, 3);
    expect(parsed.city).toBe('Paris');
  });

  test('merges metadata into existing sidecar without destroying adjustment fields', async () => {
    const rawFile = rawPath('existing.dng');
    const sidecarFile = rawPath('existing.xmp');
    await fs.writeFile(rawFile, '');
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
      entries: [{ path: rawFile, metadata: { title: 'Summer Trip', city: 'Rome' } }],
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

  test('returns 403 for path outside library root', async () => {
    const res = await post({
      entries: [{ path: '/etc/passwd', metadata: { city: 'Paris' } }],
    });
    // Either 207 with ok:false or 200 with ok:false for that entry
    const body = await res.json();
    const result = body.results[0];
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not inside|cannot authorise/i);
  });

  test('handles batch of multiple entries', async () => {
    const files = ['a.dng', 'b.dng', 'c.dng'];
    await Promise.all(files.map((f) => fs.writeFile(rawPath(f), '')));

    const entries = files.map((f) => ({
      path: rawPath(f),
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

  test('partial failure: bad path returns ok:false, good path returns ok:true', async () => {
    const goodFile = rawPath('good.dng');
    await fs.writeFile(goodFile, '');

    const res = await post({
      entries: [
        { path: '/outside/the/root/bad.dng', metadata: { city: 'Paris' } },
        { path: goodFile, metadata: { city: 'London' } },
      ],
    });

    // 207 for partial failure
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.results[0].ok).toBe(false);
    expect(body.results[1].ok).toBe(true);
  });

  test('writes keywords bag', async () => {
    const rawFile = rawPath('keywords.dng');
    await fs.writeFile(rawFile, '');

    const res = await post({
      entries: [{ path: rawFile, metadata: { keywords: ['travel', 'france'] } }],
    });

    expect(res.status).toBe(200);
    const xml = await fs.readFile(rawPath('keywords.xmp'), 'utf-8');
    const parsed = parseXmpMetadata(xml);
    expect(parsed.keywords).toEqual(['travel', 'france']);
  });

  // M5 — #1635: a video writes a metadata-only sidecar at the FULL-NAME path.
  test('video: writes full-name sidecar (clip.mov.xmp) with no CRS adjustment attrs', async () => {
    const videoFile = rawPath('clip.mov');
    await fs.writeFile(videoFile, '');

    const res = await post({
      entries: [
        {
          path: videoFile,
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
      const raw = rawPath('photo.dng');
      await fs.writeFile(raw, '');
      const res = await post({
        entries: [{ path: raw, metadata: { rating: 3 } }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ ok: boolean }> };
      expect(body.results[0]!.ok).toBe(true);
      const sidecarContent = await fs.readFile(raw.replace('.dng', '.xmp'), 'utf-8');
      expect(sidecarContent).toContain('xmp:Rating="3"');
    });

    test('flag=pick is written to the sidecar', async () => {
      const raw = rawPath('photo2.dng');
      await fs.writeFile(raw, '');
      const res = await post({
        entries: [{ path: raw, metadata: { flag: 'pick' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(raw.replace('.dng', '.xmp'), 'utf-8');
      expect(sidecarContent).toContain('papp:Flag="pick"');
    });

    test('colorLabel=red is written to the sidecar', async () => {
      const raw = rawPath('photo3.dng');
      await fs.writeFile(raw, '');
      const res = await post({
        entries: [{ path: raw, metadata: { colorLabel: 'red' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(raw.replace('.dng', '.xmp'), 'utf-8');
      expect(sidecarContent).toContain('papp:ColorLabel="red"');
    });

    test('culling fields coexist with metadata fields', async () => {
      const raw = rawPath('photo4.dng');
      await fs.writeFile(raw, '');
      const res = await post({
        entries: [{ path: raw, metadata: { rating: 5, city: 'Tokyo' } }],
      });
      expect(res.status).toBe(200);
      const sidecarContent = await fs.readFile(raw.replace('.dng', '.xmp'), 'utf-8');
      expect(sidecarContent).toContain('xmp:Rating="5"');
      expect(sidecarContent).toContain('photoshop:City="Tokyo"');
    });

    test('rating out of the 0–5 integer range is rejected by schema (not mis-stored)', async () => {
      const raw = rawPath('photo5.dng');
      await fs.writeFile(raw, '');
      // 7 is out of range; the 1–5 parser would otherwise silently drop it after
      // the sidecar was already written, so the schema must reject it up front.
      // Elysia returns 422 for body-schema violations (vs the route's own 400 for
      // an empty/oversized entries array).
      const res = await post({ entries: [{ path: raw, metadata: { rating: 7 } }] });
      expect(res.status).toBe(422);
      // No sidecar should have been written.
      await expect(fs.access(raw.replace('.dng', '.xmp'))).rejects.toThrow();
    });

    test('non-integer rating is rejected by schema', async () => {
      const raw = rawPath('photo6.dng');
      await fs.writeFile(raw, '');
      const res = await post({ entries: [{ path: raw, metadata: { rating: 2.5 } }] });
      expect(res.status).toBe(422);
    });
  });

  // M5 — #1635: a Live Photo's still and clip never clobber each other.
  test('Live Photo: editing the clip leaves the same-stem still sidecar untouched', async () => {
    const stillFile = rawPath('IMG_1234.heic');
    const stillSidecar = rawPath('IMG_1234.xmp');
    const clipFile = rawPath('IMG_1234.mov');
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
    await fs.writeFile(clipFile, '');

    const res = await post({
      entries: [{ path: clipFile, metadata: { city: 'San Francisco' } }],
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
