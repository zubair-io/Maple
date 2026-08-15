// Unified-search filter model (#2865) — the pure state + derivations behind
// the search bar's inline chips, the Filters panel, and the `@` tag picker.
//
// One immutable `SearchFilters` value flows through the whole page: the
// panel edits it, the bar renders it as chips, and `filtersToParams`
// translates it into the `/api/search` wire params (`from`/`to`, `people`,
// `place`). Date preset and custom range are mutually exclusive — setting
// either side clears the other so the active-chip list never shows two
// date chips.

import type { SearchParams } from '../api/search.service';

export type DatePreset = 'today' | 'last7' | 'last30' | 'thisYear';

export const DATE_PRESETS: ReadonlyArray<{ id: DatePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisYear', label: 'This year' },
];

export interface SearchFilters {
  readonly datePreset: DatePreset | null;
  /** Custom range bounds as bare `YYYY-MM-DD` dates (the server widens
   * them to full-day bounds). Either side may be null. */
  readonly from: string | null;
  readonly to: string | null;
  /** Selected person display names (facets `people` values). */
  readonly people: readonly string[];
  /** Selected place labels (facets `places` values). */
  readonly places: readonly string[];
}

export const EMPTY_FILTERS: SearchFilters = {
  datePreset: null,
  from: null,
  to: null,
  people: [],
  places: [],
};

export function hasActiveFilters(f: SearchFilters): boolean {
  return activeFilterCount(f) > 0;
}

/** Chip-count for the Filters-button badge: each person and place counts
 * one; the date dimension (preset OR custom range) counts one in total. */
export function activeFilterCount(f: SearchFilters): number {
  const dateActive = f.datePreset !== null || f.from !== null || f.to !== null;
  return f.people.length + f.places.length + (dateActive ? 1 : 0);
}

export interface ActiveFilterChip {
  readonly kind: 'date' | 'person' | 'place';
  readonly label: string;
}

/** The bar's inline chip list, date first (mirrors the design's ordering:
 * date, people, places). */
export function activeFilterChips(f: SearchFilters): ActiveFilterChip[] {
  const dateLabel = dateChipLabel(f);
  return [
    ...(dateLabel !== null ? [{ kind: 'date' as const, label: dateLabel }] : []),
    ...f.people.map((p) => ({ kind: 'person' as const, label: p })),
    ...f.places.map((p) => ({ kind: 'place' as const, label: p })),
  ];
}

/** Human label for the active date dimension, or null when none. */
export function dateChipLabel(f: SearchFilters): string | null {
  if (f.datePreset !== null) {
    return DATE_PRESETS.find((p) => p.id === f.datePreset)?.label ?? null;
  }
  if (f.from !== null && f.to !== null) return `${f.from} – ${f.to}`;
  if (f.from !== null) return `From ${f.from}`;
  if (f.to !== null) return `Until ${f.to}`;
  return null;
}

/** Removing a chip clears the matching dimension/value. */
export function removeChip(f: SearchFilters, chip: ActiveFilterChip): SearchFilters {
  switch (chip.kind) {
    case 'date':
      return { ...f, datePreset: null, from: null, to: null };
    case 'person':
      return { ...f, people: f.people.filter((p) => p !== chip.label) };
    case 'place':
      return { ...f, places: f.places.filter((p) => p !== chip.label) };
  }
}

export function togglePerson(f: SearchFilters, name: string): SearchFilters {
  const people = f.people.includes(name) ? f.people.filter((p) => p !== name) : [...f.people, name];
  return { ...f, people };
}

export function togglePlace(f: SearchFilters, label: string): SearchFilters {
  const places = f.places.includes(label)
    ? f.places.filter((p) => p !== label)
    : [...f.places, label];
  return { ...f, places };
}

/** Tapping the active preset clears it; tapping another switches. Either
 * way any custom range is dropped (mutually exclusive dimensions). */
export function togglePreset(f: SearchFilters, preset: DatePreset): SearchFilters {
  const datePreset = f.datePreset === preset ? null : preset;
  return { ...f, datePreset, from: null, to: null };
}

/** Custom-range edit: non-empty input wins over the preset. */
export function setCustomRange(
  f: SearchFilters,
  from: string | null,
  to: string | null,
): SearchFilters {
  const cleared = from === null && to === null;
  return { ...f, from, to, datePreset: cleared ? f.datePreset : null };
}

/** Local `YYYY-MM-DD` for `d` — presets are user-local calendar ranges,
 * so `toISOString` (UTC) would be off by one day east of Greenwich. */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Resolve a preset to bare-date bounds. Open-ended `to` (today) is
 * omitted so the server doesn't exclude photos with clock-skewed future
 * timestamps. */
export function presetRange(preset: DatePreset, now: Date): { from: string; to: string | null } {
  const day = 24 * 60 * 60 * 1000;
  switch (preset) {
    case 'today':
      return { from: localDate(now), to: null };
    case 'last7':
      return { from: localDate(new Date(now.getTime() - 6 * day)), to: null };
    case 'last30':
      return { from: localDate(new Date(now.getTime() - 29 * day)), to: null };
    case 'thisYear':
      return { from: `${now.getFullYear()}-01-01`, to: null };
  }
}

/** Wire params for the current filters. `now` is injectable for tests. */
export function filtersToParams(
  f: SearchFilters,
  now: Date = new Date(),
): Pick<SearchParams, 'from' | 'to' | 'people' | 'place'> {
  const range = f.datePreset !== null ? presetRange(f.datePreset, now) : { from: f.from, to: f.to };
  return {
    ...(range.from !== null ? { from: range.from } : {}),
    ...(range.to !== null ? { to: range.to } : {}),
    ...(f.people.length > 0 ? { people: [...f.people] } : {}),
    ...(f.places.length > 0 ? { place: [...f.places] } : {}),
  };
}
