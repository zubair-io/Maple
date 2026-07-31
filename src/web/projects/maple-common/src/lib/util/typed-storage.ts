// Typed localStorage wrapper — JSON-safe get/set/remove with guards for
// missing/SSR `window` and quota/parse errors.
//
// Usage:
//   import { TypedStorage, STORAGE_KEYS } from '@maple-common';
//
//   TypedStorage.get<string>(STORAGE_KEYS.LAST_SOURCE);    // string | null
//   TypedStorage.set(STORAGE_KEYS.TAB, 'develop');         // void (best-effort)
//   TypedStorage.remove(STORAGE_KEYS.THUMB_SIZE);          // void (best-effort)

/** Canonical `localStorage` keys used across the Maple web app.
 *
 * All keys live in the `cm.*` namespace to distinguish them from third-party
 * values that might share the same origin storage. Keys that are already
 * exported as named constants (e.g. `RECENT_QUERIES_KEY`, `LAST_SOURCE_KEY`)
 * are also listed here so callers have a single import point; the named
 * exports remain in place for backward compatibility. */
export const STORAGE_KEYS = {
  /** Active detail tab ('info' | 'develop'). */
  TAB: 'cm.tab',
  /** Browse view mode ('folder' | 'timeline'). */
  VIEW_MODE: 'cm.viewMode',
  /** Thumbnail density (number, px). */
  THUMB_SIZE: 'cm.thumbSize',
  /** Sort key ('date' | 'name'). */
  SORT: 'cm.sort',
  /** Cull filter ('all' | 'picks' | '4stars' | 'edited'). */
  FILTER: 'cm.filter',
  /** Whether the left sidebar is hidden (boolean). */
  LEFT_HIDDEN: 'cm.leftHidden',
  /** Whether the right inspector panel is hidden (boolean). */
  DETAIL_HIDDEN: 'cm.detailHidden',
  /** Sidebar section expand map (Record<string, boolean>). */
  SECTIONS: 'cm.sections',
  /** Sidebar folder expand map (Record<string, boolean>). */
  FOLDER_OPEN: 'cm.folderOpen',
  /** Last selected Self-Hosted source id. */
  LAST_SOURCE: 'cm.lastSourceId',
  /** Recent search queries (string[]). */
  RECENT_QUERIES: 'cm.search.recent',
  /** Per-browser observability opt-in/opt-out (boolean). */
  OBSERVABILITY_ENABLED: 'cm.observabilityEnabled',
  /** Last operator-set value of the DB-backed GPU live-render gate (boolean,
   * #1062). Warm-start cache: read synchronously at startup so a kill flip
   * this browser has already seen survives a reload with no network. */
  GPU_LIVE_RENDER_ENABLED: 'cm.gpuLiveRenderEnabled',
  /** Whether the Preview surface's docked Info pane is open (boolean, #2405).
   * Defaults to open when unset. Read and written only at tablet+ — the
   * phone bottom sheet keeps its own always-starts-closed session state and
   * never touches this key. */
  PREVIEW_INFO_OPEN: 'cm.preview.infoOpen',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** True when `localStorage` is accessible (not SSR, not security-blocked). */
function isAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Typed, JSON-safe, SSR-safe localStorage wrapper.
 *
 * - `get<T>` returns `T | null` — `null` on absent key, parse failure, or SSR.
 * - `set` is best-effort; quota errors are swallowed so callers need no
 *   try/catch at the point of use.
 * - `remove` is likewise best-effort.
 *
 * Collapsible keys use a dynamic suffix (`cm.coll.<key>`) and are not listed
 * in `STORAGE_KEYS` because they are parameterised; callers build the full
 * key string and pass it directly to `TypedStorage.get/set`.
 */
export const TypedStorage = {
  /**
   * Read and JSON-parse a value.
   * Returns `null` when: key absent, JSON parse fails, localStorage unavailable.
   */
  get<T>(key: string): T | null {
    if (!isAvailable()) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  /**
   * Read a raw string value (no JSON parsing).
   * Returns `null` when: key absent or localStorage unavailable.
   */
  getRaw(key: string): string | null {
    if (!isAvailable()) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  /**
   * JSON-stringify and persist a value. Best-effort — quota errors are
   * swallowed; the in-memory representation wins.
   */
  set(key: string, value: unknown): void {
    if (!isAvailable()) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded or storage blocked — swallow */
    }
  },

  /**
   * Persist a raw string value without JSON serialization. Best-effort.
   */
  setRaw(key: string, value: string): void {
    if (!isAvailable()) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* quota exceeded or storage blocked — swallow */
    }
  },

  /**
   * Remove a key. Best-effort — errors are swallowed.
   */
  remove(key: string): void {
    if (!isAvailable()) return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* swallow */
    }
  },
} as const;
