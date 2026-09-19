/**
 * The `/api/search*` query string: how it is parsed, and the vocabulary the
 * SQLite `WHERE` builder is written against.
 *
 * Every search endpoint (`/api/search`, `/facets`, `/buckets`, and
 * `/api/map/clusters`) accepts the same bag of strings, declared once as
 * `SearchQueryT` in `query-schema.ts` and re-exported here so importers keep
 * a single entry point. What lives in this file is everything needed to turn
 * those raw strings into values a query builder can trust: the closed
 * vocabularies a bad value is checked against (colour labels, scene types,
 * scope chips, flag names), the small numeric and date coercions, and
 * `extractDatesFromQuery`, which lifts a natural-language date out of the
 * free-text `placeQuery` and folds it into the structured `from`/`to` bounds.
 *
 * Nothing here builds a query. Translating a parsed query into SQL is the job
 * of `db/sqlite/repos/search.where.ts` (the predicates and their bound
 * values), `search.terms.ts` (the individual clauses) and `search.page.ts`
 * (paging). Those import the vocabularies below rather than restating them,
 * so a value the route accepts and the builder rejects cannot drift apart.
 */

import { parseNlDateRange } from './nl-date.ts';
import { COLOR_LABELS as XMP_COLOR_LABELS } from '../../xmp/color-label.ts';
import type { SearchQuery } from './query-schema.ts';

/** `''` (no label) plus the full XMP color-label vocabulary — kept in sync
 * with the XMP parser/serializer via `XMP_COLOR_LABELS` so every label the
 * writers accept is filterable here (#1657). */
export const SEARCHABLE_COLOR_LABELS = new Set(['', ...XMP_COLOR_LABELS]);

export const SCENE_TYPES = new Set(['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed']);

/** UI scope chip values. `photos` (the default) returns the full live set;
 * the others narrow the result set to assets whose underlying field is
 * non-empty. `albums` has no backing field today — see `list.ts` for the
 * short-circuit + `notImplemented` flag.
 *
 * The set is exported so the route schema and tests share one source of
 * truth and a typo on the wire surfaces as a 400 instead of being silently
 * ignored. */
export const SEARCH_SCOPES = new Set(['photos', 'places', 'people', 'albums']);
export type SearchScope = 'photos' | 'places' | 'people' | 'albums';

export const FLAG_BY_NAME: Record<string, -1 | 0 | 1> = {
  pick: 1,
  none: 0,
  reject: -1,
};

export function clampInt(value: string | undefined, lo: number, hi: number, def: number): number {
  if (value === undefined) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function asNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// The `people`/`place` wire-term parsing and the place-label decomposition
// live in `filter-terms.ts` (file-size budget split, mirroring
// `query-schema.ts`) — re-exported here so importers keep one entry point.
export { parsePlaceLabels, peopleNames, placeLabelClause } from './filter-terms.ts';

/** Bare-date detector: matches `YYYY-MM-DD` with no time component. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Widen a `from` date to the start of the day if no time component is set,
 * so the lexicographic compare against ISO datetimes is correct. */
export function widenFromDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T00:00:00.000Z` : s;
}

/** Widen a `to` date to the end of the day if no time component is set, so
 * the upper bound still includes photos captured on that day. */
export function widenToDate(s: string): string {
  return BARE_DATE.test(s) ? `${s}T23:59:59.999Z` : s;
}

/**
 * Pull a natural-language date out of `placeQuery` and fold it into the
 * structured `from`/`to` fields. Returns a shallow clone of `q` with:
 *   - `from`/`to` intersected with any parsed range (max-of-froms,
 *     min-of-tos so an explicit param always tightens, never loosens), and
 *   - the matched date substring stripped from `placeQuery`.
 *
 * Conservative by construction — `parseNlDateRange` only fires on clear
 * date tokens, so non-date text is returned untouched. Pure; call it on the
 * parsed query before handing it to the where-builder. The `now` argument is
 * injectable for tests.
 */
export function extractDatesFromQuery(q: SearchQuery, now: Date = new Date()): SearchQuery {
  const placeQuery = q.placeQuery;
  if (!placeQuery || placeQuery.trim().length === 0) return q;
  const parsed = parseNlDateRange(placeQuery, now);
  if (!parsed) return q;

  const out: SearchQuery = { ...q };

  // Intersect, comparing the *widened* forms so an explicit param carrying a
  // time component (e.g. `to=2024-06-30T00:00:00Z`) is measured against the
  // parsed bare date on the same scale — a naive lexicographic compare treats
  // the bare date as a prefix and would let it loosen the bound. The tightest
  // bound wins (max-of-froms, min-of-tos); an explicit param can only tighten.
  // Store the normalized value — downstream `widen*Date` is idempotent on it.
  if (parsed.from) {
    const candidate = widenFromDate(parsed.from);
    const explicit = q.from ? widenFromDate(q.from) : undefined;
    out.from = explicit && explicit > candidate ? explicit : candidate;
  }
  if (parsed.to) {
    const candidate = widenToDate(parsed.to);
    const explicit = q.to ? widenToDate(q.to) : undefined;
    out.to = explicit && explicit < candidate ? explicit : candidate;
  }

  // Strip the consumed substring from the residual free-text query, then
  // collapse the whitespace it leaves behind. Only the first occurrence is
  // removed — the parser matched exactly one span.
  if (parsed.matched && parsed.matched.length > 0) {
    const idx = placeQuery.toLowerCase().indexOf(parsed.matched.toLowerCase());
    let residual = placeQuery;
    if (idx >= 0) {
      residual = placeQuery.slice(0, idx) + placeQuery.slice(idx + parsed.matched.length);
    }
    residual = residual.replace(/\s+/g, ' ').trim();
    out.placeQuery = residual;
  }

  return out;
}

// The query-string schema + its TS mirror live in `query-schema.ts` —
// re-exported here so every existing importer keeps reaching them through
// this module. Split out in #2129 to keep this file inside the file-size
// budget (CONTRIBUTING.md § "File-size budget").
export type { SearchQuery } from './query-schema.ts';
export { SearchQueryT } from './query-schema.ts';
