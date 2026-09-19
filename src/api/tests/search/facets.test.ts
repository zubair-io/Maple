/**
 * Tests for GET /api/search/facets — aggregation buckets for FE dropdowns.
 *
 * Bare-Elysia `app.handle` style; mirrors `tests/auth/enforcement.test.ts`.
 * Real SQLite, installed as the process-wide handle for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { fmtAuth, seedBaseLibrary, type SeededLibraries } from './_setup.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraries: SeededLibraries;

beforeAll(async () => {
  live = await createLiveTestDatabase();
  libraries = seedBaseLibrary(live.db);
});

afterAll(() => {
  live.close();
});

async function facets(qs = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const { searchRoutes } = await import('../../src/routes/search.ts');
  const { requireAuth } = await import('../../src/auth/middleware.ts');
  const app = new Elysia().use(requireAuth).use(searchRoutes);
  const r = await app.handle(
    new Request(`http://localhost/api/search/facets${qs}`, { headers: fmtAuth() }),
  );
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe('/api/search/facets', () => {
  it('aggregates camera + lens + ext + iso + capture range', async () => {
    const { status, body } = await facets();
    expect(status).toBe(200);
    const cameras = body.cameras as Array<{ make: string | null; model: string | null }>;
    const lenses = body.lenses as Array<{ value: string | null }>;
    const extensions = body.extensions as Array<{ value: string }>;
    const isoRange = body.iso_range as { min: number; max: number };
    const captureRange = body.capture_range as { from: string; to: string };

    expect(body.total).toBe(4);
    // Three cameras with EXIF + one null group for the JPG without EXIF.
    expect(cameras.length).toBeGreaterThanOrEqual(3);
    const makes = new Set(cameras.map((c) => c.make));
    expect(makes.has('Hasselblad')).toBe(true);
    expect(makes.has('Canon')).toBe(true);
    expect(makes.has('Sony')).toBe(true);
    // Lens facets.
    const lensValues = new Set(lenses.map((l) => l.value));
    expect(lensValues.has('Hasselblad 24mm f/1.5')).toBe(true);
    // Extensions cover dng/cr3/arw/jpg.
    const exts = new Set(extensions.map((e) => e.value));
    expect(exts.has('dng')).toBe(true);
    expect(exts.has('cr3')).toBe(true);
    expect(exts.has('arw')).toBe(true);
    expect(exts.has('jpg')).toBe(true);
    // ISO range spans 100..1600.
    expect(isoRange.min).toBe(100);
    expect(isoRange.max).toBe(1600);
    // Capture range covers the seeded ISO 8601 strings.
    expect(captureRange.from <= captureRange.to).toBe(true);
  });

  it('respects libraryId scope', async () => {
    const { status, body } = await facets(`?libraryId=${libraries.folderA}`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
  });
});
