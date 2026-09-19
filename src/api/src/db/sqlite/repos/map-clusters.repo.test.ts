/**
 * The map's grid aggregation: cells, counts, representatives, and the two
 * shapes that are easy to get wrong.
 *
 * `floor` over a negative coordinate is the first: truncation toward zero would
 * put a point at -0.5 in the same cell as one at +0.5, folding the two sides of
 * the equator and the prime meridian together. The second is the antimeridian,
 * where the viewport's longitude range runs the long way round and a plain
 * `BETWEEN` matches nothing at all.
 */

import { describe, expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertFolder,
  insertLocation,
  run,
  testSqliteDb,
} from '../test-sqlite.test-helpers.ts';
import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../object-id.ts';
import { mapClusters, type MapBbox } from './map-clusters.repo.ts';
import { buildSearchWhere, type SearchWhere } from './search.where.ts';

/** The whole world, so a test opts into a narrower viewport deliberately. */
const WORLD: MapBbox = { west: -180, south: -90, east: 180, north: 90 };

/** No filters at all — every live, non-hidden asset. */
function anyQuery(): SearchWhere {
  const where = buildSearchWhere({});
  if ('error' in where) throw new Error(where.error);
  return where;
}

/**
 * One live asset with GPS, in `libraryId`.
 *
 * `gps_lat`/`gps_lng` are generated columns over the `exif` JSON, so the
 * coordinates go in as part of that payload rather than as columns.
 */
function insertGpsAsset(
  db: Database,
  libraryId: string,
  args: { id?: string; lat: number; lng: number; place?: unknown },
): string {
  const id = args.id ?? newObjectIdHex();
  run(
    db,
    `INSERT INTO assets (id, size, mtime, indexed_at, exif, place)
     VALUES (?, 1, 1, '2026-01-01T00:00:00.000Z', ?, ?)`,
    id,
    JSON.stringify({ gps: { lat: args.lat, lng: args.lng } }),
    args.place === undefined ? null : JSON.stringify(args.place),
  );
  insertLocation(db, { assetId: id, libraryId, filename: `${id}.dng` });
  return id;
}

describe('mapClusters', () => {
  test('groups points into cells and averages each cell', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    // Two points a tenth of a degree apart share a 1-degree cell; the third is
    // three degrees east and gets its own.
    insertGpsAsset(handle.db, libraryId, { lat: 10.1, lng: 20.1 });
    insertGpsAsset(handle.db, libraryId, { lat: 10.3, lng: 20.3 });
    insertGpsAsset(handle.db, libraryId, { lat: 10.2, lng: 23.5 });

    const cells = await mapClusters(anyQuery(), WORLD, 1, db);
    expect(cells).toHaveLength(2);

    const pair = cells.find((cell) => cell.count === 2)!;
    expect(pair.avgLat).toBeCloseTo(10.2, 6);
    expect(pair.avgLng).toBeCloseTo(20.2, 6);
    // A cell with more than one asset draws a count bubble, so no path is
    // resolved for it.
    expect(pair.fileinfo).toEqual([]);

    const single = cells.find((cell) => cell.count === 1)!;
    expect(single.avgLat).toBeCloseTo(10.2, 6);
    // A single-asset cell is a thumbnail pin, so its location comes back.
    expect(single.fileinfo).toHaveLength(1);
  });

  test('splits across the equator and the prime meridian rather than truncating', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    // Four points within half a degree of (0, 0), one per quadrant. Truncation
    // toward zero would collapse all four into one cell.
    insertGpsAsset(handle.db, libraryId, { lat: 0.5, lng: 0.5 });
    insertGpsAsset(handle.db, libraryId, { lat: -0.5, lng: 0.5 });
    insertGpsAsset(handle.db, libraryId, { lat: 0.5, lng: -0.5 });
    insertGpsAsset(handle.db, libraryId, { lat: -0.5, lng: -0.5 });

    const cells = await mapClusters(anyQuery(), WORLD, 1, db);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.count === 1)).toBe(true);
  });

  test('an antimeridian-crossing viewport matches both sides of the seam', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    insertGpsAsset(handle.db, libraryId, { lat: 0, lng: 179 });
    insertGpsAsset(handle.db, libraryId, { lat: 0, lng: -179 });
    // Well outside the viewport below.
    insertGpsAsset(handle.db, libraryId, { lat: 0, lng: 0 });

    const seam: MapBbox = { west: 170, south: -10, east: -170, north: 10 };
    const cells = await mapClusters(anyQuery(), seam, 1, db);
    expect(cells.reduce((sum, cell) => sum + cell.count, 0)).toBe(2);
  });

  test('the representative is the lowest id in its cell, with that row’s place', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    // Ids chosen so the lexical order is unambiguous.
    const lowest = 'a'.repeat(24);
    insertGpsAsset(handle.db, libraryId, {
      id: lowest,
      lat: 5.1,
      lng: 5.1,
      place: { rollups: { locality: 'Lowtown', region: 'Lowshire', country_code: 'gb' } },
    });
    insertGpsAsset(handle.db, libraryId, {
      id: 'f'.repeat(24),
      lat: 5.2,
      lng: 5.2,
      place: { rollups: { locality: 'Hightown', region: 'Highshire', country_code: 'fr' } },
    });

    const cells = await mapClusters(anyQuery(), WORLD, 1, db);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.representativeId).toBe(lowest);
    // The label has to come off the SAME row the id names, which is the whole
    // reason the representatives are read in a second keyed query.
    expect(cells[0]!.locality).toBe('Lowtown');
    expect(cells[0]!.region).toBe('Lowshire');
    expect(cells[0]!.countryCode).toBe('gb');
  });

  test('excludes assets with no GPS, soft-deleted assets and hidden ones', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);

    const keep = insertGpsAsset(handle.db, libraryId, { lat: 1, lng: 1 });

    // No GPS at all.
    const noGps = newObjectIdHex();
    run(
      handle.db,
      `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 1, 1, '2026-01-01T00:00:00.000Z')`,
      noGps,
    );
    insertLocation(handle.db, { assetId: noGps, libraryId, filename: 'nogps.dng' });

    // In the trash.
    const trashed = insertGpsAsset(handle.db, libraryId, { lat: 1.1, lng: 1.1 });
    run(handle.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, '2026-02-01', trashed);

    // Hidden.
    const hidden = insertGpsAsset(handle.db, libraryId, { lat: 1.2, lng: 1.2 });
    run(handle.db, `UPDATE assets SET hidden = 1 WHERE id = ?`, hidden);

    const cells = await mapClusters(anyQuery(), WORLD, 1, db);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.count).toBe(1);
    expect(cells[0]!.representativeId).toBe(keep);
  });

  test('an empty viewport returns no cells rather than throwing', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const libraryId = insertFolder(handle.db);
    insertGpsAsset(handle.db, libraryId, { lat: 40, lng: 40 });

    const elsewhere: MapBbox = { west: -10, south: -10, east: 10, north: 10 };
    expect(await mapClusters(anyQuery(), elsewhere, 1, db)).toEqual([]);
  });
});
