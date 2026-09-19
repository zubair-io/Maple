/**
 * `GET /api/map/clusters` on SQLite — the zoom-sized lat/lng grid behind the
 * Map view's heatmap and pins (#3787).
 *
 * The Mongo version is a four-stage aggregation: match, `$addFields` with
 * `$floor($divide(…))` per axis, `$group` by the pair, and a `$top` accumulator
 * picking each cell's representative. Here it is one `GROUP BY` over two
 * expressions, plus a second keyed read for the representatives — the shape a
 * grid aggregation has in SQL.
 *
 * ## Why the representative needs its own query
 *
 * `$top: { sortBy: { _id: 1 } }` carries several fields out of *one* document,
 * which is exactly what an aggregate cannot do: `MIN(assets.id)` names the row,
 * but any other bare column in the same `SELECT` comes from an arbitrary member
 * of the group. Reading the place rollups in a second statement keyed on those
 * ids is what keeps the label and the id describing the same photo — the
 * property the `$top` accumulator was chosen for.
 *
 * `MIN(id)` and `$top` agree on which row that is: an ObjectId's hex spelling is
 * lowercase and fixed-width, so it sorts lexically in the same order as the
 * bytes MongoDB compared.
 *
 * ## The cost ceiling is the caller's, and it is what makes this safe
 *
 * The route clamps the grid so neither axis exceeds 64 cells, so the group's
 * hash table holds at most about 4,000 rows however large the library is. That
 * is the same bound the aggregation relied on, and it is why neither statement
 * here needs a limit of its own.
 */

import type { FileInfo } from '../schema.ts';
import { bucketedIds, locationsByAssetIdsSql } from './assets.sql.ts';
import { toFileInfo, type LocationRow } from './assets.rows.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';
import { placeholders } from './values.ts';
import { searchWhereSql, type BoundPredicate, type SearchWhere } from './search.where.ts';

export type { SqliteDb } from './db-handle.ts';

/** The viewport, in decimal degrees. `west > east` crosses the antimeridian. */
export interface MapBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** One occupied grid cell. */
export interface MapClusterCell {
  count: number;
  avgLat: number;
  avgLng: number;
  representativeId: string;
  locality: string | null;
  region: string | null;
  countryCode: string | null;
  /**
   * The representative's locations, populated only for a cell holding exactly
   * one asset.
   *
   * A thumbnail pin is drawn only for a single-asset cell — once a cell holds
   * more photos there is no one image to show — so resolving a file path for
   * every cell would be work whose result is discarded. The route's own
   * `count === 1` test is the same decision, made one layer up.
   */
  fileinfo: FileInfo[];
}

/**
 * The tables a translated search reads from.
 *
 * Mirrors `fromClause` in `search.sql.ts`, which is not exported: without a text
 * query the source is `assets` alone, and with one FTS5 leads because the
 * inverted index is the most selective thing in the query. A text query no row
 * can satisfy leads with `assets` too — its `WHERE` is the folded constant `0`,
 * and joining an index to prove that is work for nothing.
 */
function fromClause(where: SearchWhere): string {
  if (where.match.kind !== 'match') return 'FROM assets';
  return `FROM assets_fts
      JOIN asset_search ON asset_search.rowid = assets_fts.rowid
      JOIN assets ON assets.id = asset_search.asset_id`;
}

/**
 * Viewport containment, as one predicate.
 *
 * Longitude is a plain range in the ordinary case. An antimeridian-crossing
 * viewport (`west > east`, say west=170 east=-170) means "east of west OR west
 * of east" and is spelled as such — the same asymmetry the route documents,
 * since there is no equivalent wrap at the poles.
 *
 * `gps_lat IS NOT NULL` leads because `assets_gps_bbox` is partial over exactly
 * that, and SQLite only uses a partial index when the query's `WHERE` provably
 * implies the index's.
 */
function bboxPredicate(bbox: MapBbox): BoundPredicate {
  const longitude =
    bbox.west <= bbox.east
      ? { sql: `assets.gps_lng BETWEEN ? AND ?`, params: [bbox.west, bbox.east] }
      : { sql: `(assets.gps_lng >= ? OR assets.gps_lng <= ?)`, params: [bbox.west, bbox.east] };
  return {
    sql: `assets.gps_lat IS NOT NULL
     AND assets.gps_lat BETWEEN ? AND ?
     AND ${longitude.sql}`,
    params: [bbox.south, bbox.north, ...longitude.params],
  };
}

interface CellRow {
  count: number;
  avg_lat: number;
  avg_lng: number;
  representative_id: string;
}

interface RepresentativeRow {
  id: string;
  locality: string | null;
  region: string | null;
  country_code: string | null;
}

/**
 * The occupied cells of one viewport at one grid resolution.
 *
 * `where` is the translated `/api/search` query string, so the map shows exactly
 * what the caller's active filters show elsewhere; the viewport and the GPS
 * requirement are added on top of it rather than spread into it, which is what
 * keeps every predicate restrictive no matter what `buildSearchWhere` produces.
 */
export async function mapClusters(
  where: SearchWhere,
  bbox: MapBbox,
  cellSizeDeg: number,
  dbOverride?: SqliteDb,
): Promise<MapClusterCell[]> {
  const db = assetsDb(dbOverride);
  const bound = searchWhereSql(where, bboxPredicate(bbox));
  const cells = await db.read<CellRow>(
    `SELECT COUNT(*) AS count,
            AVG(assets.gps_lat) AS avg_lat,
            AVG(assets.gps_lng) AS avg_lng,
            MIN(assets.id) AS representative_id
       ${fromClause(where)}
       ${bound.sql}
      GROUP BY floor(assets.gps_lat / ?), floor(assets.gps_lng / ?)`,
    [...bound.params, cellSizeDeg, cellSizeDeg],
  );
  if (cells.length === 0) return [];

  const representativeIds = cells.map((cell) => cell.representative_id);
  const thumbIds = cells.filter((cell) => cell.count === 1).map((cell) => cell.representative_id);
  const [places, locations] = await Promise.all([
    db.read<RepresentativeRow>(
      `SELECT id,
              place_locality AS locality,
              place_region AS region,
              place_country_code AS country_code
         FROM assets WHERE id IN (${placeholders(representativeIds.length)})`,
      representativeIds,
    ),
    thumbIds.length === 0
      ? Promise.resolve<LocationRow[]>([])
      : db.read<LocationRow>(
          locationsByAssetIdsSql(bucketedIds(thumbIds).length),
          bucketedIds(thumbIds),
        ),
  ]);

  const placeById = new Map(places.map((row) => [row.id, row] as const));
  const locationsByAsset = new Map<string, LocationRow[]>();
  for (const location of locations) {
    const list = locationsByAsset.get(location.asset_id);
    if (list === undefined) locationsByAsset.set(location.asset_id, [location]);
    else list.push(location);
  }

  return cells.map((cell) => {
    const place = placeById.get(cell.representative_id);
    return {
      count: cell.count,
      avgLat: cell.avg_lat,
      avgLng: cell.avg_lng,
      representativeId: cell.representative_id,
      locality: place?.locality ?? null,
      region: place?.region ?? null,
      countryCode: place?.country_code ?? null,
      fileinfo: toFileInfo(locationsByAsset.get(cell.representative_id) ?? []),
    };
  });
}
