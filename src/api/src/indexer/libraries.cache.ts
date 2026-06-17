/**
 * Process-wide cache of `library_id hex → absolute path` and
 * `slug → { libraryId, root, label }`.
 *
 * Every code path that resolves a `fileinfo[]` entry to an on-disk location
 * needs this map (cache-path resolution, change feed projection, route
 * handlers). Folders rarely change; we cache the read and invalidate
 * explicitly on writes to the folders collection.
 *
 * The cache lives at module scope (process-local) and is rebuilt lazily on
 * the first read after invalidation. There is no TTL — clients that need
 * fresh data after mutating folders must call `invalidateLibraryRoots()`.
 *
 * Extended for M1 unified addressing: the same single DB read also builds a
 * slug → { libraryId, root, label } map so `resolveAddress` can resolve a
 * slug to a library root with zero additional DB round-trips.
 */
import type { ObjectId } from 'mongodb';
import { foldersCollection } from '../db/client.ts';

/** Resolved library info keyed by slug. */
export interface LibraryBySlug {
  libraryId: ObjectId;
  root: string;
  label: string;
}

interface LibraryCache {
  /** library_id hex → absolute root path (pre-existing) */
  byId: ReadonlyMap<string, string>;
  /** slug → { libraryId, root, label } (M1 addition) */
  bySlug: ReadonlyMap<string, LibraryBySlug>;
}

let cached: LibraryCache | null = null;

async function loadCache(): Promise<LibraryCache> {
  if (cached) return cached;
  const coll = await foldersCollection();
  const docs = await coll.find({}, { projection: { path: 1, slug: 1, label: 1 } }).toArray();
  const byId = new Map<string, string>();
  const bySlug = new Map<string, LibraryBySlug>();
  for (const d of docs) {
    byId.set(d._id.toHexString(), d.path);
    if (d.slug) {
      bySlug.set(d.slug, { libraryId: d._id, root: d.path, label: d.label ?? '' });
    }
  }
  cached = { byId, bySlug };
  return cached;
}

export async function loadLibraryRoots(): Promise<ReadonlyMap<string, string>> {
  return (await loadCache()).byId;
}

/**
 * Resolve a slug to its library metadata. Returns null if the slug is unknown.
 * Result is served from the in-memory cache — zero DB round-trips per lookup.
 */
export async function getLibraryBySlug(slug: string): Promise<LibraryBySlug | null> {
  const c = await loadCache();
  return c.bySlug.get(slug) ?? null;
}

export function invalidateLibraryRoots(): void {
  cached = null;
}

/**
 * Test-only: stuff the cache with a fixed map so handler-level tests can
 * exercise the content-addressed cache-path resolution without a Mongo
 * instance. Pass `null` to revert to the lazy-load behaviour.
 */

/**
 * Return a map from `library_id hex` → slug for all libraries that have a slug.
 * Used to compute `slug:relPath` addresses for cover assets in the people list.
 * Served from the same in-memory cache as `loadLibraryRoots` — zero extra DB
 * round-trips.
 */
export async function loadLibraryIdToSlug(): Promise<ReadonlyMap<string, string>> {
  const c = await loadCache();
  // Build the reverse map on-demand. The library count is O(10s) so this is
  // fast and cheap to recompute each call (the cache makes loadCache() free).
  const out = new Map<string, string>();
  for (const [slug, { libraryId }] of c.bySlug) {
    out.set(libraryId.toHexString(), slug);
  }
  return out;
}
export function setLibraryRootsForTests(map: ReadonlyMap<string, string> | null): void {
  if (map === null) {
    cached = null;
  } else {
    cached = { byId: map, bySlug: new Map() };
  }
}

/**
 * Test-only: register a single slug entry so address-resolution tests can
 * exercise `resolveAddress` without a Mongo instance.
 */
export function setLibraryBySlugForTests(slug: string, entry: LibraryBySlug): void {
  if (!cached) {
    cached = { byId: new Map(), bySlug: new Map() };
  }
  // Cast to mutable so we can write into it.
  (cached.bySlug as Map<string, LibraryBySlug>).set(slug, entry);
}
