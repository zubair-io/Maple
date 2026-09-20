/**
 * The two library maps a search result's projection needs: id → root path, for
 * `abs_path`, and id → slug, for the `slug:relPath` address.
 *
 * ## What is left here, and why it is not nothing (#3810)
 *
 * `indexer/libraries.cache.ts` answers both questions and caches the answer for
 * the process lifetime, which every other `fileinfo[]` resolver in the server
 * already uses. This module used to read `folders` itself, because that cache
 * was a MongoDB reader and a search response must not have been the thing
 * keeping a Mongo connection alive. It is not one any more, so the duplicate
 * read is gone and what remains is the one thing the cache does not do:
 *
 * **Failing soft.** `loadCache()` lets a database failure throw. The projection
 * contract is the opposite — `abs_path` resolves to `''`, `address` to `null`,
 * and every caller tolerates both, because a search that returns its rows with
 * unresolved paths is worth more than a 500. The `try/catch` below is that
 * contract, and it stays *here* rather than inside the cache on purpose: the
 * cache assigns `cached` only on success, so a transient failure it swallowed
 * would be memoised as an empty map for the life of the process. Failing out to
 * this catch leaves the cache cold and the next request re-reads.
 *
 * The `slug !== ''` filter this module used to apply is gone with the read.
 * `slug` is `NOT NULL UNIQUE` (`db/sqlite/ddl/library.ts`), so it only ever
 * excluded a value `registerFolder` does not produce.
 */

import { loadLibraryIdToSlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';

/** Library id (hex) → root path, and library id (hex) → slug. */
export interface LibraryMaps {
  libs: ReadonlyMap<string, string>;
  idToSlug: ReadonlyMap<string, string>;
}

/**
 * Both maps, from the shared cache, with a database failure degraded to empty
 * maps rather than a 500.
 *
 * Awaited in sequence rather than with `Promise.all`, which looks like a missed
 * parallelisation and is not: both calls go through the same `loadCache()`, and
 * that function memoises the *result*, not the in-flight read. Two concurrent
 * misses issue two reads of `folders`; awaiting the first means the second is
 * served from memory. Concurrent cold callers can still double-read — that is
 * the cache's behaviour and predates this module, over a table with tens of
 * rows in it.
 */
export async function libraryMaps(): Promise<LibraryMaps> {
  try {
    const libs = await loadLibraryRoots();
    const idToSlug = await loadLibraryIdToSlug();
    return { libs, idToSlug };
  } catch {
    return { libs: new Map(), idToSlug: new Map() };
  }
}
