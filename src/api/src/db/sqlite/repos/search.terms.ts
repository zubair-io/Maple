/**
 * One `/api/search*` filter, one SQL predicate.
 *
 * Split out of `search.where.ts` so that file reads as the assembly and
 * validation it is — the same move `filter-terms.ts` made out of `query.ts` on
 * the Mongo side, and for the same file-size reason (CONTRIBUTING.md § "File-size
 * budget").
 *
 * Two shapes here are load-bearing, and both are argued in `search.where.ts`'s
 * module comment: anything filtering by a location, a face or a detail payload
 * is a semi-join so `assets` stays the outer loop, and every column is written
 * `assets.<name>` so these clauses can also run under the people facet, whose
 * `FROM` leads with `faces` — a table that has a `hidden` column of its own.
 */

import { ObjectId } from 'mongodb';
import { placeholders } from './assets.sql.ts';
import type { SqlValue } from '../protocol.ts';
import {
  asNumber,
  widenFromDate,
  widenToDate,
  type SearchQuery,
} from '../../../routes/search/query.ts';

/** One predicate and the values it binds, in matching order. */
export interface Term {
  sql: string;
  params: SqlValue[];
}

/**
 * Escape a user string for `LIKE … ESCAPE '\'`.
 *
 * Exported because the service route's exact-filename pass needs the literal
 * without the surrounding wildcards {@link contains} adds, and a second copy of
 * three characters is a copy that can drift: two escapes that disagree return
 * different rows rather than an error.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** `LIKE` pattern matching `value` anywhere in the column. */
export function contains(value: string): string {
  return `%${likeLiteral(value)}%`;
}

/** A trimmed parameter, or `undefined` when it carries nothing. */
export function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Free-text `q`: a case-insensitive substring of a filename or a directory.
 *
 * Correlated rather than an `IN (SELECT …)` over the whole location table, so a
 * grid page probes the locations of the rows it is already walking and stops at
 * the limit. The uncorrelated form would scan every location before the first
 * row came back, which is the wrong trade for the query a person watches.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII, which is what the Mongo
 * `$options: 'i'` regex gave in practice for filenames.
 */
export function freeTextTerm(value: string): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id
                     AND (l.filename LIKE ? ESCAPE '\\' OR l.path LIKE ? ESCAPE '\\'))`,
    params: [contains(value), contains(value)],
  };
}

/** Library scope. Live-only — see the module comment. */
export function libraryTerm(libraryId: string): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id AND l.library_id = ?
                     AND l.deleted_at IS NULL AND l.missing_since IS NULL)`,
    params: [new ObjectId(libraryId).toHexString()],
  };
}

/**
 * Timeline subtree scope: this directory or anything beneath it.
 *
 * The Mongo form is an anchored regex requiring a directory boundary after the
 * prefix, so `A` matches `A` and `A/B` but not `A (1)`. Two predicates say the
 * same thing without a regex: equality for the directory itself, and a prefix
 * test for its descendants.
 *
 * The descendant arm is `substr` rather than the `LIKE` it started as, and the
 * difference is case. `^A(\/|$)` carries no `i` flag, so Mongo matches `A/B`
 * and not `a/b`; SQLite's `=` is likewise BINARY, but its `LIKE` is
 * case-insensitive for ASCII whatever the column's collation. The two arms
 * therefore disagreed with each other — on a case-sensitive filesystem,
 * `pathPrefix=trips` showed everything filed under `Trips/…` while hiding the
 * photos sitting directly in `Trips`, and swept in rows the regex never
 * matched. `substr` compares under the column's own collation, so both arms are
 * BINARY and both agree with the regex. It costs no plan: the correlated
 * `EXISTS` is driven by `asset_id` through `UNIQUE (asset_id, ordinal)` and
 * `path` is a residual either way — no index leads on it, and SQLite's `LIKE`
 * optimisation never applied here anyway, since it needs a case-sensitive
 * `LIKE` to begin with.
 *
 * `length(?)` rather than the prefix length measured in TypeScript: `substr`
 * counts characters and JavaScript counts UTF-16 code units, so a folder named
 * with anything outside the basic plane would otherwise compare the wrong
 * number of them.
 */
export function pathPrefixTerm(prefix: string): Term {
  const subtree = `${prefix}/`;
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id
                     AND (l.path = ? OR substr(l.path, 1, length(?)) = ?))`,
    params: [prefix, subtree, subtree],
  };
}

/** Extension whitelist, matched against any of an asset's filenames. */
export function extensionTerm(extensions: readonly string[]): Term {
  const suffixes = extensions.map(() => `l.filename LIKE ? ESCAPE '\\'`).join(' OR ');
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id AND (${suffixes}))`,
    params: extensions.map((extension) => `%.${likeLiteral(extension)}`),
  };
}

/**
 * The place label the facets endpoint emits, inverted back into a rollup tuple.
 *
 * The inverse of `placeLabel` in `search.facets.ts`, and it has to stay
 * the inverse: a label that does not parse back into the tuple it was built
 * from is a filter chip that returns nothing. "locality, region" splits on the
 * last `", "`; a bare label is either half, with the other blank, so it matches
 * both. Blank means NULL or the empty string, exactly as the Mongo clause's
 * `$in: [null, '']` did.
 */
export function placeLabelTerm(label: string): Term {
  const index = label.lastIndexOf(', ');
  if (index > 0) {
    return {
      sql: '(assets.place_locality = ? AND assets.place_region = ?)',
      params: [label.slice(0, index), label.slice(index + 2)],
    };
  }
  const blank = (column: string): string => `(${column} IS NULL OR ${column} = '')`;
  return {
    sql: `((assets.place_locality = ? AND ${blank('assets.place_region')})
        OR (${blank('assets.place_locality')} AND assets.place_region = ?))`,
    params: [label, label],
  };
}

/** One predicate matching any of a set of alternatives. */
export function orGroup(terms: readonly Term[]): Term {
  return {
    sql: `(${terms.map((term) => term.sql).join(' OR ')})`,
    params: terms.flatMap((term) => term.params),
  };
}

/**
 * Assets showing any of these people.
 *
 * Uncorrelated on purpose, and it is the opposite call from `q` above. The
 * sub-query is an index-only range scan of `faces_person` per person — a
 * bounded, predictable set built once — where the correlated form would probe
 * that index once per person per candidate asset as the grid walks.
 *
 * An empty id list must match nothing rather than everything: names that
 * resolved to no live person are a filter, not the absence of one, which is
 * what an empty `$in` meant on Mongo. It falls out of the generic shape,
 * because SQLite accepts a literally empty `IN ()` and evaluates it false.
 * Writing the constant `0` instead would be the obvious alternative and is
 * wrong — SQLite folds an always-false `WHERE` before planning, which leaves
 * the page query's `INDEXED BY` naming an index the plan no longer has, and the
 * statement fails to prepare with "no query solution".
 */
export function peopleTerm(personIds: readonly string[]): Term {
  return {
    sql: `assets.id IN (SELECT f.asset_id FROM faces f
                         WHERE f.person_id IN (${placeholders(personIds.length)})
                           AND f.person_id IS NOT NULL AND f.hidden = 0)`,
    params: [...personIds],
  };
}

/**
 * Assets showing none of these people — hidden or deliberately excluded.
 *
 * `NOT IN` is safe here only because `faces.asset_id` is `NOT NULL`: a single
 * NULL in the sub-query would make `NOT IN` false for every row and empty the
 * result set silently.
 */
export function excludedPeopleTerm(personIds: readonly string[]): Term {
  const inner = peopleTerm(personIds);
  return { sql: `NOT (${inner.sql})`, params: inner.params };
}

/** One of the two `vision` columns the detail table generates and indexes. */
export function visionTerm(column: 'vision_scene_type' | 'vision_activity', value: string): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_detail d WHERE d.asset_id = assets.id AND d.${column} = ?)`,
    params: [value],
  };
}

/**
 * Any of the listed subjects, from the `vision.subjects` array.
 *
 * `json_each` over the array is the row-wise equivalent of Mongo's `$in` against
 * a multikey field. `COALESCE(…, '[]')` is not defensive tidiness: `json_each`
 * raises on a NULL argument, so an asset with no vision payload would fail the
 * whole statement rather than simply not match.
 */
export function subjectsTerm(subjects: readonly string[]): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_detail d,
                       json_each(COALESCE(json_extract(d.vision, '$.subjects'), '[]')) AS subject
                   WHERE d.asset_id = assets.id
                     AND subject.value IN (${placeholders(subjects.length)}))`,
    params: [...subjects],
  };
}

/** A numeric range over one column, or nothing when neither bound is set. */
function rangeTerms(column: string, min: number | undefined, max: number | undefined): Term[] {
  return [
    ...(min === undefined ? [] : [{ sql: `${column} >= ?`, params: [min] }]),
    ...(max === undefined ? [] : [{ sql: `${column} <= ?`, params: [max] }]),
  ];
}

/**
 * The EXIF fields that are stored columns, and the two that are not.
 *
 * `iso` has a generated column because a facet reports its range. `aperture`
 * and `focal_length` are filtered but never grouped or sorted, so the schema
 * leaves them in the JSON and this reads them out of it — the same trade the
 * Mongo side makes, where neither has an index either.
 */
const APERTURE = `'$.aperture'`;
const FOCAL_LENGTH = `'$.focal_length'`;

/**
 * A numeric range over a value inside the `exif` JSON, bracketed by type.
 *
 * SQLite orders every number before every string, so a payload that stored
 * `"aperture": "2.8"` as a JSON *string* would satisfy `>= 2.8` — and `>= 22`,
 * and every other `apertureMin` a caller can send. MongoDB's `$gte` compares
 * only within a type, so that document matches nothing there. The `json_type`
 * guard restores the bracket: only a real number is compared, and a string, an
 * object or a missing key drops out exactly as it does today.
 *
 * The indexer writes both fields through a numeric coercion, so this is not a
 * shape it produces; it is a shape the JSON column cannot rule out, and the
 * guard is free — neither field has an index on either engine.
 */
function exifRangeTerms(path: string, min: number | undefined, max: number | undefined): Term[] {
  if (min === undefined && max === undefined) return [];
  return [
    { sql: `json_type(assets.exif, ${path}) IN ('integer', 'real')`, params: [] },
    ...rangeTerms(`json_extract(assets.exif, ${path})`, min, max),
  ];
}

/** The structured EXIF filters: three ranges and a capture window. */
export function exifTerms(q: SearchQuery): Term[] {
  return [
    ...rangeTerms('assets.iso', asNumber(q.isoMin), asNumber(q.isoMax)),
    ...exifRangeTerms(APERTURE, asNumber(q.apertureMin), asNumber(q.apertureMax)),
    ...exifRangeTerms(FOCAL_LENGTH, asNumber(q.focalMin), asNumber(q.focalMax)),
    // `captured_at` is an ISO 8601 string, so a lexicographic compare is a date
    // compare. A bare `YYYY-MM-DD` is widened to the whole day first, or
    // `to=2025-07-31` would skip every photo taken on the 31st. NULL never
    // satisfies a comparison, which is the type bracketing Mongo gave for free.
    ...(q.from === undefined
      ? []
      : [{ sql: 'assets.captured_at >= ?', params: [widenFromDate(q.from)] }]),
    ...(q.to === undefined
      ? []
      : [{ sql: 'assets.captured_at <= ?', params: [widenToDate(q.to)] }]),
    ...(q.hasCapturedAt === 'true' ? [{ sql: 'assets.captured_at IS NOT NULL', params: [] }] : []),
  ];
}

/**
 * The scalar grid filters: month, rating, flag, colour, screenshot, hidden.
 *
 * `isScreenshot=false` is `IS NOT 1`, not `= 0`, and the difference is the whole
 * result set rather than an edge case. `is_screenshot` is deliberately tri-state
 * — `CHECK (is_screenshot IS NULL OR is_screenshot IN (0, 1))` — where NULL
 * means the describe stage has not classified this asset yet. `= 0` excludes
 * NULL, so it would have matched only assets already classified as
 * not-a-screenshot and silently hidden every unclassified one. On a library
 * mid-enrichment that is most of it, and the generated-search worker forces
 * `isScreenshot: 'false'` on every query it evaluates, so it would have measured
 * zero results for every collection it proposed.
 *
 * `IS NOT 1` is the direct equivalent of the `$ne: true` this replaces: it
 * matches 0 and NULL alike, which is what "not a screenshot" means to a client.
 *
 * `hidden` keeps `= 0` because that column really is `NOT NULL DEFAULT 0` — the
 * asymmetry is in the schema, not an oversight here.
 */
export function gradeTerms(q: SearchQuery, flag: -1 | 0 | 1 | undefined): Term[] {
  // An out-of-range or non-integer month is dropped rather than passed through:
  // a filter matching nothing is worse than no filter, because the
  // generated-search worker reads the result count as a quality signal.
  const month = asNumber(q.month);
  const usableMonth = month !== undefined && Number.isInteger(month) && month >= 1 && month <= 12;
  const rating = asNumber(q.rating);
  return [
    ...(usableMonth ? [{ sql: 'assets.captured_month = ?', params: [month!] }] : []),
    ...(rating === undefined ? [] : [{ sql: 'assets.rating >= ?', params: [rating] }]),
    ...(flag === undefined ? [] : [{ sql: 'assets.flag = ?', params: [flag] }]),
    ...(q.color === undefined ? [] : [{ sql: 'assets.color_label = ?', params: [q.color] }]),
  ];
}

/** What the caller is allowed to see: screenshots, and hidden assets. */
export function visibilityTerms(q: SearchQuery): Term[] {
  const screenshot =
    q.isScreenshot === 'true'
      ? `assets.is_screenshot = 1`
      : q.isScreenshot === 'false'
        ? `assets.is_screenshot IS NOT 1`
        : null;
  const hidden = q.hidden === 'only' ? 1 : q.hidden === 'all' ? null : 0;
  return [
    ...(screenshot === null ? [] : [{ sql: screenshot, params: [] }]),
    ...(hidden === null ? [] : [{ sql: `assets.hidden = ${hidden}`, params: [] }]),
  ];
}

/**
 * The scope chip.
 *
 * `places` tests `gps_lat` rather than the whole `exif.gps` object the Mongo
 * clause tests, because that is the indexed column and an asset cannot have a
 * GPS fix without a latitude. `people` is an uncorrelated `IN`: `faces` carries
 * no plain `asset_id` index — both of its indexes are partial on assignment and
 * visibility — so a correlated `EXISTS` would scan the table once per candidate
 * asset. `albums` adds nothing; the route short-circuits before it reaches SQL.
 */
export function scopeTerms(scope: string | undefined): Term[] {
  if (scope === 'places') return [{ sql: 'assets.gps_lat IS NOT NULL', params: [] }];
  if (scope === 'people') {
    return [{ sql: 'assets.id IN (SELECT f.asset_id FROM faces f)', params: [] }];
  }
  return [];
}
