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
