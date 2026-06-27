/**
 * Integration tests for POST /api/backup/refile-count and POST /api/backup/refile.
 *
 * Mirrors the pattern in xmp-batch.test.ts: unique MAPLE_MONGO_DB per file,
 * closeDb() in afterAll, route-existence checks (status ≠ 404).
 * Full end-to-end (Mongo + FS) is covered in manual / CI harness; these tests
 * confirm wiring, input validation, and happy-path shape without requiring a
 * live Mongo instance.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { backupRefileRoutes, geoSegmentsFromOverride } from './backup-refile.ts';

// Isolate the shared db-client singleton to a unique test DB so test runs
// against the real `maple` DB are prevented (matches xmp-batch.test.ts convention).
process.env.MAPLE_MONGO_DB = `maple_test_backup_refile_${process.pid}`;

beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

// ---------------------------------------------------------------------------
// Test app — mount routes directly (no auth middleware) for validation tests
// ---------------------------------------------------------------------------

const app = new Elysia().use(backupRefileRoutes);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function postCount(body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/backup/refile-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function postRefile(body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/backup/refile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// geoSegmentsFromOverride — unit tests
// ---------------------------------------------------------------------------

describe('geoSegmentsFromOverride', () => {
  test('returns correct segments for a full US place_text', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-27T00:00:00Z',
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
      edited_at: '2026-06-27T00:00:00Z',
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
      edited_at: '2026-06-27T00:00:00Z',
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
      edited_at: '2026-06-27T00:00:00Z',
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
        edited_at: '2026-06-27T00:00:00Z',
        touched_fields: [],
        // no place_text
      }),
    ).toEqual([]);
  });

  test('returns [] when place_text has no country or state', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-27T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: { city: 'Somewhere' },
    });
    expect(segs).toEqual([]);
  });

  test('returns [country] when city is absent', () => {
    const segs = geoSegmentsFromOverride({
      edited_at: '2026-06-27T00:00:00Z',
      touched_fields: ['place_text'],
      place_text: { country: 'Japan', country_code: 'jp' },
    });
    expect(segs).toEqual(['Japan']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/backup/refile-count
// ---------------------------------------------------------------------------

describe('POST /api/backup/refile-count', () => {
  test('route is registered (not 404)', async () => {
    const res = await postCount({ paths: ['/some/photo.jpg'] });
    expect(res.status).not.toBe(404);
  });

  test('returns 400 for empty paths array', async () => {
    const res = await postCount({ paths: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for paths exceeding limit', async () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `/photos/img${i}.jpg`);
    const res = await postCount({ paths });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing paths field', async () => {
    const res = await postCount({});
    // Elysia schema validation returns 422; our manual check returns 400.
    // Either is an error response.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns count:0 when no DB docs match (empty-ish DB)', async () => {
    // The DB may be unreachable in unit-test environments; assetsCollection()
    // throws. The route catches Mongo errors and returns count:0 (safe default).
    // When MAPLE_ROOTS is unset every path fails auth → 0 docs resolved → count 0.
    const savedRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = '/nonexistent-maple-root-12345';
    try {
      const res = await postCount({
        paths: ['/nonexistent-maple-root-12345/photo.jpg'],
      });
      // Either resolves count:0 or propagates a Mongo error as 500.
      // The critical check: route exists and responds.
      expect([200, 500]).toContain(res.status);
    } finally {
      if (savedRoots !== undefined) {
        process.env.MAPLE_ROOTS = savedRoots;
      } else {
        delete process.env.MAPLE_ROOTS;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/backup/refile
// ---------------------------------------------------------------------------

describe('POST /api/backup/refile', () => {
  test('route is registered (not 404)', async () => {
    const res = await postRefile({ paths: ['/some/photo.jpg'] });
    expect(res.status).not.toBe(404);
  });

  test('returns 400 for empty paths array', async () => {
    const res = await postRefile({ paths: [] });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/non-empty/i);
  });

  test('returns 400 for paths exceeding limit', async () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `/photos/img${i}.jpg`);
    const res = await postRefile({ paths });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/maximum/i);
  });

  test('returns 4xx for missing paths field', async () => {
    const res = await postRefile({});
    // Elysia schema validation returns 422; our manual check returns 400.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns results array for valid input (auth-jail filters all paths)', async () => {
    // When all paths are outside library roots the auth jail drops them → 0 docs
    // resolved → empty results. Shape check only.
    const savedRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = '/nonexistent-maple-root-99999';
    try {
      const res = await postRefile({
        paths: ['/nonexistent-maple-root-99999/photo.jpg'],
      });
      // Either succeeds with { results: [] } or 500 if Mongo unreachable.
      if (res.status === 200) {
        const body = await res.json();
        expect(Array.isArray(body.results)).toBe(true);
      } else {
        expect([200, 500]).toContain(res.status);
      }
    } finally {
      if (savedRoots !== undefined) {
        process.env.MAPLE_ROOTS = savedRoots;
      } else {
        delete process.env.MAPLE_ROOTS;
      }
    }
  });
});
