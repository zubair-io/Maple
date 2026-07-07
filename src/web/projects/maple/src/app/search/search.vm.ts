// Search page — pure view-model module.
//
// Co-located with `search.component.ts` per the `*.vm.ts` pattern adopted
// in #190 (slice 1: info-tab #218, slice 2: workers #291, slice 3:
// people #295). Anything in this file is plain TypeScript: no
// `@angular/*` imports, no `inject()`, no decorators, no signals. The
// component owns DI, signal wiring, route plumbing, debounce timers,
// and side effects; this module owns query-param parsing/coercion,
// CSV-set plumbing, the active-filter predicate, sort/scene/color
// option tables, date-preset math, the `currentParams()` builder, the
// result → view-model adapter, and the small label formatters.
//
// All `@maple-common` types are imported via `import type` so this
// module compiles/tests as plain TS (lesson from the #218 / #291 /
// #295 PR reviews — the barrel may transitively pull Angular).

import type {
  SearchFacets,
  SearchParams,
  SearchResult,
  SearchSceneType,
  SearchSort,
} from '@maple-common';

// ── Constants & option tables ─────────────────────────────────────────────

export const PAGE_SIZE = 100;

export const SORT_LABEL: Record<SearchSort, string> = {
  captured_desc: 'Newest first',
  captured_asc: 'Oldest first',
  name: 'Name',
  rating: 'Rating',
};

export const SCENE_TYPE_OPTIONS: ReadonlyArray<{ value: SearchSceneType; label: string }> = [
  { value: '', label: 'Any' },
  { value: 'indoor', label: 'Indoor' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'aerial', label: 'Aerial' },
  { value: 'macro', label: 'Macro' },
  { value: 'studio', label: 'Studio' },
  { value: 'mixed', label: 'Mixed' },
];

export type ColorValue = '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export type FlagValue = '' | 'pick' | 'reject' | 'none';
export type ScreenshotValue = '' | 'true' | 'false';
export type HiddenValue = '' | 'all' | 'only';

export const COLOR_LABELS: ReadonlyArray<{
  value: ColorValue;
  label: string;
  swatch: string;
}> = [
  { value: '', label: 'Any', swatch: 'transparent' },
  { value: 'red', label: 'Red', swatch: '#e11d48' },
  { value: 'yellow', label: 'Yellow', swatch: '#eab308' },
  { value: 'green', label: 'Green', swatch: '#22c55e' },
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'purple', label: 'Purple', swatch: '#a855f7' },
];

/** Tri-state hidden-image filter. The backend only has two explicit modes
 * (`all`, `only`) — `''` sends no param, which is today's implicit
 * exclude-hidden default, spelled out here so the control isn't ambiguous
 * about what it's filtering. */
export const HIDDEN_OPTIONS: ReadonlyArray<{ value: HiddenValue; label: string }> = [
  { value: '', label: 'Hide hidden' },
  { value: 'all', label: 'Show all' },
  { value: 'only', label: 'Hidden only' },
];

/** Pre-shaped `{value,label}[]` for the sort `<select>`. The component
 * exposes this verbatim so the template binds to a stable array
 * reference rather than re-deriving via `Object.entries` per render. */
export const SORT_OPTIONS: ReadonlyArray<{ value: SearchSort; label: string }> = (
  Object.entries(SORT_LABEL) as Array<[SearchSort, string]>
).map(([value, label]) => ({ value, label }));

// ── Result view model ─────────────────────────────────────────────────────

export interface ResultViewModel extends SearchResult {
  thumbUrl: string | null;
  thumbLoading: boolean;
}

/** Wrap a server search hit in the local view-model. `cachedUrl` is the
 * blob-URL from the per-component thumb cache (or `null` if the thumb
 * still needs to be fetched). `thumbLoading` is true iff the cache
 * missed — the component fires `loadThumb(...)` for those rows. */
export function toResultViewModel(r: SearchResult, cachedUrl: string | null): ResultViewModel {
  return {
    ...r,
    thumbUrl: cachedUrl,
    thumbLoading: cachedUrl === null,
  };
}

// ── Number param coercion ─────────────────────────────────────────────────

/** Parse a string param into a number. Empty/invalid → null. */
export function numOrEmpty(v: string | null | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read a number-input event into a string suitable for the URL (or
 * empty to strip the param). */
export function numString(e: Event): string {
  const v = (e.target as HTMLInputElement).value;
  if (v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}

// ── Enum coercion ─────────────────────────────────────────────────────────
//
// Each `parseFoo` accepts the raw `ParamMap.get(...)` return (string |
// null | undefined) and yields a typed value with a sane default. The
// component used to inline these as `as` casts inside `computed()` —
// pulling them out lets the spec assert the coercion rules.

export function parseFlag(v: string | null | undefined): FlagValue {
  return v === 'pick' || v === 'reject' || v === 'none' ? v : '';
}

export function parseColor(v: string | null | undefined): ColorValue {
  return v === 'red' || v === 'yellow' || v === 'green' || v === 'blue' || v === 'purple' ? v : '';
}

export function parseScreenshot(v: string | null | undefined): ScreenshotValue {
  return v === 'true' || v === 'false' ? v : '';
}

export function parseHidden(v: string | null | undefined): HiddenValue {
  return v === 'all' || v === 'only' ? v : '';
}

export function parseSort(v: string | null | undefined): SearchSort {
  return v === 'captured_asc' || v === 'name' || v === 'rating' ? v : 'captured_desc';
}

export function parseSceneType(v: string | null | undefined): SearchSceneType {
  switch (v) {
    case 'indoor':
    case 'outdoor':
    case 'aerial':
    case 'macro':
    case 'studio':
    case 'mixed':
      return v;
    default:
      return '';
  }
}

export function parseRating(v: string | null | undefined): number {
  const n = Number(v ?? '0');
  return Number.isFinite(n) ? n : 0;
}

// ── CSV ↔ Set plumbing ────────────────────────────────────────────────────

/** Parse a comma-separated URL param into a `Set<string>`. Empty / nullish
 * inputs yield an empty set. Trims and (for the `ext` case) lowercases
 * via the `lower` flag. Used by both `extSelected` and `subjectsSelected`
 * — the only difference is the lowercase rule. */
export function parseCsvSet(
  csv: string | null | undefined,
  opts: { lower?: boolean } = {},
): Set<string> {
  if (!csv) return new Set();
  const lower = opts.lower ?? false;
  return new Set(
    csv
      .split(',')
      .map((s) => {
        const trimmed = s.trim();
        return lower ? trimmed.toLowerCase() : trimmed;
      })
      .filter(Boolean),
  );
}

/** Toggle a value in / out of a CSV-set selection. Returns a sorted CSV
 * suitable for writing back to the URL — sort keeps the URL stable
 * across "toggle A then B" vs "toggle B then A" sequences so back-stack
 * history doesn't get noisy. */
export function toggleCsv(csv: string | null | undefined, value: string): string {
  const next = parseCsvSet(csv);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return Array.from(next).sort().join(',');
}

// ── Active-filter predicate ───────────────────────────────────────────────

/** Minimal reader shape — accepts an Angular `ParamMap` without
 * importing it. `keys` must be iterable; `get` returns the raw string
 * or null. */
export interface QueryParamReader {
  readonly keys: Iterable<string>;
  get(key: string): string | null;
}

/** True when any structured filter (i.e. anything besides q / sort /
 * page / limit) is set. */
export function hasActiveFilters(reader: QueryParamReader | null | undefined): boolean {
  if (!reader) return false;
  for (const k of reader.keys) {
    if (k === 'q' || k === 'sort' || k === 'page' || k === 'limit') continue;
    const v = reader.get(k);
    if (v && v.length > 0) return true;
  }
  return false;
}

// ── currentParams builder ─────────────────────────────────────────────────

/** Plain-record snapshot of the URL-driven signals. The component
 * unwraps its `computed()` values once and passes them in — keeping the
 * builder pure means the spec can assert the empty-string → undefined
 * rules without spinning up signals. */
export interface SearchFormState {
  q: string;
  libraryId: string;
  camera: string;
  lens: string;
  isoMin: number | null;
  isoMax: number | null;
  apertureMin: number | null;
  apertureMax: number | null;
  focalMin: number | null;
  focalMax: number | null;
  from: string;
  to: string;
  rating: number;
  flag: FlagValue;
  color: ColorValue;
  extCsv: string;
  sceneType: SearchSceneType;
  activity: string;
  subjects: ReadonlySet<string>;
  isScreenshot: ScreenshotValue;
  hidden: HiddenValue;
  sort: SearchSort;
}

/** Build the `SearchParams` payload sent to the backend. Empty strings
 * collapse to `undefined` so the server sees an absent filter rather
 * than `""`. The tri-state `isScreenshot` collapses to a real boolean. */
export function buildSearchParams(s: SearchFormState): SearchParams {
  return {
    // The main search box drives content search, not filename matching, so
    // its text goes to `placeQuery` (place + caption + OCR + people, with the
    // Meilisearch semantic/NL-date/person-name path when configured). The URL
    // keeps the short `?q=` key for link compatibility; `s.q` holds that text.
    placeQuery: s.q || undefined,
    libraryId: s.libraryId || undefined,
    camera: s.camera || undefined,
    lens: s.lens || undefined,
    isoMin: s.isoMin ?? undefined,
    isoMax: s.isoMax ?? undefined,
    apertureMin: s.apertureMin ?? undefined,
    apertureMax: s.apertureMax ?? undefined,
    focalMin: s.focalMin ?? undefined,
    focalMax: s.focalMax ?? undefined,
    from: s.from || undefined,
    to: s.to || undefined,
    rating: s.rating > 0 ? s.rating : undefined,
    flag: (s.flag || undefined) as 'pick' | 'reject' | 'none' | undefined,
    color: s.color || undefined,
    ext: s.extCsv || undefined,
    sceneType: (s.sceneType || undefined) as SearchSceneType | undefined,
    activity: s.activity || undefined,
    subjects: s.subjects.size > 0 ? Array.from(s.subjects) : undefined,
    isScreenshot: s.isScreenshot === 'true' ? true : s.isScreenshot === 'false' ? false : undefined,
    hidden: s.hidden === 'all' || s.hidden === 'only' ? s.hidden : undefined,
    sort: s.sort,
  };
}

// ── Date presets ──────────────────────────────────────────────────────────

export type PresetKind = 'last7' | 'last30' | 'thisYear';

/** Compute `{from, to}` ISO date strings (YYYY-MM-DD) for the quick
 * preset buttons. `now` is injected so the spec can assert behaviour
 * without freezing the system clock. */
export function presetDateRange(kind: PresetKind, now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  let from: string;
  if (kind === 'last7') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    from = d.toISOString().slice(0, 10);
  } else if (kind === 'last30') {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    from = d.toISOString().slice(0, 10);
  } else {
    from = `${now.getFullYear()}-01-01`;
  }
  return { from, to };
}

// ── Label helpers ─────────────────────────────────────────────────────────

/** "Make · Model" or "Unknown" when both are nullish. Powers the camera
 * datalist option labels. */
export function cameraLabel(c: { make: string | null; model: string | null }): string {
  return [c.make, c.model].filter(Boolean).join(' · ') || 'Unknown';
}

/** Bucket count for a given scene_type in the current facet snapshot.
 * Returns null when the snapshot is absent or the bucket is missing
 * (so the option label can omit the parenthetical for empty buckets). */
export function sceneTypeCount(
  facets: SearchFacets | null | undefined,
  value: string,
): number | null {
  const buckets = facets?.scene_types;
  if (!buckets) return null;
  const hit = buckets.find((b) => b.value === value);
  return hit ? hit.count : null;
}

/** Human label for the current sort. Falls back to the raw value if a
 * future server-side sort key arrives before the client table updates. */
export function sortLabel(sort: SearchSort): string {
  return SORT_LABEL[sort] ?? sort;
}
