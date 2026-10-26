/**
 * Which file a Trash restore moves, and where it may put it (#5405).
 *
 * Trashing moves exactly one location into `<library>/.maple/trash/` and
 * repoints that row there, so the copy to restore is found by that address,
 * the same way a purge finds the copy it may erase (`trashed-copy.ts`). The
 * photo's first live location can be an untouched copy elsewhere, and a
 * restore must never move it.
 */

import * as path from 'node:path';
import { refusesMoveUnderMarker } from '../fs/mapleignore-guard.ts';
import { lstat } from '../fs/mirrored.ts';
import { resolveRealPathThroughAncestors } from '../fs/root.ts';
import type { FileInfo } from '../db/schema.ts';
import type { LocationSource } from '../db/repos/assets.trash.ts';
import { loadLibraryRootsForAsset } from '../indexer/libraries.cache.ts';
import {
  LibraryUnreachableError,
  OutsideTrashError,
  checkTrashPurgeTarget,
  isTrashRelPath,
  realLibraryRoot,
  resolveTrashedCopy,
  type TrashedCopy,
} from './trashed-copy.ts';

export type RestoreRefusal =
  | { kind: 'not-in-trash' }
  | { kind: 'unreachable' }
  | { kind: 'ignored' }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

export interface RestoreSource extends TrashedCopy {
  /** Throws `OutsideTrashError` unless the source still resolves to the same
   * file inside Trash. Run right before each source file is removed. */
  recheck: () => Promise<void>;
}

const hasTrashedLocation = (fileinfo: readonly FileInfo[] | undefined): boolean =>
  (fileinfo ?? []).some((entry) => !entry.deleted_at && isTrashRelPath(entry.path));

async function isPlainFile(target: string): Promise<boolean> {
  return lstat(target).then(
    (st) => st.isFile(),
    () => false,
  );
}

async function jailedSource(copy: TrashedCopy): Promise<RestoreSource | RestoreRefusal> {
  const canonical = await checkTrashPurgeTarget(copy.absPath, copy.libraryRoot);
  if (canonical === null || !(await isPlainFile(canonical))) return { kind: 'not-in-trash' };
  const recheck = async () => {
    if ((await checkTrashPurgeTarget(copy.absPath, copy.libraryRoot)) !== canonical) {
      throw new OutsideTrashError(copy.absPath, copy.libraryRoot);
    }
  };
  return { ...copy, recheck };
}

/**
 * The trashed copy to move back, held to the Trash jail: a plain file inside
 * the real `<library>/.maple/trash/`. Its path stays as the library records
 * it, so lifecycle paths stay relative to the root; `recheck` catches a
 * directory swapped for a link after this check. With `named`, that location
 * must itself be the trashed copy, or the restore is refused.
 */
export async function resolveRestoreSource(
  fileinfo: readonly FileInfo[] | undefined,
  named?: LocationSource,
): Promise<RestoreSource | RestoreRefusal> {
  const copy = resolveTrashedCopy(fileinfo, await loadLibraryRootsForAsset({ fileinfo }), named);
  if (copy === null) {
    return !named && hasTrashedLocation(fileinfo)
      ? { kind: 'error', error: "The trashed copy's library is not registered" }
      : { kind: 'not-in-trash' };
  }
  try {
    return await jailedSource(copy);
  } catch (error) {
    if (error instanceof LibraryUnreachableError) return { kind: 'unreachable' };
    if (error instanceof OutsideTrashError) return { kind: 'not-in-trash' };
    throw error;
  }
}

function escapesRoot(relDir: string): boolean {
  return relDir === '..' || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir);
}

/** The folder's path under `root` as POSIX segments, or a refusal when it
 * leaves the library or enters Maple's own `.maple/` tree. */
function libraryRelDir(root: string, dir: string): string[] | RestoreRefusal {
  const relDir = path.relative(root, dir);
  if (escapesRoot(relDir)) {
    return { kind: 'invalid', error: 'Restore target is outside the library' };
  }
  const segments = relDir === '' ? [] : relDir.split(path.sep);
  return segments[0] === '.maple'
    ? { kind: 'invalid', error: "Restore target is inside Maple's own folder" }
    : segments;
}

/** Why the restore may not publish into `targetAbs`'s folder, or null when it
 * may. The folder is checked as written and with symlinks followed. */
export async function restoreDestinationRefusal(
  libraryRoot: string,
  targetAbs: string,
): Promise<RestoreRefusal | null> {
  const dir = path.dirname(targetAbs);
  const written = libraryRelDir(libraryRoot, dir);
  if (!Array.isArray(written)) return written;
  const [realRoot, realDir] = await Promise.all([
    realLibraryRoot(libraryRoot),
    resolveRealPathThroughAncestors(dir),
  ]).catch(() => [null, null] as const);
  if (realRoot === null || realDir === null) return { kind: 'unreachable' };
  const real = libraryRelDir(realRoot, realDir);
  if (!Array.isArray(real)) return real;
  return (await refusesMoveUnderMarker(libraryRoot, written.join('/')))
    ? { kind: 'ignored' }
    : null;
}
