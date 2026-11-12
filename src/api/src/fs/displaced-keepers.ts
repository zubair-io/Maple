import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { PublishCollisionError, publishExclusive } from './relocate-publish.ts';
import { publishConflictBytes } from './sidecar-ownership.ts';

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
    const photo = path.join(dir, path.basename(original, path.extname(original)));
    return publishConflictBytes(photo, await fs.readFile(file));
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
