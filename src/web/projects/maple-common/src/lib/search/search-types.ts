// Shared types for the responsive-program S7 search feature.
//
// The S7 UI ("All / Photos / Places / People / Albums") presents a single
// `SearchScope` enum to the user, but only `all` and `photos` are wired to
// the live backend today — `places`, `people`, and `albums` await a
// server-side `scope` param or per-scope endpoints (see s7-search spec §6
// "Risks"). When those scopes resolve they will map into `SearchParams`
// extensions, not into a client-side filter on the existing `results` array.
//
// `TopHit` mirrors the spec's mixed-kind row (photo / place / album /
// keyword / person). For v0.1 every hit is `kind: 'photo'` — derived from
// the head of `SearchResponse.results` — until the backend exposes a
// dedicated `/api/search/tophits` (or facets-derived buckets). Keep the
// union open so the renderer doesn't need re-wiring when real top-hits
// arrive.

import { SearchResult } from '../api/search.service';
import { TypedStorage } from '../util/typed-storage';

export type SearchScope = 'all' | 'photos' | 'places' | 'people' | 'albums';

export const SEARCH_SCOPES: readonly SearchScope[] = [
  'all',
  'photos',
  'places',
  'people',
  'albums',
] as const;

export type TopHitKind = 'photo' | 'place' | 'album' | 'keyword' | 'person';

/** Mixed-kind row in the TOP HITS section. v0.1 is photo-only. */
export interface TopHit {
  kind: TopHitKind;
  /** Stable id — for photos this is the `fs:` id from `SearchResult`. */
  id: string;
  /** Headline label (filename for photos, place name for places, etc.). */
  label: string;
  /** Optional sub-label (camera + lens for photos, photo-count for places). */
  subLabel?: string;
  /** Optional thumbnail URL — when absent, the renderer falls back to a
   * kind-specific icon. */
  thumbUrl?: string | null;
  /** Original `SearchResult` when `kind === 'photo'` so callers can route
   * to the editor without re-fetching. */
  source?: SearchResult;
}

/** Derive a `TopHit[]` from a `SearchResponse.results` array. v0.1 contract:
 * the head of `results` is the top-hits list, capped at 3. When a real
 * top-hits endpoint lands this helper becomes a true adapter (or is
 * replaced by a separate fetcher); the component reads from `topHits()`
 * either way. */
export function topHitsFromResults(results: readonly SearchResult[], max = 3): TopHit[] {
  return results.slice(0, max).map((r) => ({
    kind: 'photo' as const,
    id: r.id,
    label: r.filename,
    subLabel: cameraSubLabel(r),
    thumbUrl: null,
    source: r,
  }));
}

function cameraSubLabel(r: SearchResult): string | undefined {
  if (!r.camera) return undefined;
  const make = r.camera.make ?? '';
  const model = r.camera.model ?? '';
  const cam = [make, model].filter(Boolean).join(' ').trim();
  return cam.length > 0 ? cam : undefined;
}

/** Local-storage key for the recents list. New in S7 (#622); no collision. */
export const RECENT_QUERIES_KEY = 'cm.search.recent';
/** Cap on persisted recent queries — spec §2.6. */
export const RECENT_QUERIES_MAX = 10;

/** Push `q` onto a recent-queries list, dedup'd + capped. Pure so the
 * component, the spec, and a future server-sync helper share one
 * algorithm. Empty / whitespace-only queries are ignored. */
export function pushRecent(prev: readonly string[], q: string): string[] {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [...prev];
  const without = prev.filter((p) => p !== trimmed);
  return [trimmed, ...without].slice(0, RECENT_QUERIES_MAX);
}

/** Read the recents list from localStorage. Returns `[]` on parse error,
 * SSR (no `window`), or absent key. */
export function readRecents(): string[] {
  const parsed = TypedStorage.get<unknown[]>(RECENT_QUERIES_KEY);
  if (!parsed || !Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_QUERIES_MAX);
}

/** Persist the recents list. Best-effort — failures (private mode, quota)
 * are swallowed so the search UI stays functional. */
export function writeRecents(list: readonly string[]): void {
  TypedStorage.set(RECENT_QUERIES_KEY, list.slice(0, RECENT_QUERIES_MAX));
}
