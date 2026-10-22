import { publishExclusive, PublishCollisionError, revertCreated } from '../fs/relocate-publish.ts';
import { syncCopiedFile } from '../fs/sync-file.ts';
/**
 * Filesystem helpers shared by the backup routes. Kept out of the route files
 * so they stay under the file-size budget (CONTRIBUTING.md § "File-size
 * budget") and so the move/compare/disambiguate logic is unit-testable on its
 * own.
 */
// Mirror-aware drop-in: the assembled-upload publish (atomicMove / moveNoClobber)
// replicates to the library's backup root(s). Same `fs/promises` surface.
import fs from '../fs/mirrored.ts';
import path from 'node:path';

/** Move src to dst atomically. Falls back to copy+unlink on EXDEV (cross-device). */
export async function atomicMove(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      await fs.copyFile(src, dst);
      await syncCopiedFile(dst);
      await fs.unlink(src);
    } else {
      throw e;
    }
  }
}

/**
 * Move `src` onto `dst` only if `dst` does not already exist. Returns true on
 * success, false (leaving `src` in place) when `dst` is already taken — so a
 * caller racing another upload for the same name can pick the next sibling.
 *
 * Unlike `atomicMove`/`rename`, this never clobbers: it `link`s (which fails
 * `EEXIST` if the target exists) then unlinks the source on the same device,
 * and falls back to an owned, flushed and byte-verified exclusive copy on
 * volumes that refuse links. Failed publication rolls back only its own inode.
 * The check-and-create is a single atomic syscall, closing the
 * TOCTOU window a `stat` + `rename` would leave open.
 */
export async function moveNoClobber(src: string, dst: string): Promise<boolean> {
  try {
    const publication = await publishExclusive(src, dst);
    try {
      await fs.unlink(src);
    } catch (error) {
      await revertCreated([publication]);
      throw error;
    }
    return true;
  } catch (error) {
    if (error instanceof PublishCollisionError) return false;
    throw error;
  }
}

export { filesIdentical } from '../fs/file-bytes.ts';

/** Find the first free destination for `relPath` under `libRoot` by inserting
 * a `-1`, `-2`, … suffix before the extension. Used when a genuinely different
 * asset already occupies the computed path (two photos that share a capture
 * date + filename and resolve to the same — or, on a cold geocode cache, no —
 * location). Returns the POSIX-separated rel path plus its absolute path. Caps
 * attempts so a pathological directory can't spin forever. */
export async function firstFreeSiblingPath(
  libRoot: string,
  relPath: string,
  isTaken?: (candidateRel: string) => Promise<boolean>,
): Promise<{ relPath: string; absPath: string }> {
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const stem = path.posix.basename(relPath, ext);
  for (let i = 1; i <= 9999; i++) {
    const candidateName = `${stem}-${i}${ext}`;
    const candidateRel = dir === '.' ? candidateName : `${dir}/${candidateName}`;
    const candidateAbs = path.join(libRoot, ...candidateRel.split('/'));
    try {
      await fs.stat(candidateAbs);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        if (await isTaken?.(candidateRel)) continue;
        return { relPath: candidateRel, absPath: candidateAbs };
      }
      throw e;
    }
  }
  throw new Error(`could not find a free destination for ${relPath} after 9999 attempts`);
}
