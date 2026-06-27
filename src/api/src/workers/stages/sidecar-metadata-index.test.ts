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
import type { ObjectId } from 'mongodb';
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
    expect(override['gps']).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
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
    expect(override['place_text']).toMatchObject({ city: 'Paris', country: 'France' });
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
// Version constant
// ---------------------------------------------------------------------------

describe('SIDECAR_METADATA_INDEX_VERSION', () => {
  test('is a positive integer', () => {
    expect(Number.isInteger(SIDECAR_METADATA_INDEX_VERSION)).toBe(true);
    expect(SIDECAR_METADATA_INDEX_VERSION).toBeGreaterThan(0);
  });
});
