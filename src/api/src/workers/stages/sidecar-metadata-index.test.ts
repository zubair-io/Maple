/**
 * Unit tests for the sidecar-metadata-index stage handler: what it skips, what
 * it puts in `metadata_override`, and which downstream stages it re-arms.
 *
 * Real fs calls against a temp directory and no database at all. That is now
 * true of the handler as well as of this file: its two downstream stage re-arms
 * used to be `updateOne` calls it issued itself, and are declared as
 * `invalidates` for the runner to commit with the stage's own success row
 * (#3787).
 *
 * The projection onto the asset row — rating, flag, colour label, the
 * `is_screenshot` tri-state and visibility — lives in
 * `sidecar-metadata-index.projection.test.ts`, split out for the file budget.
 * Fixtures shared by both are in `sidecar-metadata-index.test-helpers.ts`.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import {
  sidecarMetadataIndexHandler,
  SIDECAR_METADATA_INDEX_VERSION,
} from './sidecar-metadata-index.ts';
import type { ImageDoc } from '../run-stage.ts';
import {
  FAKE_LIB_ID,
  fakeCtx,
  invalidatesOf,
  makeImage,
  makeXmp,
  useTempLibrary,
  writeSidecar,
  writeVideoSidecar,
  written,
} from './sidecar-metadata-index.test-helpers.ts';

const library = useTempLibrary();

// ---------------------------------------------------------------------------
// Skip paths
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — skip paths', () => {
  test('skip: no-sidecar when sidecar does not exist', async () => {
    await fs.writeFile(path.join(library.dir, 'test.dng'), '');
    const result = await sidecarMetadataIndexHandler(makeImage(), fakeCtx);
    expect(result).toHaveProperty('skip', 'no-sidecar');
  });

  test('skip: no-metadata when sidecar has only adjustment fields', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('crs:Exposure2012="0.5" crs:Contrast2012="0"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-metadata');
  });

  test('does not skip a missing-flagged file (ignores missing_since, prefers live entry)', async () => {
    const image = await writeSidecar(
      library,
      makeXmp(
        'photoshop:City="Berkeley" photoshop:State="California" photoshop:Country="United States"',
      ),
    );

    // Add a second entry to fileinfo which is flagged as missing and points to a
    // non-existent file. Place it FIRST to test that the locator bypasses it in
    // favour of the live one.
    image.fileinfo!.unshift({
      path: '',
      filename: 'nonexistent.dng',
      library_id: image.fileinfo![0].library_id,
      missing_since: '2026-06-30T00:00:00.000Z',
    });

    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect((override['place_text'] as { city?: string })?.city).toBe('Berkeley');
  });

  test('does not skip when only missing entries exist', async () => {
    const image = await writeSidecar(
      library,
      makeXmp(
        'photoshop:City="Berkeley" photoshop:State="California" photoshop:Country="United States"',
      ),
    );
    image.fileinfo![0].missing_since = '2026-06-30T00:00:00.000Z';

    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect((override['place_text'] as { city?: string })?.city).toBe('Berkeley');
  });
});

// ---------------------------------------------------------------------------
// Patch paths
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — patch path', () => {
  test('returns patch with metadata_override when GPS present', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('exif:GPSLatitude="48,31.4360N" exif:GPSLongitude="2,21.0480E"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);

    expect(invalidatesOf(result)).toContain('meili');
    const { override } = written(result);
    expect(override['gps']).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    expect(Array.isArray(override['touched_fields'])).toBe(true);
    expect((override['touched_fields'] as string[]).includes('gps')).toBe(true);
    expect(typeof override['edited_at']).toBe('string');
  });

  test('patch includes captured_year/month when DateTimeOriginal present', async () => {
    // 2026-06-26T18:40:00+02:00 → UTC 2026-06-26T16:40:00Z → year=2026, month=6
    const image = await writeSidecar(
      library,
      makeXmp('exif:DateTimeOriginal="2026-06-26T18:40:00+02:00"'),
    );
    // Derived year/month live in metadata_override; `exif` is the immutable
    // file-original and is never a column this stage writes.
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(columns['exif']).toBeUndefined();
    expect(override['captured_year']).toBe(2026);
    expect(override['captured_month']).toBe(6);
  });

  test('does not include year/month in patch when no captured_at in sidecar or exif', async () => {
    const image = await writeSidecar(library, makeXmp('photoshop:City="Paris"'));
    (image as Partial<ImageDoc>).exif = null;
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(columns['exif']).toBeUndefined();
    expect(override['captured_year']).toBeUndefined();
    expect(override['captured_month']).toBeUndefined();
  });

  test('patch includes place_text when IPTC attrs present', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('photoshop:City="Paris" photoshop:Country="France"'),
    );
    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['place_text']).toMatchObject({ city: 'Paris', country: 'France' });
  });

  test('patch includes nested title from lang-alt block', async () => {
    const image = await writeSidecar(
      library,
      makeXmp(
        '',
        `  <dc:title>
   <rdf:Alt>
    <rdf:li xml:lang="x-default">My Vacation</rdf:li>
   </rdf:Alt>
  </dc:title>`,
      ),
    );
    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['title']).toBe('My Vacation');
  });

  test('falls back to exif.captured_at for year/month when sidecar has no captured_at', async () => {
    const image = await writeSidecar(library, makeXmp('photoshop:City="Paris"'));
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
      camera_serial: null,
    };
    const { columns, override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(columns['exif']).toBeUndefined();
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
    const image = await writeVideoSidecar(
      library,
      makeXmp('exif:GPSLatitude="37,46.4940N" exif:GPSLongitude="122,25.1640W"'),
    );
    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['gps']).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
    expect((override['touched_fields'] as string[]).includes('gps')).toBe(true);
  });

  test('video asset with no sidecar returns { skip: no-sidecar }', async () => {
    await fs.writeFile(path.join(library.dir, 'clip.mov'), '');
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
    const image = await writeVideoSidecar(
      library,
      makeXmp('crs:Exposure2012="0.5" crs:Contrast2012="0"'),
    );
    const result = await sidecarMetadataIndexHandler(image, fakeCtx);
    expect(result).toHaveProperty('skip', 'no-metadata');
  });

  test('video asset sidecar with IPTC place text produces correct place_text patch', async () => {
    const image = await writeVideoSidecar(
      library,
      makeXmp('photoshop:City="San Francisco" photoshop:Country="United States"'),
    );
    const { override } = written(await sidecarMetadataIndexHandler(image, fakeCtx));
    expect(override['place_text']).toMatchObject({
      city: 'San Francisco',
      country: 'United States',
    });
  });
});

// ---------------------------------------------------------------------------
// Downstream re-arms
// ---------------------------------------------------------------------------

describe('sidecarMetadataIndexHandler — downstream re-arms', () => {
  test('re-arms only the search index when nothing else changed', async () => {
    const image = await writeSidecar(library, makeXmp('photoshop:City="Paris"'));
    expect(invalidatesOf(await sidecarMetadataIndexHandler(image, fakeCtx))).toEqual(['meili']);
  });

  test('re-arms geocode when the sidecar moved the coordinates', async () => {
    // The re-arm travels back with the patch rather than being written
    // separately, so the stored coordinates and "geocode must run again"
    // cannot land apart from one another.
    const image = await writeSidecar(
      library,
      makeXmp('exif:GPSLatitude="48,31.4360N" exif:GPSLongitude="2,21.0480E"'),
    );
    expect(invalidatesOf(await sidecarMetadataIndexHandler(image, fakeCtx))).toContain('geocode');
  });

  test('leaves geocode alone when the coordinates are unchanged', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('exif:GPSLatitude="48,31.4360N" exif:GPSLongitude="2,21.0480E"'),
    );
    const first = await sidecarMetadataIndexHandler(image, fakeCtx);
    // Feed the stored override back in, as a second poll of an unchanged
    // sidecar would: the coordinates match, so there is nothing to re-geocode.
    const unchanged = {
      ...image,
      metadata_override: written(first).override,
    } as unknown as ImageDoc;
    expect(invalidatesOf(await sidecarMetadataIndexHandler(unchanged, fakeCtx))).not.toContain(
      'geocode',
    );
  });

  test('re-arms cf-thumb-sync when the asset is un-hidden', async () => {
    // cf-thumb-sync marks a hidden asset permanently handled with its own
    // `{ skip: 'hidden' }`, so becoming visible again has to put it back in the
    // queue or the thumbnail never reaches the edge cache.
    const image = await writeSidecar(
      library,
      makeXmp('papp:Hidden="false" photoshop:City="Paris"', ''),
    );
    image.hidden = true;
    expect(invalidatesOf(await sidecarMetadataIndexHandler(image, fakeCtx))).toContain(
      'cf-thumb-sync',
    );
  });

  test('leaves cf-thumb-sync alone for an asset that was already visible', async () => {
    const image = await writeSidecar(
      library,
      makeXmp('papp:Hidden="false" photoshop:City="Paris"', ''),
    );
    expect(invalidatesOf(await sidecarMetadataIndexHandler(image, fakeCtx))).not.toContain(
      'cf-thumb-sync',
    );
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
