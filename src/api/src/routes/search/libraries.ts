/**
 * The two library maps a search result's projection needs: id → root path, for
 * `abs_path`, and id → slug, for the `slug:relPath` address.
 *
 * ## Why this reads `folders` directly
 *
 * This reads `folders` from SQLite directly, uncached, exactly as
 * `repos/assets.read.ts`'s `loadLibraries` does: one pooled round trip over a
 * table with tens of rows in it, issued alongside the queries that actually
 * cost something.
 *
 * ## Why this module still exists at all (#3810)
 *
 * `indexer/libraries.cache.ts` answers the same two questions and caches the
 * answer for the process lifetime, which is the better shape — folders change
 * rarely and the invalidation hooks already exist. It used to be a MongoDB
 * reader, which is the only reason this file was written separately; it is not
 * any more, so the collapse is owed. It is owed rather than done because three
 * behaviours differ and each needs a decision: the `try/catch` below degrades
 * to empty maps where the cache would let a database failure become a 500; the
 * cache can serve a stale root if any folder write forgets to invalidate it,
 * where an uncached read cannot; and the `slug !== ''` filter below has no
 * counterpart there. #3810 carries all three. Do not collapse this by
 * substitution without reading it.
 */

import { listLibraryRoots } from '../../db/repos/folders.repo.ts';

/** Library id (hex) → root path, and library id (hex) → slug. */
export interface LibraryMaps {
  libs: ReadonlyMap<string, string>;
  idToSlug: ReadonlyMap<string, string>;
}

/**
 * Both maps from one read.
 *
 * A failure degrades to empty maps rather than failing the request, which is
 * the contract the projection already has: `abs_path` resolves to `''` and
 * `address` to `null`, and every caller tolerates both. A search that returns
 * its rows with unresolved paths is worth more than a 500.
 *
 * Rows with no slug contribute to `libs` and not to `idToSlug`, so an
 * unregistered library still resolves a path while its assets carry no
 * address — the same split the cache draws.
 */
export async function libraryMaps(): Promise<LibraryMaps> {
  try {
    const roots = await listLibraryRoots();
    return {
      libs: new Map(roots.map((root) => [root.id.toHexString(), root.path] as const)),
      idToSlug: new Map(
        roots
          .filter((root) => root.slug !== '')
          .map((root) => [root.id.toHexString(), root.slug] as const),
      ),
    };
  } catch {
    return { libs: new Map(), idToSlug: new Map() };
  }
}
