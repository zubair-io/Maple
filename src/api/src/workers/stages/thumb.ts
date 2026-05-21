/**
 * Thumb stage — generates the 512px JPEG thumbnail for an image.
 *
 * Delegates to `generateThumb` in `src/api/src/indexer/thumbnailer.ts`, which
 * is orientation-aware after Plan 0 (applyExifOrientationInPlace is wired into
 * the RAW path).
 *
 * Cache-path resolution (post content-addressing migration PR 3):
 *   - if the image doc has both `maple_id` and `fileinfo[0]`, write to the
 *     content-addressed location: `<lib>/<fileinfo[0].path>/.maple/thumbs/
 *     <maple_id>.jpg`;
 *   - otherwise fall back to the legacy basename-keyed location via
 *     `resolveThumbPath(absPath)`. Legacy rows survive until the upcoming GC
 *     sweep retires their orphans.
 *
 * dependsOn: ["exif"]
 *   — thumb needs EXIF orientation to produce an upright image. The legacy
 *     `hash` predecessor was retired in the drop-abs-path-2026-05-21
 *     migration; discover writes sha1_head + maple_id inline at insert so
 *     the new cache-key dependency is satisfied before this stage runs.
 */
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { resolveThumbPath, resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';

const thumbStage = defineStage({
  name: 'thumb',
  targetVersion: 1,
  dependsOn: ['exif'],
  defaults: {
    concurrency: 2,
    batchSize: 5,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image) => {
    // loadLibraryRoots() reads the folders collection. A transient DB hiccup
    // (or a test environment without Mongo) must not break thumb generation —
    // fall back to the legacy basename-keyed path with an empty libraries map
    // and let the next boot's cache-gc retire any orphan it produced.
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }
    const thumbPath = resolveThumbPathForAsset(image as never, libs);
    if (!thumbPath) {
      // Fall back to legacy basename-keyed path so legacy rows (without
      // maple_id or fileinfo) still get a thumb. The cache-gc sweep retires
      // their orphans once the row is backfilled.
      const legacyAbs = image.abs_path as string;
      await generateThumb(legacyAbs);
      return { patch: { thumb_path: resolveThumbPath(legacyAbs) } };
    }
    const absPath = assetAbsPath(image as never, libs) ?? (image.abs_path as string);
    await generateThumb(absPath, thumbPath);
    return { patch: { thumb_path: thumbPath } };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
