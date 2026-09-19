/**
 * Route-integration test: GET /api/assets — the working-set list the File
 * Provider's enumerator seeds itself from.
 *
 * What this file pins is the HTTP surface: query-string parsing, the 400s for
 * garbage input, and that each parsed filter reaches the repository. The
 * repository's own answers — ordering, the live-location predicate, the
 * seconds-resolution mtime — are pinned in
 * `db/sqlite/repos/assets.list.test.ts`, which is why the fixture here stays as
 * small as three assets (#3787).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { assetsListRoutes } from './assets-list.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

const NOW = '2026-05-10T00:00:00Z';
const OLD = '2025-01-01T00:00:00Z';

/** One asset with a location, plus the grid fields the filters read. */
function seedAsset(
  libraryId: string,
  opts: {
    filename: string;
    rating: number;
    hasXmp: boolean;
    capturedAt?: string;
    mtimeMs?: number;
  },
): string {
  const id = insertAsset(live.db, {
    exif: opts.capturedAt === undefined ? null : JSON.stringify({ captured_at: opts.capturedAt }),
  });
  insertLocation(live.db, { assetId: id, libraryId, path: '', filename: opts.filename });
  run(
    live.db,
    `UPDATE assets SET rating = ?, has_xmp = ?, mtime = ? WHERE id = ?`,
    opts.rating,
    opts.hasXmp ? 1 : 0,
    opts.mtimeMs ?? 1,
    id,
  );
  return id;
}

/** The three-asset fixture every filter case runs against. */
function seed(): { libraryId: string; a: string } {
  const libraryId = insertFolder(live.db, { path: '/p' });
  const a = seedAsset(libraryId, {
    filename: 'a.dng',
    rating: 5,
    hasXmp: true,
    capturedAt: NOW,
  });
  seedAsset(libraryId, { filename: 'b.dng', rating: 0, hasXmp: false, capturedAt: OLD });
  seedAsset(libraryId, { filename: 'c.dng', rating: 3, hasXmp: true, capturedAt: NOW });
  return { libraryId, a };
}

function app() {
  return new Elysia().use(fakeAuth()).use(assetsListRoutes);
}

describe('GET /api/assets', () => {
  it('filters by has_xmp=1', async () => {
    seed();
    const res = await app().handle(new Request('http://localhost/api/assets?has_xmp=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assets.map((a: { filename: string }) => a.filename).sort()).toEqual([
      'a.dng',
      'c.dng',
    ]);
  });

  it('filters by rating_gte=1', async () => {
    seed();
    const res = await app().handle(new Request('http://localhost/api/assets?rating_gte=1'));
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it('filters by captured_after=ISO', async () => {
    seed();
    const after = new Date('2026-01-01T00:00:00Z').toISOString();
    const res = await app().handle(
      new Request(`http://localhost/api/assets?captured_after=${encodeURIComponent(after)}`),
    );
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it('returns 400 for invalid captured_after', async () => {
    const res = await app().handle(
      new Request('http://localhost/api/assets?captured_after=notadate'),
    );
    expect(res.status).toBe(400);
  });

  it('returns all assets when no filters are given', async () => {
    seed();
    const res = await app().handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    expect(body.assets.length).toBe(3);
  });

  it('excludes soft-deleted rows (M)', async () => {
    const { a } = seed();
    run(live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, new Date().toISOString(), a);
    const res = await app().handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    const names = body.assets.map((row: { filename: string }) => row.filename);
    expect(names).not.toContain('a.dng');
    expect(body.assets.length).toBe(2);
  });

  it('returns 400 for non-integer rating_gte (L)', async () => {
    seed();
    const res = await app().handle(new Request('http://localhost/api/assets?rating_gte=abc'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rating_gte/);
  });

  it('returns mtime in seconds, round-trips to a sensible Date (G)', async () => {
    const libraryId = insertFolder(live.db, { path: '/p-g' });
    const mtimeMs = Date.UTC(2026, 4, 17, 12, 30, 0); // 2026-05-17 12:30 UTC
    seedAsset(libraryId, { filename: 'g.dng', rating: 0, hasXmp: false, mtimeMs });

    const res = await app().handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    const g = body.assets.find((row: { filename: string }) => row.filename === 'g.dng');
    expect(g).toBeDefined();
    // Server returns seconds. Build a Date the same way Swift would
    // (timeIntervalSince1970:) and assert it lands inside 2026.
    const reconstructed = new Date(g.mtime * 1000);
    expect(reconstructed.getUTCFullYear()).toBe(2026);
    expect(g.mtime).toBe(Math.floor(mtimeMs / 1000));
  });
});
