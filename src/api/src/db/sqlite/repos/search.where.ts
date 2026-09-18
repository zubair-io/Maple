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
import { toMatchExpression } from './search.fts.ts';
import {
  contains,
  excludedPeopleTerm,
  exifTerms,
  extensionTerm,
  freeTextTerm,
  gradeTerms,
  libraryTerm,
  orGroup,
  pathPrefixTerm,
  peopleTerm,
  placeLabelTerm,
  scopeTerms,
  subjectsTerm,
  text,
  visibilityTerms,
  visionTerm,
  type Term,
} from './search.terms.ts';
import type { SqlValue } from '../protocol.ts';
import { parsePlaceLabels } from '../../../routes/search/filter-terms.ts';
import {
  FLAG_BY_NAME,
  SCENE_TYPES,
  SEARCH_SCOPES,
  SEARCHABLE_COLOR_LABELS,
  type SearchQuery,
} from '../../../routes/search/query.ts';

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
 * Validate every param that can fail up to the point `buildFilter` reaches the
 * extension list.
 *
 * The order is the order that function checks them in, and it is load-bearing
 * rather than cosmetic: a query that is wrong in two ways gets one message, and
 * a client that reads the message should not get a different one after the
 * cutover. The scope check is deliberately *not* here — on Mongo it comes after
 * the extension parse, so it stays after it in {@link buildSearchWhere} too.
 * `search.where.test.ts` runs both builders over the same malformed queries and
 * compares their answers, so this ordering cannot rot silently.
 */
const VALIDATIONS: ReadonlyArray<(q: SearchQuery) => string | null> = [
  (q) => (q.libraryId && !ObjectId.isValid(q.libraryId) ? 'Invalid libraryId' : null),
  (q) =>
    q.flag !== undefined && q.flag !== '' && FLAG_BY_NAME[q.flag] === undefined
      ? `Invalid flag: ${q.flag}`
      : null,
  (q) =>
    q.color !== undefined && !SEARCHABLE_COLOR_LABELS.has(q.color)
      ? `Invalid color: ${q.color}`
      : null,
  (q) => (q.pathPrefix !== undefined && q.pathPrefix.length > 1024 ? 'pathPrefix too long' : null),
  (q) =>
    q.sceneType !== undefined && q.sceneType !== '' && !SCENE_TYPES.has(q.sceneType)
      ? `Invalid sceneType: ${q.sceneType}`
      : null,
];

function validate(q: SearchQuery): { error: string } | null {
  const error = VALIDATIONS.reduce<string | null>((found, check) => found ?? check(q), null);
  return error === null ? null : { error };
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
  if (q.scope !== undefined && q.scope !== '' && !SEARCH_SCOPES.has(q.scope)) {
    return { error: `Invalid scope: ${q.scope}` };
  }

  const terms: Term[] = [
    ...cameraAndLensTerms(q),
    ...placeAndPeopleTerms(q, excludedPersonIds, peoplePersonIds),
    ...exifTerms(q),
    ...gradeTerms(q, q.flag === undefined || q.flag === '' ? undefined : FLAG_BY_NAME[q.flag]),
    ...visibilityTerms(q),
    ...visionTerms(q),
    ...fileTerms(q, extensions),
    ...scopeTerms(q.scope),
  ];

  return {
    clauses: terms.map((term) => term.sql),
    params: terms.flatMap((term) => term.params),
    match: toMatchExpression(text(q.placeQuery) ?? ''),
  };
}

/** The two substring filters over EXIF text. */
function cameraAndLensTerms(q: SearchQuery): Term[] {
  const camera = text(q.camera);
  const lens = text(q.lens);
  return [
    ...(camera === undefined
      ? []
      : [
          {
            sql: `(assets.camera_make LIKE ? ESCAPE '\\' OR assets.camera_model LIKE ? ESCAPE '\\')`,
            params: [contains(camera), contains(camera)],
          },
        ]),
    ...(lens === undefined
      ? []
      : [{ sql: `assets.lens LIKE ? ESCAPE '\\'`, params: [contains(lens)] }]),
  ];
}

/** The place chips, the person picker, and the people to drop. */
function placeAndPeopleTerms(
  q: SearchQuery,
  excludedPersonIds: readonly string[],
  peoplePersonIds: readonly string[] | null,
): Term[] {
  const placeLabels = parsePlaceLabels(q.place);
  return [
    ...(placeLabels.length === 0 ? [] : [orGroup(placeLabels.map(placeLabelTerm))]),
    ...(peoplePersonIds === null ? [] : [peopleTerm(peoplePersonIds)]),
    ...(excludedPersonIds.length === 0 ? [] : [excludedPeopleTerm(excludedPersonIds)]),
  ];
}

/** The three filters over the describe stage's output. */
function visionTerms(q: SearchQuery): Term[] {
  const activity = text(q.activity);
  const subjects = (text(q.subjects) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [
    ...(q.sceneType === undefined || q.sceneType === ''
      ? []
      : [visionTerm('vision_scene_type', q.sceneType)]),
    ...(activity === undefined ? [] : [visionTerm('vision_activity', activity)]),
    ...(subjects.length === 0 ? [] : [subjectsTerm(subjects)]),
  ];
}

/** Everything that reaches `asset_locations`: free text, library, path, type. */
function fileTerms(q: SearchQuery, extensions: readonly string[]): Term[] {
  const freeText = text(q.q);
  const pathPrefix = (q.pathPrefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  return [
    ...(freeText === undefined ? [] : [freeTextTerm(freeText)]),
    ...(q.libraryId ? [libraryTerm(q.libraryId)] : []),
    ...(pathPrefix.length === 0 ? [] : [pathPrefixTerm(pathPrefix)]),
    ...(extensions.length === 0 ? [] : [extensionTerm(extensions)]),
  ];
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
