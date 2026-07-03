/**
 * Unit tests for the sidecar-metadata-index stage handler.
 *
 * Uses `setLibraryRootsForTests` + a real temp directory for sidecars
 * so the handler runs real fs calls without needing MongoDB.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ObjectId } from 'mongodb';
import {
  sidecarMetadataIndexHandler,
  SIDECAR_METADATA_INDEX_VERSION,
} from './sidecar-metadata-index.ts';
import type { ImageDoc } from '../run-stage.ts';
import type { StageContext } from '../stage-config.ts';
import type { Logger } from 'pino';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';

// Isolate the shared db-client singleton to a unique test DB and reset it
// around this file so any incidental Mongo touch neither hits the real `maple`
// DB nor leaks the connection into later test files (convention from
// folder.test.ts / imports/repo.test.ts).
process.env.MAPLE_MONGO_DB = `maple_test_override_ingest_${process.pid}`;
beforeAll(async () => {
  await (await import('../../db/client.ts')).closeDb();
});
afterAll(async () => {
  await (await import('../../db/client.ts')).closeDb();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_LIB_ID = 'aabbccddeeff001122334455';

const fakeCtx: StageContext = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => fakeCtx.log,
  } as unknown as Logger,
  signal: new AbortController().signal,
};

function makeImage(overrides: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
    fileinfo: [
      {
        path: '',
        filename: 'test.dng',
        library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
      },
    ],
    size: 1000,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    stages: {
      'sidecar-metadata-index': {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
    },
    ...overrides,
  };
}

function makeXmp(attrs: string, nested = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:papp="https://justmaple.app/ns/1.0/"
   ${attrs}>
${nested}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-metadata-index-test-'));
  // Wire the library cache to point FAKE_LIB_ID → tmpDir.
  setLibraryRootsForTests(new Map([[FAKE_LIB_ID, tmpDir]]));
});

afterEach(async () => {
  setLibraryRootsForTests(null); // reset to lazy-load
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSidecar(xmpContent: string): Promise<ImageDoc> {
  const rawFile = path.join(tmpDir, 'test.dng');
  const sidecarFile = path.join(tmpDir, 'test.xmp');
  await fs.writeFile(rawFile, '');
  await fs.writeFile(sidecarFile, xmpContent, 'utf-8');
  return makeImage();
}

/** Write a video file + its full-name sidecar (`clip.mov.xmp`) and return an
 *  ImageDoc pointing at the video. Videos use the full-name convention so a
 *  Live Photo's motion clip never clobbers the same-stem still's `.xmp`. */
async function writeVideoSidecar(xmpContent: string): Promise<ImageDoc> {
  const videoFile = path.join(tmpDir, 'clip.mov');
  const sidecarFile = path.join(tmpDir, 'clip.mov.xmp');
  await fs.writeFile(videoFile, '');
  await fs.writeFile(sidecarFile, xmpContent, 'utf-8');
  return makeImage({
    fileinfo: [
      {
        path: '',
        filename: 'clip.mov',
        library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Skip paths
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — skip paths', () => {
  test('skip: no-sidecar when sidecar does not exist', async () => {
    const rawFile = path.join(tmpDir, 'test.dng');
    await fs.writeFile(rawFile, '');
    const image = makeImage();
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-sidecar');
  });

  test('skip: no-metadata when sidecar has only adjustment fields', async () => {
    const xml = makeXmp('crs:Exposure2012="0.5" crs:Contrast2012="0"');
    const image = await writeSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-metadata');
  });

  test('does not skip a missing-flagged file (ignores missing_since, prefers live entry)', async () => {
    // writeSidecar creates test.dng and test.xmp under tmpDir, and returns an ImageDoc
    // with fileinfo pointing to test.dng (primary).
    const image = await writeSidecar(
      makeXmp(
        'photoshop:City="Berkeley" photoshop:State="California" photoshop:Country="United States"',
      ),
    );

    // Add a second entry to fileinfo which is flagged as missing and points to a non-existent file.
    // Place it FIRST in the array to test that the locator bypasses it in favor of the live one.
    image.fileinfo!.unshift({
      path: '',
      filename: 'nonexistent.dng',
      library_id: image.fileinfo![0].library_id,
      missing_since: '2026-06-30T00:00:00.000Z',
    });

    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).not.toEqual({ skip: 'no-path' });
    expect('patch' in result).toBe(true);
    if ('patch' in result) {
      expect(result.patch.metadata_override?.place_text?.city).toBe('Berkeley');
    }
  });

  test('does not skip when only missing entries exist', async () => {
    const image = await writeSidecar(
      makeXmp(
        'photoshop:City="Berkeley" photoshop:State="California" photoshop:Country="United States"',
      ),
    );
    // Mark the only entry as missing
    image.fileinfo![0].missing_since = '2026-06-30T00:00:00.000Z';

    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).not.toEqual({ skip: 'no-path' });
    expect('patch' in result).toBe(true);
    if ('patch' in result) {
      expect(result.patch.metadata_override?.place_text?.city).toBe('Berkeley');
    }
  });
});

// ---------------------------------------------------------------------------
// Patch paths
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — patch path', () => {
  test('returns patch with metadata_override when GPS present', async () => {
    const xml = makeXmp('exif:GPSLatitude="48,31.4360N" exif:GPSLongitude="2,21.0480E"');
    const image = await writeSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    const override = patch['metadata_override'] as Record<string, unknown>;
    expect(override).toBeDefined();
    expect(override['gps']).toMatchObject({
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
    expect(Array.isArray(override['touched_fields'])).toBe(true);
    expect((override['touched_fields'] as string[]).includes('gps')).toBe(true);
    expect(typeof override['edited_at']).toBe('string');
  });

  test('patch includes captured_year/month when DateTimeOriginal present', async () => {
    // 2026-06-26T18:40:00+02:00 → UTC 2026-06-26T16:40:00Z → year=2026, month=6
    const xml = makeXmp('exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"');
    const image = await writeSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    // Derived year/month live in metadata_override, NOT exif.* (immutable).
    expect(patch['exif.captured_year']).toBeUndefined();
    const override = patch['metadata_override'] as Record<string, unknown>;
    expect(override['captured_year']).toBe(2026);
    expect(override['captured_month']).toBe(6);
  });

  test('does not include year/month in patch when no captured_at in sidecar or exif', async () => {
    const xml = makeXmp('photoshop:City="Paris"');
    const image = await writeSidecar(xml);
    // No exif on the image doc
    (image as Partial<ImageDoc>).exif = null;
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    // year/month not set when no captured_at available (and never under exif.*)
    expect(patch['exif.captured_year']).toBeUndefined();
    const override = patch['metadata_override'] as Record<string, unknown>;
    expect(override['captured_year']).toBeUndefined();
    expect(override['captured_month']).toBeUndefined();
  });

  test('patch includes place_text when IPTC attrs present', async () => {
    const xml = makeXmp('photoshop:City="Paris" photoshop:Country="France"');
    const image = await writeSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const override = (result.patch as Record<string, unknown>)['metadata_override'] as Record<
      string,
      unknown
    >;
    expect(override['place_text']).toMatchObject({
      city: 'Paris',
      country: 'France',
    });
  });

  test('patch includes nested title from lang-alt block', async () => {
    const xml = makeXmp(
      '',
      `  <dc:title>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">My Vacation</rdf:li>
   </rdf:Alt>
  </dc:title>`,
    );
    const image = await writeSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const override = (result.patch as Record<string, unknown>)['metadata_override'] as Record<
      string,
      unknown
    >;
    expect(override['title']).toBe('My Vacation');
  });

  test('falls back to exif.captured_at for year/month when sidecar has no captured_at', async () => {
    const xml = makeXmp('photoshop:City="Paris"');
    const image = await writeSidecar(xml);
    image.exif = {
      captured_at: '2025-03-15T10:00:00Z',
      captured_year: 2025,
      captured_month: 3,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    };
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect(patch['exif.captured_year']).toBeUndefined();
    const override = patch['metadata_override'] as Record<string, unknown>;
    expect(override['captured_year']).toBe(2025);
    expect(override['captured_month']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Video passthrough (M5 — #1635)
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — video assets (M5)', () => {
  test('video asset with metadata-only sidecar returns metadata_override patch', async () => {
    // A metadata-only sidecar has no CRS/papp adjustment attrs — just metadata.
    const xml = makeXmp('exif:GPSLatitude="37,46.4940N" exif:GPSLongitude="122,25.1640W"');
    const image = await writeVideoSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const override = (result.patch as Record<string, unknown>)['metadata_override'] as Record<
      string,
      unknown
    >;
    expect(override).toBeDefined();
    expect(override['gps']).toMatchObject({
      lat: expect.any(Number),
      lng: expect.any(Number),
    });
    expect((override['touched_fields'] as string[]).includes('gps')).toBe(true);
  });

  test('video asset with no sidecar returns { skip: no-sidecar }', async () => {
    const videoFile = path.join(tmpDir, 'clip.mov');
    await fs.writeFile(videoFile, '');
    const image = makeImage({
      fileinfo: [
        {
          path: '',
          filename: 'clip.mov',
          library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
        },
      ],
    });
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-sidecar');
  });

  test('video asset with adjustment-only sidecar returns { skip: no-metadata }', async () => {
    // Even if a tool writes CRS attrs to a video sidecar, the stage should skip gracefully.
    const xml = makeXmp('crs:Exposure2012="0.5" crs:Contrast2012="0"');
    const image = await writeVideoSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-metadata');
  });

  test('video asset sidecar with IPTC place text produces correct place_text patch', async () => {
    const xml = makeXmp('photoshop:City="San Francisco" photoshop:Country="United States"');
    const image = await writeVideoSidecar(xml);
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const override = (result.patch as Record<string, unknown>)['metadata_override'] as Record<
      string,
      unknown
    >;
    expect(override['place_text']).toMatchObject({
      city: 'San Francisco',
      country: 'United States',
    });
  });
});

// ---------------------------------------------------------------------------
// Culling projection
// ---------------------------------------------------------------------------

describe('culling projection', () => {
  test('rating in sidecar is projected to metadata_override and top-level', async () => {
    const image = await writeSidecar(
      makeXmp('xmp:Rating="4" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect((patch['metadata_override'] as Record<string, unknown>)['rating']).toBe(4);
    expect(patch['rating']).toBe(4);
  });

  test('flag=pick in sidecar is projected to metadata_override and top-level (flag=1)', async () => {
    const image = await writeSidecar(
      makeXmp('papp:Flag="pick" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect((patch['metadata_override'] as Record<string, unknown>)['flag']).toBe('pick');
    expect(patch['flag']).toBe(1);
  });

  test('flag=reject in sidecar is projected to metadata_override and top-level (flag=-1)', async () => {
    const image = await writeSidecar(
      makeXmp('papp:Flag="reject" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect((patch['metadata_override'] as Record<string, unknown>)['flag']).toBe('reject');
    expect(patch['flag']).toBe(-1);
  });

  test('cleared culling overwrites stale top-level rating/flag with defaults', async () => {
    // Asset previously had flag=pick (1) and rating=5; the sidecar now carries
    // other metadata (a city) but NO culling attrs — the user cleared them. The
    // sidecar is authoritative, so the projection must reset the stale top-level
    // values to the insert defaults (rating 0, flag 0), not leave them in place.
    const rawFile = path.join(tmpDir, 'test.dng');
    const sidecarFile = path.join(tmpDir, 'test.xmp');
    await fs.writeFile(rawFile, '');
    await fs.writeFile(sidecarFile, makeXmp('photoshop:City="Berlin"'), 'utf-8');
    const image = makeImage({ rating: 5, flag: 1 });

    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    // metadata_override carries only the present (non-culling) field…
    const override = patch['metadata_override'] as Record<string, unknown>;
    expect(override['rating']).toBeUndefined();
    expect(override['flag']).toBeUndefined();
    // …but the top-level projection resets the stale values to cleared defaults.
    expect(patch['rating']).toBe(0);
    expect(patch['flag']).toBe(0);
    expect(patch['color_label']).toBe('');
  });

  test('isScreenshot=true in sidecar is projected to metadata_override and top-level', async () => {
    const image = await writeSidecar(
      makeXmp('papp:IsScreenshot="true" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect((patch['metadata_override'] as Record<string, unknown>)['is_screenshot']).toBe(true);
    expect(patch['is_screenshot']).toBe(true);
  });

  test('isScreenshot=false in sidecar is projected to metadata_override and top-level', async () => {
    const image = await writeSidecar(
      makeXmp('papp:IsScreenshot="false" xmlns:papp="http://ns.justmaple.app/photo/1.0/"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('patch');
    if (!('patch' in result)) throw new Error('Expected patch result');
    const patch = result.patch as Record<string, unknown>;
    expect((patch['metadata_override'] as Record<string, unknown>)['is_screenshot']).toBe(false);
    expect(patch['is_screenshot']).toBe(false);
  });

  test('absent isScreenshot in sidecar reverts to native is_screenshot (false for photo, true for screenshot)', async () => {
    // 1. Photo case: sidecar test.xmp exists with metadata, has no isScreenshot
    const rawPhoto = path.join(tmpDir, 'test.dng');
    const sidecarPhoto = path.join(tmpDir, 'test.xmp');
    await fs.writeFile(rawPhoto, '');
    await fs.writeFile(sidecarPhoto, makeXmp('photoshop:City="Berlin"'), 'utf-8');

    const photoImage = makeImage({ is_screenshot: true });
    const resultPhoto = await sidecarMetadataIndexHandler(photoImage, fakeCtx);
    expect(resultPhoto).toHaveProperty('patch');
    if (!('patch' in resultPhoto)) throw new Error('Expected patch result');
    const patchPhoto = resultPhoto.patch as Record<string, unknown>;
    expect(patchPhoto['is_screenshot']).toBe(false);

    // 2. Screenshot case: sidecar Screenshot_123.xmp exists with metadata, has no isScreenshot
    const rawScreenshot = path.join(tmpDir, 'Screenshot_123.png');
    const sidecarScreenshot = path.join(tmpDir, 'Screenshot_123.xmp');
    await fs.writeFile(rawScreenshot, '');
    await fs.writeFile(sidecarScreenshot, makeXmp('photoshop:City="Berlin"'), 'utf-8');

    const screenshotImage = makeImage({
      is_screenshot: false,
      fileinfo: [
        {
          path: '',
          filename: 'Screenshot_123.png',
          library_id: { toHexString: () => FAKE_LIB_ID } as unknown as ObjectId,
        },
      ],
    });
    const resultScreenshot = await sidecarMetadataIndexHandler(screenshotImage, fakeCtx);
    expect(resultScreenshot).toHaveProperty('patch');
    if (!('patch' in resultScreenshot)) throw new Error('Expected patch result');
    const patchScreenshot = resultScreenshot.patch as Record<string, unknown>;
    expect(patchScreenshot['is_screenshot']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

describe('SIDECAR_METADATA_INDEX_VERSION', () => {
  test('is a positive integer', () => {
    expect(Number.isInteger(SIDECAR_METADATA_INDEX_VERSION)).toBe(true);
    expect(SIDECAR_METADATA_INDEX_VERSION).toBeGreaterThan(0);
  });
});
