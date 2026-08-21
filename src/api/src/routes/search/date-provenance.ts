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
 * The applied window in wire form, or `undefined` when no date constrains
 * the query. Bounds are widened exactly as `buildFilter` widens them, so
 * what a client displays is what Mongo compared against.
 *
 * `original` is the query BEFORE date extraction — the parse is re-run here
 * to decide attribution. Pass the SAME `now` as `extractDatesFromQuery` so
 * the two cannot disagree across a midnight boundary.
 */
export function appliedDateFilter(
  resolved: SearchQuery,
  original: SearchQuery,
  now: Date = new Date(),
): AppliedDateFilter | undefined {
  if (!resolved.from && !resolved.to) return undefined;
  const from = resolved.from ? widenFromDate(resolved.from) : undefined;
  const to = resolved.to ? widenToDate(resolved.to) : undefined;
  const text = original.placeQuery;
  const parsed = text && text.trim().length > 0 ? parseNlDateRange(text, now) : null;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(contributed(parsed, from, to) ? { inferredFrom: parsed!.matched } : {}),
  };
}

/**
 * Whether the parsed window actually SET one of the final bounds.
 *
 * `extractDatesFromQuery` intersects the parse with any explicit `from`/`to`,
 * tightest-bound-wins. When an explicit param wins both ends the window on
 * screen is the user's own, and attributing it to their search text would
 * tell them something untrue about their own query (#2960).
 */
function contributed(
  parsed: ReturnType<typeof parseNlDateRange>,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (parsed === null) return false;
  const setFrom = parsed.from !== undefined && from === widenFromDate(parsed.from);
  const setTo = parsed.to !== undefined && to === widenToDate(parsed.to);
  return setFrom || setTo;
}
