/**
 * Wiring and input-validation tests for POST /api/library/relocate-count and
 * POST /api/library/relocate (#1671).
 *
 * Route existence, the address-count limits, and the contract that a database
 * hiccup can never 500 the editor. The real move machinery — files on disk, the
 * repointed location row, the collision auto-rename — is covered by the three
 * end-to-end suites beside this one.
 *
 * One in-memory SQLite database is installed for the file, because these routes
 * reach the process-wide handle with no override. Nothing skips.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { geoSegmentsFromOverride } from './library-relocate-helper.ts';
import { app, postCount, postRelocate } from './library-relocate.test-helpers.ts';

let live: LiveTestDatabase;

beforeAll(async () => {
  live = await createLiveTestDatabase();
});

afterAll(() => {
  live.close();
});

// ---------------------------------------------------------------------------
// geoSegmentsFromOverride — unit tests
// ---------------------------------------------------------------------------

describe('geoSegmentsFromOverride (library-relocate)', () => {
  test('returns correct segments for a full US place_text', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: {
        city: 'San Francisco',
        state: 'California',
        country: 'United States',
        country_code: 'us',
      },
    });
    expect(segs).toEqual(['California', 'San Francisco']);
  });

  test('returns correct segments for a non-US place_text', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: {
        city: 'Paris',
        country: 'France',
        country_code: 'fr',
      },
    });
    expect(segs).toEqual(['France', 'Paris']);
  });

  test('applies NYC rename for New York city in New York state (USA)', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: {
        city: 'New York',
        state: 'New York',
        country: 'United States',
        country_code: 'us',
      },
    });
    expect(segs).toEqual(['New York', 'New York City']);
  });

  test('strips civic prefix from city name', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: {
        city: 'City of London',
        country: 'United Kingdom',
        country_code: 'gb',
      },
    });
    expect(segs).toEqual(['United Kingdom', 'London']);
  });

  test('returns [] when place_text is absent', () => {
    expect(geoSegmentsFromOverride(null)).toEqual([]);
    expect(geoSegmentsFromOverride(undefined)).toEqual([]);
    expect(
      geoSegmentsFromOverride({
        edited_at: '2026-06-30T00:00:00Z',
        touched_fields: [],
        // no place_text
      }),
    ).toEqual([]);
  });

  test('returns [] when place_text has no country or state', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: { city: 'Somewhere' },
    });
    expect(segs).toEqual([]);
  });

  test('returns [country] when city is absent', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-30T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: { country: 'Japan', country_code: 'jp' },
    });
    expect(segs).toEqual(['Japan']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/library/relocate-count
// ---------------------------------------------------------------------------

describe('POST /api/library/relocate-count', () => {
  test('route is registered (not 404)', async () => {
    const res = await postCount(['some-slug:photo.jpg']);
    expect(res.status).not.toBe(404);
  });

  test('returns 400 for empty addresses array', async () => {
    const res = await postCount([]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for addresses exceeding limit', async () => {
    const res = await postCount(Array.from({ length: 1001 }, (_, i) => `slug:img${i}.jpg`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing addresses field', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/library/relocate-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns count:0 when no DB docs match (unknown slug)', async () => {
    const res = await postCount(['no-such-slug:photo.jpg']);
    // Unknown slug → resolveAddressString throws → address dropped → absPaths empty.
    // The handler wraps every DB touch in try/catch and returns count:0 (200) so a
    // database hiccup can never 500 the editor — assert that contract strictly, so
    // a regression that starts surfacing 500s is caught.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/library/relocate
// ---------------------------------------------------------------------------

describe('POST /api/library/relocate', () => {
  test('route is registered (not 404)', async () => {
    const res = await postRelocate(['some-slug:photo.jpg']);
    expect(res.status).not.toBe(404);
  });

  test('returns 400 for empty addresses array', async () => {
    const res = await postRelocate([]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for addresses exceeding limit', async () => {
    const res = await postRelocate(Array.from({ length: 1001 }, (_, i) => `slug:img${i}.jpg`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing addresses field', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/library/relocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns an empty results array when the unknown slug filters every address', async () => {
    const res = await postRelocate(['no-such-slug:photo.jpg']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Old /api/backup/refile-count and /api/backup/refile must NOT be registered
// (they are removed — any caller hitting them would get 404).
// ---------------------------------------------------------------------------

describe('Old /api/backup/refile-* routes are removed', () => {
  test('/api/backup/refile-count returns 404', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/backup/refile-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: ['slug:photo.jpg'] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('/api/backup/refile returns 404', async () => {
    const res = await app.handle(
      new Request('http://localhost/api/backup/refile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: ['slug:photo.jpg'] }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
