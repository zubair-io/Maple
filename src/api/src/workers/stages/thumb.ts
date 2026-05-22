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
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { defineStage, runStage, type RunStageHandle, type StageResult } from '../run-stage.ts';

const thumbStage = defineStage({
  name: 'thumb',
  // v2 — raw-ffi FFI fix #328: orientation is now baked into the embedded-
  // preview JPEG before re-encode. Bump so existing rows re-render and the
  // on-disk thumbs in `.maple/thumbs/` get rewritten upright.
  targetVersion: 2,
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
  handler: async (image): Promise<StageResult> => {
    // Let `loadLibraryRoots()` errors propagate — a transient DB hiccup
    // would otherwise yield an empty libs map, which would make
    // `assetAbsPath` return null and trip the no-resolvable-location skip
    // below. That skip writes `version = targetVersion` (see run-stage.ts),
    // permanently marking the stage done. By throwing, the runner's
    // retry/backoff path handles the transient case. Reserve `skip` for
    // the genuine case: libraries loaded fine, but the asset has no
    // fileinfo[0] or its library is unregistered.
    const libs = await loadLibraryRoots();
    const thumbPath = resolveThumbPathForAsset(image as never, libs);
    const absPath = assetAbsPath(image as never, libs);
    if (!thumbPath || !absPath) {
      return { skip: 'no-resolvable-location' };
    }
    await generateThumb(absPath, thumbPath);
    return { patch: { thumb_path: thumbPath } };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
