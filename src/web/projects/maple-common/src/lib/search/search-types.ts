// Shared helpers for the unified search page (#2865): the persisted
// recent-queries list. (The S7 scope-chip enum and the derived top-hits
// rows lived here until the unified filter model replaced them.)

import { TypedStorage } from '../util/typed-storage';

/** Local-storage key for the recents list. Shared with the Apple apps
 * (`@AppStorage("cm.search.recent")`) in name only — each platform keeps
 * its own store. */
export const RECENT_QUERIES_KEY = 'cm.search.recent';
/** Cap on persisted recent queries — s7 spec §2.6. */
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
