/**
 * Process-wide cache of `library_id hex → absolute path` and
 * `slug → { libraryId, root, label }`.
 *
 * Every code path that resolves a `fileinfo[]` entry to an on-disk location
 * needs this map (cache-path resolution, change feed projection, route
 * handlers). Folders rarely change; we cache the read and invalidate
 * explicitly on writes to the `folders` table.
 *
 * The cache lives at module scope (process-local) and is rebuilt lazily on
 * the first read after invalidation. There is no TTL — clients that need
 * fresh data after mutating folders must call `invalidateLibraryRoots()`.
 *
 * That rule currently costs nothing, and it is worth knowing why before
 * changing the table. Everything cached here — `path`, `slug`, `label` — is
 * written once, by `registerFolder`, and `routes/folders.ts` invalidates right
 * after that insert. The only other writers touch `last_scan` and `mirrors`,
 * neither of which is cached, and there is no unregister or rename path at all.
 * So nothing that is cached can change under the cache today.
 *
 * Adding one changes that. A folder delete, or a rename of `path`/`slug`, or
 * the `label` edit the DDL's "free to change" comment anticipates, each owes an
 * `invalidateLibraryRoots()` call — and the blast radius is wider than it looks
 * since #3810, because search result projection reads its library maps through
 * here (`routes/search/libraries.ts`) rather than querying `folders` itself.
 *
 * Extended for M1 unified addressing: the same single DB read also builds a
 * slug → { libraryId, root, label } map so `resolveAddress` can resolve a
 * slug to a library root with zero additional DB round-trips.
 */
import { ObjectId } from '../db/object-id.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { listLibraryRoots, type LibraryRoot } from '../db/repos/folders.repo.ts';
import { isSqliteOpen } from '../db/sqlite/index.ts';

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
let loading: Promise<LibraryCache> | null = null;
let generation = 0;
let cachedAtMs = 0;

export const UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS = 5_000;
const invalidateListeners = new Set<() => void>();
const NO_LIBRARY_ROOTS: ReadonlyMap<string, string> = new Map();

function buildLibraryCache(roots: readonly LibraryRoot[]): LibraryCache {
  const byId = new Map<string, string>();
  const bySlug = new Map<string, LibraryBySlug>();
  for (const root of roots) {
    byId.set(root.id.toHexString(), root.path);
    // Every registered library has a slug: the column is `NOT NULL UNIQUE`, so
    // the two maps always hold the same set. The Mongo documents predated that
    // guarantee and a pre-M1 install could carry a slugless folder, which is
    // why this used to be a conditional.
    bySlug.set(root.slug, { libraryId: root.id, root: root.path, label: root.label });
  }
  return { byId, bySlug };
}

async function loadCache(): Promise<LibraryCache> {
  if (cached) return cached;
  if (loading) return loading;
  const loadGeneration = generation;
  const load = (async () => {
    const loaded = buildLibraryCache(await listLibraryRoots());
    // An invalidation that landed while this read was in flight means the rows
    // may predate the folder change it announced; serve them once, never cache them.
    if (loadGeneration === generation) {
      cached = loaded;
      cachedAtMs = Date.now();
    }
    return loaded;
  })();
  loading = load;
  try {
    return await load;
  } finally {
    if (loading === load) loading = null;
  }
}

export async function loadLibraryRoots(): Promise<ReadonlyMap<string, string>> {
  return (await loadCache()).byId;
}

interface AssetLibraryRefs {
  fileinfo?: readonly { library_id: ObjectId | string; deleted_at?: string | null }[];
}

function liveLibraryIds(asset: AssetLibraryRefs): string[] {
  return (asset.fileinfo ?? [])
    .filter((entry) => !entry.deleted_at)
    .map((entry) =>
      typeof entry.library_id === 'string'
        ? new ObjectId(entry.library_id).toHexString()
        : entry.library_id.toHexString(),
    );
}

/**
 * `loadLibraryRoots()` for a caller resolving one asset's on-disk location.
 * The worker process is never told when the API process registers a library,
 * so a live location pointing at an id the cache has not seen triggers one
 * re-read of the folders table (at most once per interval, so an asset whose
 * library is genuinely gone cannot turn every claim into a query).
 */
export async function loadLibraryRootsForAsset(
  asset: AssetLibraryRefs,
): Promise<ReadonlyMap<string, string>> {
  const known = await loadLibraryRoots();
  const hasUnknown = liveLibraryIds(asset).some((id) => !known.has(id));
  if (!hasUnknown || Date.now() - cachedAtMs < UNKNOWN_LIBRARY_RELOAD_MIN_INTERVAL_MS) {
    return known;
  }
  invalidateLibraryRoots();
  return loadLibraryRoots();
}

export function hasUnregisteredLibrary(
  asset: AssetLibraryRefs,
  libs: ReadonlyMap<string, string>,
): boolean {
  return liveLibraryIds(asset).some((id) => !libs.has(id));
}

/**
 * Library roots for the path jail. Served from the same cache, which
 * `invalidateLibraryRoots` keeps coherent across the API and worker processes;
 * with no database open (unit tests, shutdown) it reports no roots rather than
 * opening one, so the jail fails closed.
 */
export async function loadJailLibraryRoots(): Promise<ReadonlyMap<string, string>> {
  if (cached) return cached.byId;
  return isSqliteOpen() ? loadLibraryRoots() : NO_LIBRARY_ROOTS;
}

export async function loadSharedLibraryRoots(dbOverride?: SqliteDb): Promise<string[]> {
  return dbOverride
    ? (await listLibraryRoots(dbOverride)).map((root) => root.path)
    : [...(await loadLibraryRoots()).values()];
}

/**
 * Resolve a slug to its library metadata. Returns null if the slug is unknown.
 * Result is served from the in-memory cache — zero DB round-trips per lookup.
 */
export async function getLibraryBySlug(slug: string): Promise<LibraryBySlug | null> {
  const c = await loadCache();
  return c.bySlug.get(slug) ?? null;
}

export const LIBRARIES_CACHE_INVALIDATE_MESSAGE = {
  type: 'libraries-cache-invalidate',
} as const;

export function isLibrariesCacheInvalidateMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === LIBRARIES_CACHE_INVALIDATE_MESSAGE.type
  );
}

export function onInvalidateLibraryRoots(listener: () => void): void {
  invalidateListeners.add(listener);
}

/** Worker boot: relay library-roots invalidations to/from the parent API process over IPC. */
export function installWorkerLibraryRootsSync(): void {
  const send = process.send?.bind(process);
  if (!send) return;
  onInvalidateLibraryRoots(() => {
    try {
      send(LIBRARIES_CACHE_INVALIDATE_MESSAGE);
    } catch {
      /* parent channel closed */
    }
  });
  process.on('message', (message: unknown) => {
    if (isLibrariesCacheInvalidateMessage(message)) invalidateLibraryRoots({ localOnly: true });
  });
}

export function invalidateLibraryRoots(options?: { localOnly?: boolean }): void {
  generation += 1;
  cached = null;
  loading = null;
  if (options?.localOnly) return;
  for (const listener of invalidateListeners) {
    try {
      listener();
    } catch {
      /* best effort */
    }
  }
}

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

/**
 * Test-only: stuff the cache with a fixed map so a handler-level test can
 * exercise content-addressed cache-path resolution without seeding a database.
 * Pass `null` to revert to the lazy-load behaviour.
 */
export function setLibraryRootsForTests(map: ReadonlyMap<string, string> | null): void {
  generation += 1;
  loading = null;
  cached = map === null ? null : { byId: map, bySlug: new Map() };
}

/**
 * Test-only: register a single slug entry so an address-resolution test can
 * exercise `resolveAddress` without seeding a database.
 */
export function setLibraryBySlugForTests(slug: string, entry: LibraryBySlug): void {
  if (!cached) {
    cached = { byId: new Map(), bySlug: new Map() };
  }
  // Cast to mutable so we can write into it.
  (cached.bySlug as Map<string, LibraryBySlug>).set(slug, entry);
}
