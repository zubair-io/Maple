// Pure, Angular-free helpers for TimelineViewComponent's client-side
// Year -> Month -> folder grouping. This is the mechanism that replaces
// the old /api/search/buckets aggregation — see
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.
// Kept dependency-free so the fold/merge logic can be unit-tested without
// TestBed.

import { SearchResult } from '../../api/search.service';

export interface PhotoVm extends SearchResult {
  thumbUrl: string | null;
}

/** One calendar month's photos, grouped by the folder name immediately
 * under the search scope's `pathPrefix`. */
export interface MonthGroup {
  year: number;
  month: number;
  /** Map<folderName, photos[]> — '.' means "directly in the scoped folder." */
  groups: Map<string, PhotoVm[]>;
}

export interface YearGroup {
  year: number;
  months: MonthGroup[];
}

export function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

/** Splits an absolute path into the folder name immediately under `prefix`.
 * A photo directly inside the scoped folder (no further subfolder) buckets
 * under '.'.
 *
 * `.startsWith(prefix)` is a safe anchored match (not a bare substring
 * check susceptible to `/Lib` matching `/Lib-old`) because every caller —
 * `TimelineStateService.pathPrefix` — always normalises `prefix` with a
 * trailing slash before it reaches here, so `/Lib/` cannot match
 * `/Lib-old/...`. */
export function folderNameFor(absPath: string, prefix: string): string {
  const rest = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
  const segments = rest.split('/').filter((s) => s.length > 0);
  return segments.length > 1 ? segments[0]! : '.';
}

/**
 * Folds one page of `/api/search` results (already sorted `captured_desc`
 * by the server) into the accumulated Year -> Month structure. Extends the
 * trailing year/month group when a result continues it, opens a new one
 * when it doesn't — this is the entire client-side bucketing mechanism.
 *
 * Rows with no `captured_at` are skipped defensively; the caller always
 * queries with `hasCapturedAt: true`, so this should never trigger.
 *
 * Returns a new array. Only the trailing year (and, within it, the
 * trailing month) is ever cloned/mutated per row — every earlier
 * year/month object keeps its prior identity, so `computed()` consumers
 * over the untouched parts don't needlessly recompute.
 */
export function foldPage(
  years: YearGroup[],
  results: SearchResult[],
  prefix: string,
  thumbCache: ReadonlyMap<string, string>,
): YearGroup[] {
  const next = years.slice();
  for (const r of results) {
    if (!r.captured_at) continue;
    const d = new Date(r.captured_at);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const folderName = folderNameFor(r.abs_path, prefix);
    const thumbUrl = thumbCache.get(r.abs_path) ?? null;
    const vm: PhotoVm = { ...r, thumbUrl };

    let lastYear = next[next.length - 1];
    if (!lastYear || lastYear.year !== year) {
      lastYear = { year, months: [] };
      next.push(lastYear);
    } else {
      lastYear = { ...lastYear, months: lastYear.months.slice() };
      next[next.length - 1] = lastYear;
    }

    let lastMonth = lastYear.months[lastYear.months.length - 1];
    if (!lastMonth || lastMonth.month !== month) {
      lastMonth = { year, month, groups: new Map() };
      lastYear.months.push(lastMonth);
    } else {
      lastMonth = { ...lastMonth, groups: new Map(lastMonth.groups) };
      lastYear.months[lastYear.months.length - 1] = lastMonth;
    }

    const existing = lastMonth.groups.get(folderName);
    lastMonth.groups.set(folderName, existing ? [...existing, vm] : [vm]);
  }
  return next;
}

/** Total photo count across every folder group in a month. */
export function countInMonth(m: MonthGroup): number {
  let n = 0;
  for (const photos of m.groups.values()) n += photos.length;
  return n;
}

function maxCapturedTime(photos: PhotoVm[]): number {
  let max = 0;
  for (const p of photos) {
    if (!p.captured_at) continue;
    const t = Date.parse(p.captured_at);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

/** Render-ready folder groups for one month, sorted by each folder's most
 * recent photo (descending) — matches the original per-month behaviour. */
export function buildGroups(m: MonthGroup): Array<{ folderName: string; photos: PhotoVm[] }> {
  const names = Array.from(m.groups.keys());
  names.sort((a, b) => maxCapturedTime(m.groups.get(b)!) - maxCapturedTime(m.groups.get(a)!));
  return names.map((folderName) => ({ folderName, photos: m.groups.get(folderName)! }));
}
