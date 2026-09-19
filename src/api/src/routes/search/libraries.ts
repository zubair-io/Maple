/**
 * The two library maps a search result's projection needs: id → root path, for
 * `abs_path`, and id → slug, for the `slug:relPath` address.
 *
 * ## Why this is not `indexer/libraries.cache.ts`
 *
 * That module answers the same two questions and caches the answer for the
 * process lifetime, which is the right shape — folders change rarely and the
 * invalidation hooks already exist. It is also still a MongoDB reader at the
 * time of writing, and it is not this slice's file: roughly twenty callers
 * across the indexer, the workers and the job runner share it, so moving it
 * belongs to whoever owns `indexer/**` rather than to the search routes
 * (#3787). Until that lands, a search response must not be the thing that keeps
 * a Mongo connection alive — and it must not quietly answer with empty
 * `abs_path`s when there is no Mongo to reach, which is what the existing
 * `.catch(() => new Map())` around those calls would have done.
 *
 * So this reads `folders` from SQLite directly, uncached, exactly as
 * `repos/assets.read.ts`'s `loadLibraries` does and for the same reason: one
 * pooled round trip over a table with tens of rows in it, issued alongside the
 * queries that actually cost something. When the cache moves to SQLite this
 * file should collapse into a call to it.
 */

import { listLibraryRoots } from '../../db/sqlite/repos/folders.repo.ts';

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
