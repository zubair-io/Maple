/**
 * Filesystem copy primitives for the Imports worker (ticket #742).
 *
 * Pure FS — no Mongo — so the atomic-copy + collision-resolution logic is
 * unit-testable on a temp dir. The content-dedup lookup against the `assets`
 * collection lives in `imports/repo.ts` (the worker wires the two together).
 *
 * Copy, never move: the source is always left untouched (non-destructive
 * invariant). Writes go to a temp sibling then `rename()` into place so a
 * crash never leaves a half-written destination visible.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { filesIdentical, firstFreeSiblingPath } from '../backup/fs-util.ts';

let _tmpCounter = 0;

/**
 * Copy `src` to `destAbs` atomically. Creates parent dirs, copies to a temp
 * sibling, fsyncs, then renames into place. Never clobbers via a partial
 * write — the rename is the only moment `destAbs` appears.
 */
export async function copyFileAtomic(
  src: string,
  destAbs: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.import.tmp.${process.pid}.${_tmpCounter++}`;
  await fs.copyFile(src, tmp);
  // Durably flush the copied bytes before the rename so a power loss between
  // rename and writeback can't surface a zero-length file.
  try {
    const fh = await fs.open(tmp, 'r+');
    try {
      await fh.datasync();
    } finally {
      await fh.close();
    }
  } catch {
    // datasync is best-effort hardening; a filesystem that rejects it
    // (some network mounts) must not fail the copy.
  }
  try {
    await fs.rename(tmp, destAbs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export interface ResolvedDest {
  /** The destination to copy to (POSIX rel path under the library root). */
  destRel: string;
  /** True when an on-disk file already holds byte-identical content — the
   * caller should skip the copy and mark the entry `skipped_duplicate`. */
  alreadyPresent: boolean;
}

/**
 * Resolve where `destRel` actually lands under `libraryRoot`, handling an
 * on-disk name collision:
 *
 *   - nothing there            → copy to `destRel`.
 *   - identical content there  → skip (`alreadyPresent: true`).
 *   - different content there  → pick the first free `-1`/`-2`/… sibling so a
 *     distinct file never clobbers an existing one.
 */
export async function resolveDest(
  libraryRoot: string,
  destRel: string,
  src: string,
): Promise<ResolvedDest> {
  const destAbs = path.join(libraryRoot, ...destRel.split('/'));
  try {
    await fs.stat(destAbs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { destRel, alreadyPresent: false };
    }
    throw e;
  }
  if (await filesIdentical(src, destAbs)) {
    return { destRel, alreadyPresent: true };
  }
  const free = await firstFreeSiblingPath(libraryRoot, destRel);
  return { destRel: free.relPath, alreadyPresent: false };
}

/** Join a library-root-relative POSIX path to an absolute host path. */
export function destAbsPath(libraryRoot: string, destRel: string): string {
  return path.join(libraryRoot, ...destRel.split('/'));
}
