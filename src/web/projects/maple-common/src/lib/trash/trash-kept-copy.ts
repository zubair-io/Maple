// A permanent delete that kept the photo (#5403/#5419): another copy of it
// exists outside Trash, so the server removed only the trashed copy and the
// photo stays in the library at that other copy. These pure helpers word the
// panel's notice and find which folder the kept photo now shows in.

import { formatAddress, parentAddress } from '../addressing/maple-address';
import type { ApiFolder } from '../workspace/server-library-io';

const CLEANUP_NOTE = ' Its file cleanup will finish shortly.';

export function keptCopyMessage(filename: string, cleanupPending: boolean): string {
  return `Removed the copy of "${filename}" in Trash. The photo was kept because another copy exists.${cleanupPending ? CLEANUP_NOTE : ''}`;
}

/** The Empty Trash summary's clause for the photos that were kept. */
export function keptCopiesNote(filenames: readonly string[], cleanupPending: boolean): string {
  if (filenames.length === 0) return '';
  const pending = cleanupPending ? ' File cleanup will finish shortly.' : '';
  return ` ${filenames.length} kept because another copy exists (${filenames.join(', ')}).${pending}`;
}

/** The `slug:relPath` address of the folder holding `absPath`, resolved
 * against the registered libraries' roots, or null when none holds it. */
export function folderAddressOf(
  absPath: string | null,
  folders: readonly ApiFolder[],
): string | null {
  if (absPath === null) return null;
  const owner = folders
    .filter((folder) => folder.slug && absPath.startsWith(`${folder.path.replace(/\/+$/, '')}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!owner?.slug) return null;
  const relPath = absPath.slice(owner.path.replace(/\/+$/, '').length + 1);
  const parent = parentAddress({ slug: owner.slug, relPath }) ?? { slug: owner.slug, relPath: '' };
  return formatAddress(parent);
}
