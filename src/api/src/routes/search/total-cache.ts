/**
 * Total-count cache for `GET /api/search` (#2128) and for a saved search's
 * live pages (#6176).
 *
 * On search, `total`'s only consumer is the `canLoadMore` infinite-scroll gate
 * in the two search components (`search.component.ts:144` and `:175`), so brief
 * staleness is not user-visible. A saved search's clients page until they hold
 * `total` rows, so a total up to 30 s old costs at most one empty or short page. Cached for 30 s keyed on the full filter
 * set — mirrors the buckets cache in `buckets.ts` exactly (module-scoped
 * `Map`, same TTL, same `_resetCacheForTests` shape).
 *
 * Extracted from `list.ts` in #2129 to keep that route file inside the
 * file-size budget once seek pagination landed; the behaviour is unchanged.
 *
 * The cache is worth much less than it was. On MongoDB this count was a
 * documented ~2.5 s O(N) scan, because the liveness predicate lived in an
 * unindexable `$elemMatch` over `fileinfo[]` and every candidate had to be
 * fetched. On SQLite it counts the same partial index the page query walks,
 * measured at 3.7 ms at production's row count — so the 30 s window now buys
 * repeat scrolls a few milliseconds rather than seconds. It stays because the
 * staleness it trades for that has never been visible, and removing it would
 * be a behaviour change dressed up as a cleanup.
 */

import { searchCount, type SearchWhere } from '../../db/repos/search.repo.ts';
import { countSql, type BoundStatement } from '../../db/repos/search.sql.ts';
import { normaliseObjectIdHex } from '../../db/object-id.ts';
import type { SqliteDb } from '../../db/repos/db-handle.ts';
import type { SqlValue } from '../../db/sqlite/protocol.ts';
import type { SearchQuery } from './query.ts';

const TOTAL_CACHE_TTL_MS = 30_000;

interface CachedTotal {
  total: number;
  expiresMs: number;
}

const totalCache = new Map<string, CachedTotal>();

/** Fold owner aliases into the same lowercase-hex cache key. */
export function canonicalOwner(q: SearchQuery): string | null {
  const raw = q.owner ?? q.ownerId ?? q.owner_id;
  if (!raw) return null;
  return normaliseObjectIdHex(raw) ?? raw.trim().toLowerCase();
}

/** Every field that feeds `buildSearchWhere` (i.e. the full filter set the
 * count depends on), in a fixed order. `page`/`limit`/`sort`/`cursor` are
 * deliberately excluded because the count doesn't depend on pagination or
 * ordering. `people` and `place` joined the list in #2864, when both became
 * predicates rather than client-side trimming. */
const TOTAL_CACHE_KEY_FIELDS = [
  'pathPrefix',
  'libraryId',
  'q',
  'placeQuery',
  'camera',
  'lens',
  'isoMin',
  'isoMax',
  'apertureMin',
  'apertureMax',
  'focalMin',
  'focalMax',
  'from',
  'to',
  'rating',
  'flag',
  'color',
  'ext',
  'hasCapturedAt',
  'sceneType',
  'activity',
  'subjects',
  'isScreenshot',
  'people',
  'place',
  'scope',
  'hidden',
  'ownerId',
  'owner_id',
  'owner',
  'stack',
] as const satisfies ReadonlyArray<keyof SearchQuery>;

/** Stable JSON serialisation of a SearchQuery over `TOTAL_CACHE_KEY_FIELDS`.
 * Field order is fixed so that two requests with the same params produce
 * the same key regardless of how the URL was constructed. */
export function makeTotalCacheKey(q: SearchQuery): string {
  const normalized: Partial<Record<keyof SearchQuery, string | null>> = {};
  for (const field of TOTAL_CACHE_KEY_FIELDS) {
    if (field === 'owner' || field === 'ownerId' || field === 'owner_id') {
      normalized[field] = canonicalOwner(q);
    } else {
      normalized[field] = q[field] ?? null;
    }
  }
  return JSON.stringify(normalized);
}

/** Test-only: blow the cache so back-to-back tests don't see each other's
 * results. Safe in production too — just slower for 30 s. */
export function _resetCacheForTests(): void {
  totalCache.clear();
}

/**
 * Resolve `total` for this request: serve it from `totalCache` if a fresh
 * entry exists for this exact filter set, otherwise count and cache the
 * result before returning.
 *
 * The hint machinery this used to carry is gone with the engine it argued
 * with. Mongo needed to be told which of two overlapping indexes to use for
 * the count, and told *not* to be told whenever the filter carried `$text`
 * (the two are illegal together). The SQLite count composes the same `FROM`
 * and `WHERE` the page query does, from the same translated query, so there
 * is one plan and nothing to steer — and a facet total and a grid page cannot
 * disagree, which is the failure a ranked branch once shipped.
 *
 * Note the predicate passed here is the *unpaged* one — the seek predicate a
 * cursor contributes must never reach the count, or `total` would shrink as
 * the user scrolls.
 */
export async function getCachedTotal(query: SearchQuery, where: SearchWhere): Promise<number> {
  return cachedTotal(makeTotalCacheKey(query), () => searchCount(where));
}

/**
 * A saved search's `total` (#6176), which would otherwise recount the same rows on every page and
 * reload. Keyed on the count statement itself, so every filter the route forces on top of the
 * stored query (library, hidden people, screenshots) is in the key by construction.
 */
export async function getCachedSavedSearchTotal(where: SearchWhere, db: SqliteDb): Promise<number> {
  const statement = countSql(where);
  return cachedTotal(savedSearchCountKey(statement), () => searchCount(where, db));
}

/** Each bound value carries its type, so a string never shares a key with a number, bigint or blob. */
export function savedSearchCountKey(statement: BoundStatement): string {
  return `count:${JSON.stringify([statement.sql, statement.params.map(keyValue)])}`;
}

function keyValue(value: SqlValue): [string, string | number | boolean | null] {
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('hex')];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  return [typeof value, value];
}

async function cachedTotal(cacheKey: string, count: () => Promise<number>): Promise<number> {
  const nowMs = Date.now();
  const cached = totalCache.get(cacheKey);
  if (cached && cached.expiresMs > nowMs) return cached.total;

  const total = await count();
  totalCache.delete(cacheKey);
  // Bound the cache so a parameterised attack can't grow it unboundedly.
  // 500 unique filter sets is generous for a single server; eviction is
  // FIFO via insertion order.
  if (totalCache.size >= 500) {
    const oldest = totalCache.keys().next().value;
    if (oldest !== undefined) totalCache.delete(oldest);
  }
  totalCache.set(cacheKey, { total, expiresMs: nowMs + TOTAL_CACHE_TTL_MS });
  return total;
}
