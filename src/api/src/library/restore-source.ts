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
import type { FileInfo } from '../db/schema.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import {
  LibraryUnreachableError,
  OutsideTrashError,
  checkTrashPurgeTarget,
  resolveTrashedCopy,
  type TrashedCopy,
} from './trashed-copy.ts';

export interface NamedLocation {
  libraryId: FileInfo['library_id'];
  path: string;
  filename: string;
}

export type RestoreRefusal =
  | { kind: 'not-in-trash' }
  | { kind: 'unreachable' }
  | { kind: 'ignored' }
  | { kind: 'invalid'; error: string }
  | { kind: 'error'; error: string };

/**
 * The trashed copy to move back, held to the Trash jail: its file must lie
 * inside the real `<library>/.maple/trash/`. With `named`, that location must
 * itself be the trashed copy, or the restore is refused.
 */
export async function resolveRestoreSource(
  fileinfo: readonly FileInfo[] | undefined,
  named?: NamedLocation,
): Promise<TrashedCopy | RestoreRefusal> {
  const copy = resolveTrashedCopy(fileinfo, await loadLibraryRoots(), named);
  if (copy === null) return { kind: 'not-in-trash' };
  try {
    if ((await checkTrashPurgeTarget(copy.absPath, copy.libraryRoot)) === null) {
      return { kind: 'error', error: 'The trashed file is missing from Trash' };
    }
  } catch (error) {
    if (error instanceof LibraryUnreachableError) return { kind: 'unreachable' };
    if (error instanceof OutsideTrashError) return { kind: 'not-in-trash' };
    throw error;
  }
  return copy;
}

function escapesRoot(relDir: string): boolean {
  return relDir === '..' || relDir.startsWith(`..${path.sep}`) || path.isAbsolute(relDir);
}

/** Why the restore may not publish into `targetAbs`'s folder, or null when it may. */
export async function restoreDestinationRefusal(
  libraryRoot: string,
  targetAbs: string,
): Promise<RestoreRefusal | null> {
  const relDir = path.relative(libraryRoot, path.dirname(targetAbs));
  if (escapesRoot(relDir)) {
    return { kind: 'invalid', error: 'Restore target is outside the library' };
  }
  const segments = relDir === '' ? [] : relDir.split(path.sep);
  if (segments[0] === '.maple') {
    return { kind: 'invalid', error: "Restore target is inside Maple's own folder" };
  }
  return (await refusesMoveUnderMarker(libraryRoot, segments.join('/')))
    ? { kind: 'ignored' }
    : null;
}
