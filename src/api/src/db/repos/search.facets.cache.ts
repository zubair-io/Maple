/**
 * A short-lived cache of a text search's facets (#4431).
 *
 * The clients ask for a search's facets alongside its first page, again when
 * the search screen is revisited, and once per keystroke-settled query, and a
 * broad text search's facets cost a full-text ranking plus a dozen groupings
 * each time. This keeps an answer for {@link FACET_CACHE_TTL_MS}.
 *
 * ## What the key is
 *
 * The translated query, serialised whole: the full-text expression, every
 * residual clause and its bound values, the visibility mode, the owner and the
 * month. Two query strings that translate the same — different word order of
 * the same stopword-free terms is not one of them — share an entry, and any
 * filter change, including the excluded-people list that the route resolves
 * into a clause, is a different entry at once.
 *
 * ## Why expiry is by time alone
 *
 * What the key cannot see is the library changing underneath: a caption
 * written, an asset hidden, trashed or deleted, a face named. Nothing on the
 * request path is told about those writes, and they arrive from the indexer
 * and the worker stages as well as the API, so an event-driven invalidation
 * would have to be threaded through every one of them. The window is the one
 * `routes/search/total-cache.ts` already accepts for a search's `total` — 30 s
 * — and the cost of staleness is the same kind: a facet chip whose count is a
 * few seconds behind, never a wrong result list, because the list is not
 * served from here.
 *
 * Entries are per database handle (production has the one pool; each test its
 * own connection), hold the in-flight promise so concurrent identical requests
 * share one computation, drop a failed computation at once, and are bounded
 * oldest-first at {@link FACET_CACHE_MAX_ENTRIES}.
 */

import type { SqliteDb } from './db-handle.ts';

export const FACET_CACHE_TTL_MS = 30_000;
export const FACET_CACHE_MAX_ENTRIES = 64;

interface Entry<T> {
  expiresMs: number;
  value: Promise<T>;
}

const byHandle = new WeakMap<SqliteDb, Map<string, Entry<unknown>>>();

function entriesFor(db: SqliteDb): Map<string, Entry<unknown>> {
  const existing = byHandle.get(db);
  if (existing) return existing;
  const created = new Map<string, Entry<unknown>>();
  byHandle.set(db, created);
  return created;
}

/**
 * The cached answer for `query` — the translated `SearchWhere` and anything
 * else the answer depends on — or `compute()`'s, cached for the next caller.
 */
export function cachedFacets<T>(
  db: SqliteDb,
  query: unknown,
  compute: () => Promise<T>,
  nowMs = Date.now(),
): Promise<T> {
  const entries = entriesFor(db);
  const key = JSON.stringify(query);
  const hit = entries.get(key);
  if (hit && hit.expiresMs > nowMs) return hit.value as Promise<T>;
  if (hit) entries.delete(key);
  if (entries.size >= FACET_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  const value = compute();
  const entry: Entry<unknown> = { expiresMs: nowMs + FACET_CACHE_TTL_MS, value };
  entries.set(key, entry);
  value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return value;
}
