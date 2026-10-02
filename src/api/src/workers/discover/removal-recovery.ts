/** #1472: reconcile abandoned publications before indexing either half of a RAW edit. */
import { basename, dirname, join } from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import { listLibraryRoots } from '../../db/repos/folders.repo.ts';
import { isWithinRoot } from '../../fs/root.ts';
import {
  removalJournalPath,
  recoverRemovalRelocation,
} from '../../fs/removal-relocation-journal.ts';
import { child } from '../../log.ts';

const log = child('discover/removal-recovery');
const suffix = '.removal-relocation.json';

/** False defers this photo to a later sweep. Active owners and changed or
 * corrupt recovery evidence never become partial catalogue entries. */
export async function recoverRemovalForDiscover(target: string, root: string): Promise<boolean> {
  try {
    const journal = await fs.lstat(removalJournalPath(target)).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    });
    if (!journal) return true;
    const directory = await fs.realpath(dirname(target));
    if (!isWithinRoot(await fs.realpath(root), directory))
      throw new Error('Removal recovery destination is outside the library');
    const roots = await Promise.all(
      (await listLibraryRoots()).map(async (library) =>
        fs.realpath(library.path).catch(() => library.path),
      ),
    );
    await recoverRemovalRelocation(target, roots);
    return true;
  } catch (error) {
    log.warn({ target, error: String(error) }, 'removal relocation deferred; evidence retained');
    return false;
  }
}

/** Journals can name an absent primary, so the ordinary supported-file
 * partition cannot find them. Re-list after recovery: it may restore or remove
 * files. A failed journal blocks only its own primary, including missing tags. */
export async function recoverDirectoryRemovals(
  directory: string,
  root: string,
  entries: readonly { name: string }[],
): Promise<{ blocked: ReadonlySet<string>; relist: boolean }> {
  const names = entries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('.') && name.endsWith(suffix))
    .map((name) => name.slice(1, -suffix.length))
    .filter((name) => name !== '' && name !== '.' && name !== '..' && basename(name) === name);
  const blocked = new Set<string>();
  for (const name of names)
    if (!(await recoverRemovalForDiscover(join(directory, name), root))) blocked.add(name);
  return { blocked, relist: names.length > 0 };
}
