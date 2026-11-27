import { syncCopiedFile } from '../fs/sync-file.ts';
/**
 * Filesystem copy primitives for the Imports worker (ticket #742).
 *
 * Pure FS — no database — so the atomic-copy + collision-resolution logic is
 * unit-testable on a temp dir. The content-dedup lookup against the `assets`
 * table lives in `imports/repo.ts` (the worker wires the two together).
 *
 * Copy, never move: the source is always left untouched (non-destructive
 * invariant). Writes go to a temp sibling then `rename()` into place so a
 * crash never leaves a half-written destination visible.
 */

// Mirror-aware drop-in: imported originals replicate to the library's backup root(s).
import fs, { replicatePath } from '../fs/mirrored.ts';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { filesIdentical, firstFreeSiblingPath, moveNoClobber } from '../backup/fs-util.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('import-copy');

/**
 * This copy's own link: the temp and the name are one file (device and inode),
 * and the temp still has its second name. Never same bytes: a file another
 * writer put at the name is not ours however closely it matches. A filesystem
 * that reports inode 0 or a link count of 1 cannot prove it, and a name that
 * cannot be read is "no".
 */
async function isOwnLink(tmp: string, destAbs: string): Promise<boolean> {
  const [temp, named] = await Promise.all(
    [tmp, destAbs].map((file) => fs.lstat(file, { bigint: true }).catch(() => null)),
  );
  return (
    temp !== null &&
    named !== null &&
    temp.ino !== 0n &&
    temp.nlink >= 2n &&
    temp.dev === named.dev &&
    temp.ino === named.ino
  );
}

async function publishedOrOwnLink(tmp: string, destAbs: string): Promise<boolean> {
  if (await moveNoClobber(tmp, destAbs)) return true;
  if (!(await isOwnLink(tmp, destAbs))) return false;
  replicatePath(destAbs);
  return true;
}

/**
 * Copy `src` to `destAbs` without ever clobbering an existing file. Creates
 * parent dirs, copies to a temp sibling, fsyncs, then publishes with an
 * atomic no-clobber step (`link` / `COPYFILE_EXCL` via `moveNoClobber`).
 *
 * Returns `true` when the file was published, `false` when `destAbs` was
 * created by another writer between `resolveDest` and the publish (a
 * cross-process race). The caller re-resolves a free sibling and retries — a
 * plain `rename` would silently overwrite the racer's file, violating the
 * non-destructive invariant. A link that took effect and was reported as "name
 * taken" (a share retrying a link whose reply was lost) leaves the temp and the
 * name as one file under two names, which is this copy's own and counts as
 * published (`isOwnLink`). The temp
 * sibling is removed on every path, a partial one left by a failed copy
 * included; a removal that fails is logged and does not change the result.
 */
export async function copyFileAtomic(src: string, destAbs: string): Promise<boolean> {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.import.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    await fs.copyFile(src, tmp);
    await syncCopiedFile(tmp);
    // Links tmp → destAbs (fails EEXIST) then unlinks tmp, so the source
    // stays untouched and an existing destination is never lost.
    return await publishedOrOwnLink(tmp, destAbs);
  } finally {
    // A publish that landed has already moved the temp away. If removing what
    // is left of it throws, that must not report the file as failed: the
    // import would drop its marker and a retry would skip the image as a
    // duplicate, sidecars and all. The leftover is logged so it can be found.
    await fs.rm(tmp, { force: true }).catch((err: unknown) => {
      log.warn(
        { tmp, err: err instanceof Error ? err.message : String(err) },
        'could not remove an import temp file',
      );
    });
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
