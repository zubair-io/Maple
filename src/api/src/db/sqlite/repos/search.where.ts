/**
 * `buildFilter` + `applyLiveFilter` for SQLite — the `/api/search*` query
 * string as a `WHERE` clause and its bound parameters.
 *
 * Same input as the Mongo version in `routes/search/query.ts`: the parsed query
 * string, the person ids to exclude, and the person ids the `people` names
 * resolved to. Same validation, in the same order, returning the same `{ error }`
 * sentences, so a request that is a 400 today is a 400 after the cutover with
 * the same message. The two resolver calls that produce those id lists stay in
 * the route: they read the `people` collection, which this slice does not port.
 *
 * ## Three shapes that are load-bearing
 *
 * **Anything that filters by a location, a face or a detail payload is a
 * semi-join.** `EXISTS` and `IN (SELECT …)` keep `assets` as the outer loop, so
 * the ordered partial index behind a grid page can stop at the limit. Written
 * as an inner join the planner is free to lead with `asset_locations`, scan a
 * whole library and sort every row of it to return 200: measured at 50.18 ms
 * against 0.07 ms. `docs/sqlite-schema.md` records it.
 *
 * **The live predicate is spelled exactly one way.** SQLite only uses a partial
 * index when the query's own `WHERE` provably implies the index's, and the
 * implication test is textual enough that a paraphrase silently loses the
 * index. {@link LIVE_ASSET_PREDICATE} is imported from the DDL, never retyped,
 * and {@link searchWhereSql} always puts it first.
 *
 * **`assets` is never aliased, and every residual column is qualified.** The
 * live predicate names bare columns, so the table it belongs to has to be the
 * only one in scope that has them, and an alias would break the textual
 * implication test above. Every other column says `assets.<name>` because these
 * clauses also run inside the people facet, whose `FROM` leads with `faces` —
 * and `faces` has a `hidden` column too, so an unqualified `hidden = 0` is an
 * "ambiguous column name" error rather than a wrong answer.
 *
 * ## Two places this deliberately answers differently from Mongo
 *
 * **Library scope counts only live locations.** `{'fileinfo.library_id': id}`
 * matches an asset through a location that was deleted or has gone missing, so
 * an asset whose only surviving copy is in another library still appears in
 * this library's grid — with a path that resolves to the other library, because
 * the projection picks the first *live* entry. The `EXISTS` here requires the
 * matching location to be live, which is also what lets it use
 * `asset_locations_library_live`, the partial index the schema defines for it.
 *
 * **A face filter ignores hidden faces explicitly.** Mongo relies on hiding a
 * face nulling its `person_id`, so an id match cannot reach one. That stays
 * true, and `hidden = 0` is added anyway because `faces_person` is partial over
 * it and the clause would otherwise not use the index at all.
 */

import { ObjectId } from 'mongodb';
import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import { placeholders } from './assets.sql.ts';
import { toMatchExpression } from './search.fts.ts';
import type { SqlValue } from '../protocol.ts';
import { parsePlaceLabels } from '../../../routes/search/filter-terms.ts';
import {
  asNumber,
  FLAG_BY_NAME,
  SCENE_TYPES,
  SEARCH_SCOPES,
  SEARCHABLE_COLOR_LABELS,
  widenFromDate,
  widenToDate,
  type SearchQuery,
} from '../../../routes/search/query.ts';

/** One predicate and the values it binds, in matching order. */
interface Term {
  sql: string;
  params: SqlValue[];
}

/**
 * A translated query: the residual predicates, their parameters, and the
 * full-text expression when one was asked for.
 *
 * `match` is separate from `clauses` because a text query changes the *shape*
 * of the statement rather than adding a predicate to it — the page query joins
 * `assets_fts` and orders by `bm25()`, which no residual can express. See
 * `search.sql.ts`.
 */
export interface SearchWhere {
  clauses: readonly string[];
  params: readonly SqlValue[];
  match: string | null;
}

/** A translated query, or the 400 the route should answer instead. */
export type SearchWhereResult = SearchWhere | { error: string };

/** Escape a user string for `LIKE … ESCAPE '\'`. */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** `LIKE` pattern matching `value` anywhere in the column. */
function contains(value: string): string {
  return `%${likeLiteral(value)}%`;
}

/** A trimmed parameter, or `undefined` when it carries nothing. */
function text(value: string | undefined): string | undefined {
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
function freeTextTerm(value: string): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id
                     AND (l.filename LIKE ? ESCAPE '\\' OR l.path LIKE ? ESCAPE '\\'))`,
    params: [contains(value), contains(value)],
  };
}

/** Library scope. Live-only — see the module comment. */
function libraryTerm(libraryId: string): Term {
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
 * `LIKE` for its descendants.
 */
function pathPrefixTerm(prefix: string): Term {
  return {
    sql: `EXISTS (SELECT 1 FROM asset_locations l
                   WHERE l.asset_id = assets.id
                     AND (l.path = ? OR l.path LIKE ? ESCAPE '\\'))`,
    params: [prefix, `${likeLiteral(prefix)}/%`],
  };
}

/** Extension whitelist, matched against any of an asset's filenames. */
function extensionTerm(extensions: readonly string[]): Term {
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
 * The inverse of `placeLabel` in `routes/search/facets.ts`, and it has to stay
 * the inverse: a label that does not parse back into the tuple it was built
 * from is a filter chip that returns nothing. "locality, region" splits on the
 * last `", "`; a bare label is either half, with the other blank, so it matches
 * both. Blank means NULL or the empty string, exactly as the Mongo clause's
 * `$in: [null, '']` did.
 */
function placeLabelTerm(label: string): Term {
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
function orGroup(terms: readonly Term[]): Term {
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
 * that index once per person per candidate asset as the grid walks. An empty id
 * list must match nothing rather than everything, which is what `IN ()` would
 * have meant on Mongo and what the constant false says here.
 */
function peopleTerm(personIds: readonly string[]): Term {
  if (personIds.length === 0) return { sql: '0', params: [] };
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
function excludedPeopleTerm(personIds: readonly string[]): Term {
  const inner = peopleTerm(personIds);
  return { sql: `NOT (${inner.sql})`, params: inner.params };
}

/** One of the two `vision` columns the detail table generates and indexes. */
function visionTerm(column: 'vision_scene_type' | 'vision_activity', value: string): Term {
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
function subjectsTerm(subjects: readonly string[]): Term {
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
const APERTURE = `json_extract(assets.exif, '$.aperture')`;
const FOCAL_LENGTH = `json_extract(assets.exif, '$.focal_length')`;

/** The structured EXIF filters: three ranges and a capture window. */
function exifTerms(q: SearchQuery): Term[] {
  return [
    ...rangeTerms('assets.iso', asNumber(q.isoMin), asNumber(q.isoMax)),
    ...rangeTerms(APERTURE, asNumber(q.apertureMin), asNumber(q.apertureMax)),
    ...rangeTerms(FOCAL_LENGTH, asNumber(q.focalMin), asNumber(q.focalMax)),
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
 * `isScreenshot=false` is `is_screenshot = 0` rather than Mongo's `$ne: true`.
 * The column is `NOT NULL DEFAULT 0`, so "classified as not a screenshot" and
 * "never classified" are the same value and the two forms select the same rows.
 * That collapse is tracked as #3761; whichever way it is resolved, this clause
 * keeps matching everything that is not a screenshot, because a nullable column
 * would need `IS NOT 1` and this file would change with it.
 */
function scalarTerms(q: SearchQuery, flag: -1 | 0 | 1 | undefined): Term[] {
  const month = asNumber(q.month);
  const rating = asNumber(q.rating);
  return [
    ...(month !== undefined && Number.isInteger(month) && month >= 1 && month <= 12
      ? [{ sql: 'assets.captured_month = ?', params: [month] }]
      : []),
    ...(rating === undefined ? [] : [{ sql: 'assets.rating >= ?', params: [rating] }]),
    ...(flag === undefined ? [] : [{ sql: 'assets.flag = ?', params: [flag] }]),
    ...(q.color === undefined ? [] : [{ sql: 'assets.color_label = ?', params: [q.color] }]),
    ...(q.isScreenshot === 'true' ? [{ sql: 'assets.is_screenshot = 1', params: [] }] : []),
    ...(q.isScreenshot === 'false' ? [{ sql: 'assets.is_screenshot = 0', params: [] }] : []),
    ...(q.hidden === 'only' ? [{ sql: 'assets.hidden = 1', params: [] }] : []),
    ...(q.hidden === 'only' || q.hidden === 'all'
      ? []
      : [{ sql: 'assets.hidden = 0', params: [] }]),
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
function scopeTerms(scope: string | undefined): Term[] {
  if (scope === 'places') return [{ sql: 'assets.gps_lat IS NOT NULL', params: [] }];
  if (scope === 'people') {
    return [{ sql: 'assets.id IN (SELECT f.asset_id FROM faces f)', params: [] }];
  }
  return [];
}

/** Extensions from the comma-separated `ext` param, or the 400 it earns. */
function parseExtensions(raw: string | undefined): string[] | { error: string } {
  const value = text(raw);
  if (value === undefined) return [];
  const extensions = value
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const invalid = extensions.find((e) => !/^[a-z0-9]+$/.test(e));
  return invalid === undefined ? extensions : { error: `Invalid extension: ${invalid}` };
}

/**
 * Validate every param that can fail, in the order `buildFilter` reaches them,
 * so two invalid params produce the same message on both engines.
 */
function validate(q: SearchQuery): { error: string } | null {
  if (q.libraryId && !ObjectId.isValid(q.libraryId)) return { error: 'Invalid libraryId' };
  if (q.flag !== undefined && q.flag !== '' && FLAG_BY_NAME[q.flag] === undefined) {
    return { error: `Invalid flag: ${q.flag}` };
  }
  if (q.color !== undefined && !SEARCHABLE_COLOR_LABELS.has(q.color)) {
    return { error: `Invalid color: ${q.color}` };
  }
  if (q.pathPrefix !== undefined && q.pathPrefix.length > 1024) {
    return { error: 'pathPrefix too long' };
  }
  if (q.sceneType !== undefined && q.sceneType !== '' && !SCENE_TYPES.has(q.sceneType)) {
    return { error: `Invalid sceneType: ${q.sceneType}` };
  }
  if (q.scope !== undefined && q.scope !== '' && !SEARCH_SCOPES.has(q.scope)) {
    return { error: `Invalid scope: ${q.scope}` };
  }
  return null;
}

/**
 * Translate a `/api/search*` query string into residual predicates and their
 * bound values.
 *
 * Pure, and deliberately so: the two person-id lists it needs are resolved by
 * the caller, exactly as `buildFilter` takes them today, which keeps this
 * directly testable without a database.
 */
export function buildSearchWhere(
  q: SearchQuery,
  excludedPersonIds: readonly string[] = [],
  peoplePersonIds: readonly string[] | null = null,
): SearchWhereResult {
  const invalid = validate(q);
  if (invalid !== null) return invalid;

  const extensions = parseExtensions(q.ext);
  if (!Array.isArray(extensions)) return extensions;

  const freeText = text(q.q);
  const camera = text(q.camera);
  const lens = text(q.lens);
  const activity = text(q.activity);
  const pathPrefix = (q.pathPrefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const subjects = (text(q.subjects) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const placeLabels = parsePlaceLabels(q.place);

  const terms: Term[] = [
    ...(freeText === undefined ? [] : [freeTextTerm(freeText)]),
    ...(q.libraryId ? [libraryTerm(q.libraryId)] : []),
    ...(camera === undefined
      ? []
      : [
          {
            sql: `(assets.camera_make LIKE ? ESCAPE '\\' OR assets.camera_model LIKE ? ESCAPE '\\')`,
            params: [contains(camera), contains(camera)],
          },
        ]),
    ...(placeLabels.length === 0 ? [] : [orGroup(placeLabels.map(placeLabelTerm))]),
    ...(peoplePersonIds === null ? [] : [peopleTerm(peoplePersonIds)]),
    ...(lens === undefined
      ? []
      : [{ sql: `assets.lens LIKE ? ESCAPE '\\'`, params: [contains(lens)] }]),
    ...exifTerms(q),
    ...scalarTerms(q, q.flag === undefined || q.flag === '' ? undefined : FLAG_BY_NAME[q.flag]),
    ...(pathPrefix.length === 0 ? [] : [pathPrefixTerm(pathPrefix)]),
    ...(q.sceneType === undefined || q.sceneType === ''
      ? []
      : [visionTerm('vision_scene_type', q.sceneType)]),
    ...(activity === undefined ? [] : [visionTerm('vision_activity', activity)]),
    ...(subjects.length === 0 ? [] : [subjectsTerm(subjects)]),
    ...(extensions.length === 0 ? [] : [extensionTerm(extensions)]),
    ...scopeTerms(q.scope),
    ...(excludedPersonIds.length === 0 ? [] : [excludedPeopleTerm(excludedPersonIds)]),
  ];

  return {
    clauses: terms.map((term) => term.sql),
    params: terms.flatMap((term) => term.params),
    match: toMatchExpression(text(q.placeQuery) ?? ''),
  };
}

/** A predicate and its bound values, ready to splice into a statement. */
export interface BoundPredicate {
  sql: string;
  params: readonly SqlValue[];
}

/**
 * The live predicate, with its columns qualified.
 *
 * Qualification is not optional here: the extensions facet joins
 * `asset_locations`, which has a `deleted_at` column of its own, and an
 * unqualified reference is an "ambiguous column name" error rather than a wrong
 * answer. Deriving it from {@link LIVE_ASSET_PREDICATE} rather than retyping it
 * is what keeps the two from drifting — a column added to the DDL's spelling
 * and missed here would reintroduce exactly that error, loudly, on the first
 * facet that joins.
 *
 * Qualifying does not cost the partial indexes. SQLite's implication test runs
 * over resolved column references rather than over the text, so
 * `assets.deleted_at` and `deleted_at` are the same node; `search.query-plan.test.ts`
 * pins that with `EXPLAIN QUERY PLAN` rather than leaving it to this comment.
 */
export const QUALIFIED_LIVE_PREDICATE = LIVE_ASSET_PREDICATE.replace(
  /\b(deleted_at|live_location_count)\b/g,
  'assets.$1',
);

/**
 * The `WHERE` clause for a translated query, and its parameters in the order
 * the placeholders appear.
 *
 * Three groups in a fixed order. The full-text `MATCH` comes first because it
 * is the most selective thing any search can carry and the statement reads
 * better led by it. The live predicate is next and verbatim, so the partial
 * indexes apply. Residuals follow, then whatever one statement adds of its own —
 * a seek predicate for the next page, or the timed/untimed split the timeline
 * histogram needs. Those belong to a statement rather than to the query string,
 * which is why they are a parameter here instead of a field on
 * {@link SearchWhere}.
 */
export function searchWhereSql(where: SearchWhere, extra?: BoundPredicate): BoundPredicate {
  const match = where.match === null ? [] : ['assets_fts MATCH ?'];
  const matchParams = where.match === null ? [] : [where.match];
  const clauses = [
    ...match,
    QUALIFIED_LIVE_PREDICATE,
    ...where.clauses,
    ...(extra ? [extra.sql] : []),
  ];
  return {
    sql: `WHERE ${clauses.join('\n     AND ')}`,
    params: [...matchParams, ...where.params, ...(extra?.params ?? [])],
  };
}
