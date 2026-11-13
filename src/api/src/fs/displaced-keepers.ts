import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { PublishCollisionError, publishExclusive } from './relocate-publish.ts';
import { legacyEditOwner } from './legacy-backup-sidecar.ts';
import { publishConflictBytes } from './sidecar-ownership.ts';
import { owningCanonicalSidecar } from './xmp-conflict.ts';

const NAME_ATTEMPTS = 100;

/** Publishes the displaced file at `file` under a name the library shows, then
 * removes the private name. `original` is the name it held before the move took
 * it away. A photo becomes `<name> (replaced).<ext>`, which the indexer adopts
 * as a photo of its own; sidecar edits become the `(conflict from move)` copy
 * Maple already lists beside the photo. Nothing is overwritten, and the private
 * name goes only once the visible one is published, so a failure at any step
 * leaves at least one name for the bytes. False when no name could be
 * published. */
export async function surfaceDisplaced(file: string, original: string): Promise<boolean> {
  const published = await publishUnderVisibleName(file, original);
  if (!published) return false;
  await fs.unlink(file);
  return true;
}

async function publishUnderVisibleName(file: string, original: string): Promise<boolean> {
  const dir = path.dirname(file);
  if (path.extname(original).toLowerCase() === '.xmp') {
    // Named after the owning photo, so the copy pairs back: `IMG.001.xmp`,
    // `IMG.001 (conflict from laptop).xmp` and a UUID variant
    // `IMG.001.v<uuid>.xmp` all return as `IMG.001 (conflict from move).xmp`, a
    // pre-#5021 `IMG.CR3.xmp` as `IMG (conflict from move).xmp`, and a video's
    // `clip.mov.xmp` as `clip.mov (conflict from move).xmp`.
    const sidecar = path.join(dir, original);
    const bytes = await fs.readFile(file);
    const owner = (await legacyEditOwner(sidecar, bytes)) ?? owningCanonicalSidecar(sidecar);
    return publishConflictBytes(owner, bytes);
  }
  const { name, ext } = path.parse(original);
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt++) {
    const label = attempt === 1 ? '(replaced)' : `(replaced ${attempt})`;
    try {
      await publishExclusive(file, path.join(dir, `${name} ${label}${ext}`));
      return true;
    } catch (err) {
      if (!(err instanceof PublishCollisionError)) throw err;
    }
  }
  return false;
}
