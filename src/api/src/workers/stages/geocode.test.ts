import { describe, it, expect, afterEach } from 'bun:test';
import { ObjectId } from '../../db/object-id.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { CoordinateCache } from '../../enrichment/coordinate-cache.ts';
import { NominatimClient, NominatimError } from '../../enrichment/nominatim-client.ts';

import geocodeStage, { geocodeHandler, setGeocodeDepsForTests } from './geocode.ts';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';

/**
 * The place the handler asked the runner to write, read back out of the
 * statement's bound JSON.
 *
 * The patch is a list of statements now rather than a map of document fields,
 * so the assertions decode bound parameters instead of reading properties.
 */
function patchedPlace(result: StageResult): Record<string, unknown> {
  if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  const statement = result.patch.find((candidate) => candidate.sql.includes('place = json(?)'));
  if (statement === undefined) throw new Error('expected a place statement in the patch');
  return JSON.parse((statement.params as string[])[0]!) as Record<string, unknown>;
}

/** True when the patch also re-queues the asset for the refile-backups pass. */
function resetsBackupLayout(result: StageResult): boolean {
  if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  return result.patch.some((statement) => statement.sql.includes('backup_layout_version = ?'));
}

function fakeDoc(gps: { lat: number; lng: number } | null = { lat: 42.65, lng: -73.75 }): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: 'test.dng',
    abs_path: '/lib/test.dng',
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: '2024-06-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps,
      camera_serial: null,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as ImageDoc;
}

const MUSEUM_RESPONSE = {
  address: { city: 'Albany', state: 'New York', country_code: 'us' },
  display_name: 'Test Museum, Albany',
  category: 'tourism',
  type: 'museum',
  name: 'Test Museum',
};

function fakeNominatim(body: unknown): NominatimClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: 'http://nominatim.test',
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

function errorNominatim(status: number): NominatimClient {
  const fetchImpl = (async () => new Response('{}', { status })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: 'http://nominatim.test',
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

// Use a unique geocoderVersion per call so a cache row written by an earlier
// test can never answer a later one: each test must see cold-cache behaviour on
// first access. The rows themselves live in the per-test database installed by
// `createLiveTestDatabase`, which the handler reaches with no override.
let versionCounter = Date.now();
function freshCache(): CoordinateCache {
  return new CoordinateCache({ geocoderVersion: ++versionCounter });
}

const fakeCtx = {} as never;

afterEach(() => {
  setGeocodeDepsForTests(null);
});

describe('geocodeHandler — happy path', () => {
  it('returns patch with place populated from Nominatim response', async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc();
    setGeocodeDepsForTests({ client: fakeNominatim(MUSEUM_RESPONSE), cache: freshCache() });
    const result = await geocodeHandler(doc, fakeCtx);
    const place = patchedPlace(result);
    expect(place.display_name).toBe('Test Museum, Albany');
    expect(typeof place.search_blob).toBe('string');
    expect(place.lat).toBe(42.65);
    expect(place.lon).toBe(-73.75);
    expect((result as { invalidates?: string[] }).invalidates).toContain('meili');
  });

  it('uses cached place on second call for same coordinates', async () => {
    using _live = await createLiveTestDatabase();
    const cache = freshCache();
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify(MUSEUM_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new NominatimClient({
      baseUrl: 'http://nominatim.test',
      fetchImpl,
      rateLimitPerSec: 1000,
    });
    setGeocodeDepsForTests({ client, cache });
    await geocodeHandler(fakeDoc(), fakeCtx);
    await geocodeHandler(fakeDoc(), fakeCtx);
    expect(callCount).toBe(1);
  });

  it('returns skip when image has no GPS', async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc(null);
    setGeocodeDepsForTests({ client: fakeNominatim(MUSEUM_RESPONSE), cache: freshCache() });
    const result = await geocodeHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBeTruthy();
  });
});

describe('geocodeHandler — Nominatim errors', () => {
  it('5xx propagates as NominatimError (retryable)', async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc();
    setGeocodeDepsForTests({ client: errorNominatim(503), cache: freshCache() });
    await expect(geocodeHandler(doc, fakeCtx)).rejects.toBeInstanceOf(NominatimError);
  });

  it('4xx propagates as NominatimError (non-retryable)', async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc();
    setGeocodeDepsForTests({ client: errorNominatim(400), cache: freshCache() });
    await expect(geocodeHandler(doc, fakeCtx)).rejects.toBeInstanceOf(NominatimError);
  });
});

describe('geocodeHandler — lat/lon provenance', () => {
  it("place.lat/lon are taken from the asset's EXIF, not Nominatim response", async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc({ lat: 42.65, lng: -73.75 });
    const bodyWithDifferentCoords = { ...MUSEUM_RESPONSE, lat: '99.9', lon: '99.9' };
    setGeocodeDepsForTests({ client: fakeNominatim(bodyWithDifferentCoords), cache: freshCache() });
    const result = await geocodeHandler(doc, fakeCtx);
    const place = patchedPlace(result);
    expect(place.lat).toBe(42.65);
    expect(place.lon).toBe(-73.75);
  });
});

describe('geocodeHandler — refile re-trigger (#1525)', () => {
  it('resets backup_layout_version when geocoding adds a place (folder changes)', async () => {
    using _live = await createLiveTestDatabase();
    const doc = fakeDoc(); // place: null
    setGeocodeDepsForTests({ client: fakeNominatim(MUSEUM_RESPONSE), cache: freshCache() });
    const result = await geocodeHandler(doc, fakeCtx);
    expect(patchedPlace(result)).toBeTruthy();
    expect(resetsBackupLayout(result)).toBe(true);
  });

  it('does NOT reset backup_layout_version when the folder is unchanged', async () => {
    using _live = await createLiveTestDatabase();
    const cache = freshCache();
    setGeocodeDepsForTests({ client: fakeNominatim(MUSEUM_RESPONSE), cache });
    // First pass resolves the place; capture it.
    const first = patchedPlace(await geocodeHandler(fakeDoc(), fakeCtx));
    // An asset already filed at that exact place re-geocodes to the same folder.
    const doc2 = fakeDoc();
    (doc2 as { place: unknown }).place = first;
    const second = await geocodeHandler(doc2, fakeCtx);
    expect(patchedPlace(second)).toBeTruthy();
    expect(resetsBackupLayout(second)).toBe(false);
  });
});

describe('geocode stage config', () => {
  it('requires exif v2 so it never reads pre-fix wrong-sign GPS', () => {
    expect(geocodeStage.dependsOn).toEqual([{ name: 'exif', minVersion: 2 }]);
  });

  it('targetVersion bumped to 2 so v1 results are re-geocoded', () => {
    expect(geocodeStage.targetVersion).toBeGreaterThanOrEqual(2);
  });
});
