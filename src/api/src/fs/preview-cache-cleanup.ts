/**
 * Synchronous previews-cache cleanup for one on-disk location going away.
 *
 * Split out of `xmp.ts` (which owns cache-PATH resolution) because this is
 * cache-path CLEANUP, called from `missing-reaper.ts`/`dedupe.ts` whenever a
 * `fileinfo` entry is removed — previews are path-keyed (see
 * `cachePathForAsset`'s doc in `xmp.ts`), so they don't survive a location
 * going away the way `maple_id`-keyed thumbs do, and can't wait for
 * `cache-gc`'s periodic backstop sweep alone.
 */
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
// Mirror-aware drop-in: durable writes/moves replicate to the library's
// configured backup root(s). Same `fs/promises` surface — see `mirrored.ts`.
import * as fs from './mirrored.ts';

/**
 * Unlink every previews-cache artefact for ONE on-disk location — every
 * size/kind variant (the unedited AVIF tier, a developed/edited JPEG tier,
 * the histogram JSON sidecar) shares the `<filename>.` prefix inside that
 * location's own `.maple/previews/` folder, per `cachePathForAsset`'s
 * previews branch.
 *
 * Call this wherever a `fileinfo` entry is removed (missing-reaper's
 * prune/hard-delete, dedupe's move-then-pull) rather than leaving the orphan
 * for cache-gc's periodic backstop sweep to find later. Best-effort: a
 * filesystem hiccup here must never block or fail the DB reconciliation
 * that's actually load-bearing; a file left behind by a failed unlink is
 * still reclaimed by cache-gc.
 */
export async function cleanPreviewsCacheForLocation(
  libraryRoot: string,
  location: { path: string; filename: string },
): Promise<void> {
  const segments = location.path === '' ? [] : location.path.split('/');
  const previewsDir = path.join(libraryRoot, ...segments, '.maple', 'previews');
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(previewsDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return; // no previews dir at this location
  }
  const prefix = `${location.filename}.`;
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => fs.unlink(path.join(previewsDir, entry.name)).catch(() => {})),
  );
}
