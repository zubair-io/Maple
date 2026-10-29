/**
 * Publishing a finished panorama into the library.
 *
 * The stitched PNG sits in the job's temp directory, often on another
 * filesystem, and a retry treats any file at the panorama's name as already
 * made. So the bytes are copied beside the name under a private staging name
 * (`<name>.tmp.<pid>-<hex>`, which neither the indexer nor the mirror picks
 * up), flushed, verified, and only then given the name: by hard link, or on a
 * volume that cannot link, by rename once the name is confirmed free. The name
 * never holds partial bytes and an existing file is never replaced.
 */

import { errnoCode } from '../fs/errno-code';
import { filesIdentical } from '../fs/file-bytes.ts';
import { constants, copyFile, link, lstat, rename, unlink } from '../fs/mirrored.ts';
import {
  LINK_UNSUPPORTED,
  PublishCollisionError,
  privateSiblingOf,
} from '../fs/relocate-publish.ts';
import { syncCopiedFile } from '../fs/sync-file.ts';

async function nameIsTaken(destination: string): Promise<boolean> {
  return lstat(destination).then(
    () => true,
    (err: unknown) => {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    },
  );
}

/** Give the complete file at `staged` the name `destination`, never replacing
 * an occupant. A no-link volume has no exclusive rename, so the name is checked
 * first; only the one admitted stitch job writes panorama names. */
async function claimName(staged: string, destination: string): Promise<void> {
  try {
    await link(staged, destination);
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw new PublishCollisionError(destination);
    if (!LINK_UNSUPPORTED.has(errnoCode(err) ?? '')) throw err;
    if (await nameIsTaken(destination)) throw new PublishCollisionError(destination);
    await rename(staged, destination);
  }
}

/** Copy `source` to `destination` so the name appears only once every byte is
 * on disk. The staging file is removed whatever happens. */
export async function publishWhole(source: string, destination: string): Promise<void> {
  const staged = privateSiblingOf(destination);
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await syncCopiedFile(staged);
    if (!(await filesIdentical(source, staged))) {
      throw new Error(`pano: copy verification failed: ${source} -> ${destination}`);
    }
    await claimName(staged, destination);
  } finally {
    await unlink(staged).catch(() => {});
  }
}
