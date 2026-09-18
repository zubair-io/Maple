/**
 * Batch loaders: everything the DTOs need for a set of asset ids, fetched in a
 * fixed number of queries rather than one per asset.
 *
 * The detail DTO draws on five tables. Loading them per asset would turn a
 * 200-asset File Provider change batch into a thousand round trips through the
 * worker pool, so each loader takes the whole id list and every loader for one
 * call runs concurrently — the pool's readers are there precisely so that
 * several statements can be in flight at once.
 *
 * The id list always comes from a query that has already decided which assets
 * to return. These loaders never widen or narrow that set; they only fill in
 * what hangs off it. That is what keeps `assets` the outer loop of every
 * browse query.
 */

import { type SqliteDb } from './db-handle.ts';
import {
  detailByAssetIdsSql,
  enrichmentByAssetIdsSql,
  facesByAssetIdsSql,
  LIBRARY_ROOTS_SQL,
  locationsByAssetIdsSql,
} from './assets.sql.ts';
import {
  groupByAsset,
  type DetailRow,
  type EnrichmentRow,
  type FaceRow,
  type LocationRow,
} from './assets.rows.ts';
import { EMPTY_BUNDLE, type AssetBundle } from './assets.dto.ts';

/**
 * Library id (hex) → library root path, for resolving a location's absolute
 * path.
 *
 * A transient failure must not break a transform path: the Mongo repo falls
 * back to an empty map, which resolves every `abs_path` to `""`, and every
 * route handler already tolerates that. Same contract here.
 */
export async function loadLibraries(db: SqliteDb): Promise<ReadonlyMap<string, string>> {
  try {
    const rows = await db.read<{ id: string; path: string }>(LIBRARY_ROOTS_SQL);
    return new Map(rows.map((row) => [row.id, row.path] as const));
  } catch {
    return new Map();
  }
}

/** Locations for a batch of assets, grouped by asset and ordered by `ordinal`. */
export async function loadLocations(
  db: SqliteDb,
  ids: readonly string[],
): Promise<Map<string, LocationRow[]>> {
  if (ids.length === 0) return new Map();
  const rows = await db.read<LocationRow>(locationsByAssetIdsSql(ids.length), [...ids]);
  return groupByAsset(rows);
}

/**
 * The narrower bundle behind the core-info shape: locations and the detail
 * row, and nothing else.
 *
 * Core info carries no faces and no enrichment, so fetching them would be two
 * statements per call for values that are thrown away — and this is the
 * hottest read in the repository, on the path of every `/api/assets/:id`
 * sub-route that touches the filesystem or the change feed.
 */
export async function loadCoreBundle(db: SqliteDb, id: string): Promise<AssetBundle> {
  const [locations, details] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(1), [id]),
    db.read<DetailRow>(detailByAssetIdsSql(1), [id]),
  ]);
  return {
    locations,
    faces: EMPTY_BUNDLE.faces,
    detail: details[0],
    enrichment: EMPTY_BUNDLE.enrichment,
  };
}

/**
 * Locations, faces, detail payloads and enrichment state for a batch of
 * assets, grouped per asset.
 *
 * Four statements, issued together. An asset with no row in a table gets an
 * empty list or `undefined`, which the DTO layer already treats as "never
 * written" — the same thing a missing subdocument meant on Mongo.
 */
export async function loadBundles(
  db: SqliteDb,
  ids: readonly string[],
): Promise<Map<string, AssetBundle>> {
  if (ids.length === 0) return new Map();
  const params = [...ids];
  const [locations, faces, details, enrichment] = await Promise.all([
    db.read<LocationRow>(locationsByAssetIdsSql(ids.length), params),
    db.read<FaceRow>(facesByAssetIdsSql(ids.length), params),
    db.read<DetailRow>(detailByAssetIdsSql(ids.length), params),
    db.read<EnrichmentRow>(enrichmentByAssetIdsSql(ids.length), params),
  ]);

  const locationsByAsset = groupByAsset(locations);
  const facesByAsset = groupByAsset(faces);
  const detailByAsset = new Map(details.map((row) => [row.asset_id, row] as const));
  const enrichmentByAsset = groupByAsset(enrichment);

  return new Map(
    ids.map(
      (id) =>
        [
          id,
          {
            locations: locationsByAsset.get(id) ?? EMPTY_BUNDLE.locations,
            faces: facesByAsset.get(id) ?? EMPTY_BUNDLE.faces,
            detail: detailByAsset.get(id),
            enrichment: enrichmentByAsset.get(id) ?? EMPTY_BUNDLE.enrichment,
          },
        ] as const,
    ),
  );
}
