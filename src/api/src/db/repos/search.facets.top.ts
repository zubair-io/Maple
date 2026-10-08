/**
 * A text search's facets, counted in TypeScript over the assets they describe
 * (#4431).
 *
 * The facets of a text search group the first results of its list — at most
 * a few thousand assets, already known by `rowid` and `id`. Twelve grouping
 * statements over that set each read the same asset rows again, twelve times
 * over: 22–195 ms apiece on the production snapshot, the slowest of them the
 * whole of a facets request's remaining budget. Here the rows are read once:
 * one statement for every facet column on `assets`, and one per side table
 * — locations, describe output, subjects, faces — each keyed by the asset ids.
 * The buckets are then counted here with the semantics of the statements in
 * `search.facets.sql.ts`, which still serve every search without text:
 *
 *   - `NULL` is a group of its own wherever `GROUP BY` would make it one
 *     (cameras, lenses, the screenshot split), and excluded where those
 *     statements' `WHERE` excludes it;
 *   - ranges are `MIN`/`MAX` over the non-null values;
 *   - the people facet counts assets, not faces;
 *   - buckets are ordered by count, most first, and capped at the same limits.
 *
 * One difference is deliberate and invisible to a test of the counts: where
 * buckets tie on count across a cap, SQL keeps an arbitrary subset and this
 * keeps the lowest keys, so the answer is the same every time.
 */

import type { FacetName } from './search.facets.sql.ts';
import type { BoundStatement } from './search.sql.ts';
import { readBulk, type SqliteDb } from './db-handle.ts';
import type { SqlRow } from '../sqlite/protocol.ts';

/** The rows whose facets are wanted. */
export interface FacetAsset {
  r: number;
  id: string;
}

interface AssetFacetRow {
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  captured_at: string | null;
  is_screenshot: number | null;
  owner_id: string | null;
  place_locality: string | null;
  place_region: string | null;
}

const IDS = '(SELECT value FROM json_each(?))';

/** Every facet column `assets` holds, for the given rows, by primary key. */
export function assetFacetRowsSql(assets: readonly FacetAsset[]): BoundStatement {
  return {
    sql: `SELECT assets.camera_make, assets.camera_model, assets.lens, assets.iso,
           assets.captured_at, assets.is_screenshot, assets.owner_id,
           assets.place_locality, assets.place_region
      FROM assets
     WHERE assets.rowid IN ${IDS}`,
    params: [JSON.stringify(assets.map((asset) => asset.r))],
  };
}

/** The side-table reads, each keyed by asset id, with each facet's own filter. */
export function sideFacetRowsSql(
  assets: readonly FacetAsset[],
): Record<'extensions' | 'details' | 'subjects' | 'people', BoundStatement> {
  const ids = [JSON.stringify(assets.map((asset) => asset.id))];
  return {
    extensions: {
      sql: `SELECT l.extension AS value FROM asset_locations l
     WHERE l.asset_id IN ${IDS} AND l.ordinal = 0 AND l.extension <> ''`,
      params: ids,
    },
    details: {
      sql: `SELECT d.vision_scene_type AS scene, d.vision_activity AS activity
      FROM asset_detail d WHERE d.asset_id IN ${IDS}`,
      params: ids,
    },
    subjects: {
      sql: `SELECT s.subject AS value FROM asset_subjects s WHERE s.asset_id IN ${IDS}`,
      params: ids,
    },
    people: {
      sql: `SELECT DISTINCT f.person_id AS id, f.asset_id AS asset FROM faces f
     WHERE f.asset_id IN ${IDS} AND f.person_id IS NOT NULL AND f.hidden = 0`,
      params: ids,
    },
  };
}

/** A non-null, non-empty string — the `IS NOT NULL AND <> ''` the statements spell. */
function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `GROUP BY key ORDER BY count DESC LIMIT cap`, over `items`. Ties on count
 * are broken by the key's JSON so the cut is deterministic.
 */
function groupCount<T>(
  items: readonly T[],
  key: (item: T) => unknown[],
  cap: number,
): Array<{ key: unknown[]; count: number }> {
  const groups = new Map<string, { key: unknown[]; count: number }>();
  for (const item of items) {
    const parts = key(item);
    const name = JSON.stringify(parts);
    const group = groups.get(name);
    if (group) group.count += 1;
    else groups.set(name, { key: parts, count: 1 });
  }
  return [...groups.entries()]
    .sort(([nameA, a], [nameB, b]) => b.count - a.count || (nameA < nameB ? -1 : 1))
    .slice(0, cap)
    .map(([, group]) => group);
}

/** `MIN`/`MAX` over the non-null values, as one row; nulls when there are none. */
function rangeOf<T extends number | string>(values: Array<T | null>): SqlRow {
  const known = values.filter((value): value is T => value !== null);
  if (known.length === 0) return { min: null, max: null };
  return known.reduce(
    (range, value) => ({
      min: value < (range.min as T) ? value : range.min,
      max: value > (range.max as T) ? value : range.max,
    }),
    { min: known[0]!, max: known[0]! } as SqlRow,
  );
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** Count every facet but the total from the rows read for `assets`. */
function countFacets(
  rows: AssetFacetRow[],
  side: {
    extensions: Array<{ value: string }>;
    details: Array<{ scene: string | null; activity: string | null }>;
    subjects: Array<{ value: string }>;
    people: Array<{ id: string; asset: string }>;
  },
): Omit<Record<FacetName, SqlRow[]>, 'total'> {
  const values = (cap: number, list: Array<string | null>) =>
    groupCount(list.filter(present), (value) => [value], cap).map(({ key, count }) => ({
      value: key[0],
      count,
    }));
  return {
    cameras: groupCount(rows, (row) => [row.camera_make, row.camera_model], 50).map(
      ({ key, count }) => ({ make: key[0], model: key[1], count }),
    ),
    lenses: groupCount(rows, (row) => [row.lens], 50).map(({ key, count }) => ({
      value: key[0],
      count,
    })),
    extensions: values(
      50,
      side.extensions.map((row) => row.value),
    ),
    iso_range: [rangeOf(rows.map((row) => row.iso))],
    capture_range: [rangeOf(rows.map((row) => row.captured_at))],
    scene_types: values(
      20,
      side.details.map((row) => row.scene),
    ),
    activities: values(
      50,
      side.details.map((row) => row.activity),
    ),
    subjects: groupCount(side.subjects, (row) => [row.value], 50).map(({ key, count }) => ({
      value: key[0],
      count,
    })),
    is_screenshot: groupCount(rows, (row) => [row.is_screenshot], UNBOUNDED).map(
      ({ key, count }) => ({ bucket: key[0], count }),
    ),
    people: groupCount(side.people, (row) => [row.id], 100).map(({ key, count }) => ({
      id: key[0],
      count,
    })),
    places: groupCount(
      rows.filter((row) => present(row.place_locality) || present(row.place_region)),
      (row) => [row.place_locality, row.place_region],
      100,
    ).map(({ key, count }) => ({ locality: key[0], region: key[1], count })),
    owners: groupCount(
      rows.filter((row) => row.owner_id !== null),
      (row) => [row.owner_id],
      50,
    ).map(({ key, count }) => ({ id: key[0], count })),
  };
}

/**
 * Every facet but the total over `assets`, in the row shapes the facet
 * statements return, from five reads that run side by side.
 */
export async function facetRowsOf(
  db: SqliteDb,
  assets: readonly FacetAsset[],
): Promise<Omit<Record<FacetName, SqlRow[]>, 'total'>> {
  const scalar = assetFacetRowsSql(assets);
  const side = sideFacetRowsSql(assets);
  const [rows, extensions, details, subjects, people] = await Promise.all([
    readBulk<AssetFacetRow>(db, scalar.sql, scalar.params),
    readBulk<{ value: string }>(db, side.extensions.sql, side.extensions.params),
    readBulk<{ scene: string | null; activity: string | null }>(
      db,
      side.details.sql,
      side.details.params,
    ),
    readBulk<{ value: string }>(db, side.subjects.sql, side.subjects.params),
    readBulk<{ id: string; asset: string }>(db, side.people.sql, side.people.params),
  ]);
  return countFacets(rows, { extensions, details, subjects, people });
}
