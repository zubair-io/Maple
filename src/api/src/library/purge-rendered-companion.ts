import { realpath } from '../fs/mirrored.ts';
import { jailedFile } from '../cloud-backup/inventory.ts';
import { assetOwnsRelPath } from '../db/repos/assets.location-owner.ts';
import { findFolderByPath } from '../db/repos/folders.repo.ts';

/** Preserve the catalogue association until its recorded companion is erased.
 * Never follow a companion path outside its owning library or through a symlink,
 * and never return a path that is an asset's location (#4695): a companion
 * recorded over an unrelated original must not take that original with it.
 * Callers unlink only the primary; preparePurge owns SHA-verified mirror erasure
 * so a newer mirror file that reused this name is never blindly deleted. */
export async function resolvePurgeCompanion(
  root: string,
  relative: string | undefined,
  original: string,
): Promise<string | null> {
  if (!relative) return null;
  const library = await findFolderByPath(root);
  if (library === null || (await assetOwnsRelPath(library._id, relative))) return null;
  const canonicalRoot = await realpath(root);
  try {
    const target = await jailedFile(canonicalRoot, relative);
    return target !== original ? target : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}
