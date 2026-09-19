/**
 * The twelve facet aggregations `GET /api/search/facets` answers with.
 *
 * Split out of `search.sql.ts` when #3768 gave six of them a second shape:
 * that file is the page, the count and the seek, this one is the facets, and
 * together they were over the file-size budget.
 *
 * ## Six read one index; six used to leave the row
 *
 * Camera, lens, place, screenshot, the capture range and the total all group a
 * partial index on `assets` whose keys *are* their group keys, so they answer
 * without reading an asset row: 6 to 21 ms each at 335,377 assets.
 *
 * The other six group something else — `asset_detail` for scene type and
 * activity, `asset_locations` for the extension, `faces` for people,
 * `asset_subjects` for subjects — and each of those used to ask `assets` one
 * question per candidate row: live, and visible? That probe was the whole cost,
 * between 252 and 1,134 ms per facet, and no index on the grouped table could
 * remove it because the answer was not in that table. It is now: each satellite
 * mirrors `asset_live` and `asset_hidden` from its asset, maintained by trigger
 * (`ddl/facet-state.ts`), so a facet with nothing else to ask reads one index
 * and stops. The ISO range was the seventh case and needed no mirror, only an
 * index over the column it takes `MIN`/`MAX` of.
 *
 * ## The two shapes, and when each applies
 *
 * A search that carries no residual filter — the unfiltered browse every client
 * opens on, and the one the route serves most — needs nothing from `assets`
 * beyond liveness and visibility, both of which the satellite now holds. That
 * request gets the join-free shape.
 *
 * A search with a filter still has to ask `assets` about the camera, the place,
 * the date or the person, so it joins, and the mirrored predicates stay in the
 * statement: they are still true, and spelling them is what lets the same index
 * serve both shapes. The mirrored columns therefore never *change* which assets
 * a facet counts — they are a second, faster way to ask a question the join
 * answers identically, which is what `search.facets.test.ts` holds them to.
 */

import {
  canNameIndex,
  countSql,
  fromClause,
  statement,
  type BoundStatement,
} from './search.sql.ts';
import type { SearchWhere } from './search.where.ts';

/** The keys of {@link facetStatements}, which are the response's own fields. */
export type FacetName =
  | 'total'
  | 'cameras'
  | 'lenses'
  | 'extensions'
  | 'iso_range'
  | 'capture_range'
  | 'scene_types'
  | 'activities'
  | 'subjects'
  | 'is_screenshot'
  | 'people'
  | 'places';

/** One facet that groups a table other than `assets`. */
interface SatelliteFacet {
  /** The grouped table and the alias its columns are written with. */
  source: string;
  /** That alias on its own, for the mirrored-state predicates. */
  alias: string;
  /** The index the join-free shape names. See {@link satelliteFacetSql}. */
  index: string;
  /** The projection, aliased to the names `search.facets.ts` reads back. */
  select: string;
  /** What `GROUP BY` names — the projected key, not its alias. */
  groupBy: string;
  /** Predicates this facet needs beyond the live-and-visible one. */
  extra: readonly string[];
  limit: number;
}

/**
 * The always-on half of a satellite facet's `WHERE`, read from the grouped
 * table rather than from `assets`.
 *
 * `asset_live = 1` is in every facet index's own `WHERE`, so it has to be
 * spelled here verbatim or SQLite will not use the index — its implication test
 * runs over what the query actually says. `asset_hidden` is a *column* of the
 * index instead, because `hidden=all` carries no visibility predicate at all
 * and `hidden=only` carries the opposite one; both still use the index, which a
 * partial index over `asset_hidden = 0` would have lost.
 */
function mirroredState(alias: string, hidden: 0 | 1 | null): string[] {
  return [
    `${alias}.asset_live = 1`,
    ...(hidden === null ? [] : [`${alias}.asset_hidden = ${hidden}`]),
  ];
}

/** Predicates joined the way {@link statement} joins the ones it composes. */
function allOf(predicates: readonly string[]): string {
  return predicates.join('\n     AND ');
}

/**
 * Whether this search can be answered from the grouped table alone.
 *
 * Only two things reach a facet from outside the satellite: the residual
 * filters a query string produced, and a full-text match. With neither, the
 * live-and-visible predicate is the entire `WHERE`, and the mirror holds it.
 */
function needsAssets(where: SearchWhere): boolean {
  return where.clauses.length > 0 || where.match.kind !== 'none';
}

/**
 * The `FROM` of a joined satellite facet: `assets` outside, the satellite
 * probed by key.
 *
 * `CROSS JOIN` is SQLite's way of saying "do not reorder this", and it is
 * meant literally rather than as a different kind of join — the rows are the
 * same as `JOIN`'s. It is here because the planner gets this one wrong and the
 * wrong answer is expensive. A filter that reaches `assets` is one the
 * satellite cannot answer, so the live set has to be walked whatever the order;
 * walking it first and probing the satellite per row costs 150 ms for the
 * scene-type facet at 335,377 assets filtered by `rating >= 4`, against 383 ms
 * led from the satellite, and 155 ms against 1,132 ms for subjects, whose table
 * holds three rows per asset. Left to itself SQLite leads with the satellite in
 * both cases.
 *
 * With a text query {@link fromClause} still leads with the inverted index,
 * which is right for the same reason: `CROSS JOIN` pins the satellite last, not
 * `assets` first, and the smallest driving set goes first.
 */
function satelliteFrom(where: SearchWhere, facet: SatelliteFacet): string {
  return `${fromClause(where)}\n      CROSS JOIN ${facet.source} ON ${facet.alias}.asset_id = assets.id`;
}

/**
 * One satellite facet, in whichever of the two shapes this search allows.
 *
 * The join-free shape names its index. Every one of these tables has more than
 * one index whose leading column is the group key — `faces` has both
 * `faces_person` and `faces_facet_person` — and only the facet index carries
 * the mirrored `asset_hidden`, so picking the other one turns an index-only
 * scan into a row fetch per group member. The planner picks correctly once
 * `ANALYZE` has run and picks `faces_person` on a database that has no
 * statistics yet, which is every fresh install until the first analysis.
 * Naming it removes the question; SQLite fails the statement outright if the
 * index ever stops existing, which is the failure worth having.
 */
function satelliteFacetSql(where: SearchWhere, facet: SatelliteFacet): BoundStatement {
  const suffix = `GROUP BY ${facet.groupBy} ORDER BY count DESC LIMIT ${facet.limit}`;
  if (needsAssets(where)) {
    // No mirrored predicates here, and that is not an oversight. The join
    // already restricts the facet to live, visible assets, so repeating it
    // from the satellite adds nothing true and costs twice: it makes the
    // satellite look selective enough for the planner to lead with it, and it
    // puts two more columns on the probed row, which is what took the
    // extension facet from 153 ms to 218 ms.
    return statement(
      facet.select,
      where,
      suffix,
      facet.extra.length === 0 ? undefined : { sql: allOf(facet.extra), params: [] },
      [],
      satelliteFrom(where, facet),
    );
  }
  return {
    sql: `SELECT ${facet.select}
    FROM ${facet.source} INDEXED BY ${facet.index}
   WHERE ${allOf([...mirroredState(facet.alias, where.hidden), ...facet.extra])}
   ${suffix}`,
    params: [],
  };
}

/** The two `asset_detail` facets, which differ only in column and cap. */
function detailFacet(column: 'vision_scene_type' | 'vision_activity', limit: number) {
  return {
    source: 'asset_detail d',
    alias: 'd',
    index: column === 'vision_scene_type' ? 'asset_detail_scene_type' : 'asset_detail_activity',
    select: `d.${column} AS value, COUNT(*) AS count`,
    groupBy: `d.${column}`,
    // Spelled because the index is partial over `IS NOT NULL`; the empty string
    // is excluded because it is not a facet value, exactly as the Mongo
    // pipeline's `$nin: [null, '']` had it.
    extra: [`d.${column} IS NOT NULL`, `d.${column} <> ''`],
    limit,
  } satisfies SatelliteFacet;
}

/**
 * The extension facet.
 *
 * `ordinal = 0` is the canonical entry, standing in for the Mongo pipeline's
 * `$arrayElemAt(…, 0)`, and it agrees with that only while ordinals stay dense.
 * They do: `asset_locations` is written in three places and each either
 * rewrites an entry in place or replaces the whole set with one entry at
 * ordinal 0, so no path can remove the canonical entry and leave the rest at 1,
 * 2, 3.
 *
 * `extension` is a generated column now rather than an expression over the
 * filename, so the group key is in the index instead of being recomputed per
 * row — and `extension <> ''` is a `WHERE` rather than the `HAVING` it was,
 * which is the same set of buckets and is what the partial index needs to see.
 */
const EXTENSIONS_FACET: SatelliteFacet = {
  source: 'asset_locations l',
  alias: 'l',
  index: 'asset_locations_facet_extension',
  select: 'l.extension AS value, COUNT(*) AS count',
  groupBy: 'l.extension',
  extra: ['l.ordinal = 0', `l.extension <> ''`],
  limit: 50,
};

/**
 * The people facet: assets per person, not faces.
 *
 * `COUNT(DISTINCT)` because a group shot with the same person detected twice
 * counts once, which is what `$setUnion` gave on Mongo. Counting the rows
 * instead would put a number in the chip that the person filter does not
 * deliver.
 */
const PEOPLE_FACET: SatelliteFacet = {
  source: 'faces f',
  alias: 'f',
  index: 'faces_facet_person',
  select: 'f.person_id AS id, COUNT(DISTINCT f.asset_id) AS count',
  groupBy: 'f.person_id',
  extra: ['f.person_id IS NOT NULL', 'f.hidden = 0'],
  limit: 100,
};

/** The subjects facet, over the rows `vision.subjects` became. */
const SUBJECTS_FACET: SatelliteFacet = {
  source: 'asset_subjects s',
  alias: 's',
  index: 'asset_subjects_facet',
  select: 's.subject AS value, COUNT(*) AS count',
  groupBy: 's.subject',
  extra: [],
  limit: 50,
};

/**
 * One `MIN`/`MAX` pair over a column an index holds.
 *
 * `min`/`max` rather than the `from`/`to` the wire uses: both are SQL keywords,
 * and the caller has to rename one pair or quote the other.
 *
 * `INDEXED BY` for the unfiltered request, because the planner finds neither
 * index on its own — left to itself it seeks `assets_live`, which answers the
 * live predicate and nothing else, and then reads every matching row for the
 * value: 265 ms against 12 ms for the ISO range, and 24 ms against 3.3 ms for
 * the capture range.
 *
 * And only for the unfiltered request, which the capture range used to get
 * wrong. Given a residual the index cannot answer, naming it makes the
 * statement walk every live asset in the index's order and fetch each row for
 * the residual, while the planner left alone picks the index the residual
 * itself wants: measured at 493 ms against 116 ms for the capture range with
 * `rating >= 4`. Both range facets now hand the filtered case back.
 */
function rangeFacet(where: SearchWhere, column: string, index: string): BoundStatement {
  const indexOnly = canNameIndex(where) && !needsAssets(where);
  return statement(
    `MIN(assets.${column}) AS min, MAX(assets.${column}) AS max`,
    where,
    '',
    undefined,
    [],
    indexOnly ? `FROM assets INDEXED BY ${index}` : fromClause(where),
  );
}

/**
 * The twelve facet aggregations, in the order the route destructures them.
 *
 * Each is a separate statement rather than one pass with twelve counters,
 * because each wants its own index and the pool can run them concurrently on
 * different readers. That is also how the Mongo route does it, so the shapes
 * line up one to one.
 */
export function facetStatements(where: SearchWhere): Record<FacetName, BoundStatement> {
  return {
    total: countSql(where),
    cameras: statement(
      'assets.camera_make AS make, assets.camera_model AS model, COUNT(*) AS count',
      where,
      'GROUP BY assets.camera_make, assets.camera_model ORDER BY count DESC LIMIT 50',
    ),
    lenses: statement(
      'assets.lens AS value, COUNT(*) AS count',
      where,
      'GROUP BY assets.lens ORDER BY count DESC LIMIT 50',
    ),
    extensions: satelliteFacetSql(where, EXTENSIONS_FACET),
    iso_range: rangeFacet(where, 'iso', 'assets_facet_iso'),
    capture_range: rangeFacet(where, 'captured_at', 'assets_live_captured'),
    scene_types: satelliteFacetSql(where, detailFacet('vision_scene_type', 20)),
    activities: satelliteFacetSql(where, detailFacet('vision_activity', 50)),
    subjects: satelliteFacetSql(where, SUBJECTS_FACET),
    // Two buckets, not three. `is_screenshot` is nullable, so "never
    // classified" is its own group; the route reports it as `unknown`.
    is_screenshot: statement(
      'assets.is_screenshot AS bucket, COUNT(*) AS count',
      where,
      'GROUP BY assets.is_screenshot',
    ),
    people: satelliteFacetSql(where, PEOPLE_FACET),
    places: statement(
      'assets.place_locality AS locality, assets.place_region AS region, COUNT(*) AS count',
      where,
      `GROUP BY assets.place_locality, assets.place_region ORDER BY count DESC LIMIT 100`,
      {
        sql: `((assets.place_locality IS NOT NULL AND assets.place_locality <> '')
          OR (assets.place_region IS NOT NULL AND assets.place_region <> ''))`,
        params: [],
      },
    ),
  };
}

/** Re-exported so a caller needs one import for a facet statement and its type. */
export type { BoundStatement };
