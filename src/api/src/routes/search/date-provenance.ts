/**
 * What the search response tells clients about the capture-date window it
 * applied.
 *
 * Split out of `query.ts` rather than added to it: that file was already at
 * 563 lines against the repo's 600-line hard ceiling, and this is a distinct
 * concern — `query.ts` decides what the filter IS, this decides how to
 * describe it on the wire.
 *
 * The reason it exists at all: the window was applied but never reported, so
 * no client could show it. `august` quietly filtered to August 2025 while the
 * Filters panel stayed empty — the state a user reported as "I did not have a
 * date selected" (#2956).
 */

import { parseNlDateRange } from './nl-date.ts';
import { widenFromDate, widenToDate, type SearchQuery } from './query.ts';

/** The date window actually in effect, as reported to clients so they can
 * show it. `inferredFrom` is present only when the window came out of the
 * user's own search text — the case that was previously invisible and drew
 * "I did not have a date selected" (#2956). */
export interface AppliedDateFilter {
  from?: string;
  to?: string;
  inferredFrom?: string;
}

/**
 * The exact substring `extractDatesFromQuery` consumes from this query, or
 * `undefined` when the text carries no date.
 *
 * Same parse, surfaced rather than discarded. Pass the SAME `now` as the
 * extraction so the two cannot disagree across a midnight boundary.
 */
export function dateTextConsumedBy(q: SearchQuery, now: Date = new Date()): string | undefined {
  const placeQuery = q.placeQuery;
  if (!placeQuery || placeQuery.trim().length === 0) return undefined;
  return parseNlDateRange(placeQuery, now)?.matched;
}

/**
 * The applied window in wire form, or `undefined` when no date constrains
 * the query. Bounds are widened exactly as `buildFilter` widens them, so
 * what a client displays is what Mongo compared against.
 */
export function appliedDateFilter(
  resolved: SearchQuery,
  inferredFrom: string | undefined,
): AppliedDateFilter | undefined {
  if (!resolved.from && !resolved.to) return undefined;
  return {
    ...(resolved.from ? { from: widenFromDate(resolved.from) } : {}),
    ...(resolved.to ? { to: widenToDate(resolved.to) } : {}),
    ...(inferredFrom ? { inferredFrom } : {}),
  };
}
