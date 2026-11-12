import { errnoCode } from './errno-code';
import * as fs from './mirrored.ts';
import * as noReplace from './rename-no-replace.ts';
import {
  copyExclusive,
  LINK_UNSUPPORTED,
  PublishCollisionError,
  type RelocatePublication,
} from './relocate-publish.ts';

/** Publish the complete file at `tmp` under `destination` without ever
 * replacing another writer's file, on any volume, in the strongest way the
 * volume allows (#5143):
 *  1. a hard link;
 *  2. where links aren't supported, a no-replace rename: all-or-nothing, and
 *     readers never see a partial file;
 *  3. where that isn't supported either (SMB through macOS smbfs), the name is
 *     created exclusively, which the server settles atomically, and the bytes
 *     are written into it. A reader can see the empty name for the length of
 *     one write, but no writer's file is ever replaced.
 * `tmp` is left for the caller to remove; step 2 consumes it. */
export async function publishWholeExclusive(
  tmp: string,
  destination: string,
): Promise<RelocatePublication> {
  const identity = await fs.lstat(tmp);
  try {
    await fs.link(tmp, destination);
    return { path: destination, dev: identity.dev, ino: identity.ino };
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') throw new PublishCollisionError(destination);
    if (!LINK_UNSUPPORTED.has(errnoCode(err) ?? '')) throw err;
  }
  return (await noReplace.renameNoReplace(tmp, destination)) === 'renamed'
    ? { path: destination, dev: identity.dev, ino: identity.ino }
    : copyExclusive(tmp, destination);
}
