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

// Mirror-aware drop-in: imported originals replicate to the library's backup root(s).
import fs from '../fs/mirrored.ts';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { filesIdentical, firstFreeSiblingPath, moveNoClobber } from '../backup/fs-util.ts';

/**
 * Copy `src` to `destAbs` without ever clobbering an existing file. Creates
 * parent dirs, copies to a temp sibling, fsyncs, then publishes with an
 * atomic no-clobber step (`link` / `COPYFILE_EXCL` via `moveNoClobber`).
 *
 * Returns `true` when the file was published, `false` when `destAbs` was
 * created by another writer between `resolveDest` and the publish (a
 * cross-process race). The caller re-resolves a free sibling and retries — a
 * plain `rename` would silently overwrite the racer's file, violating the
 * non-destructive invariant. The temp sibling is always cleaned up.
 */
export async function copyFileAtomic(src: string, destAbs: string): Promise<boolean> {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.import.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  await fs.copyFile(src, tmp);
  // Durably flush the copied bytes before the publish so a power loss can't
  // surface a zero-length file.
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
    // Links tmp → destAbs (fails EEXIST) then unlinks tmp, so the source
    // stays untouched and an existing destination is never lost.
    return await moveNoClobber(tmp, destAbs);
  } finally {
    await fs.rm(tmp, { force: true });
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
