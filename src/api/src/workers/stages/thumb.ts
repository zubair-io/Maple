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
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageResult,
} from '../run-stage.ts';

const thumbStage = defineStage({
  name: 'thumb',
  // v2 — raw-ffi FFI fix #328: orientation is now baked into the embedded-
  // preview JPEG before re-encode. Bump so existing rows re-render and the
  // on-disk thumbs in `.maple/thumbs/` get rewritten upright.
  targetVersion: 2,
  dependsOn: ['exif'],
  // Reads the original file — an ENOENT means it vanished from disk, so the
  // runner tags `missing_since` for the missing-reaper.
  tagsMissingOnEnoent: true,
  // A non-ENOENT failure that survives all retries means the bytes are
  // unreadable — tag `damaged` so the pipeline parks the file (see exif stage).
  tagsDamagedOnDeadLetter: true,
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: false,
    last_seen_target_version: 0,
  },
  handler: async (image): Promise<StageResult> => {
    // Video containers have no still frame to thumbnail. Without this guard the
    // fall-through in `generateThumb` (`copyImageAsThumb`) copies the source
    // bytes verbatim to `<maple_id>.jpg`, so `/api/thumb/...` would then serve
    // 200 image/jpeg with raw .MOV/.MP4 bytes — a broken <img> in the grid.
    // Skip terminally; the preview/describe/face stages carry the same guard.
    const primary = assetPrimaryFileInfo(image as unknown as ImageDoc);
    if (primary && isVideoFilename(primary.filename)) {
      return { skip: 'video-file' };
    }

    // Let `loadLibraryRoots()` errors propagate — a transient DB hiccup
    // would otherwise yield an empty libs map, which would make
    // `assetAbsPath` return null and trip the no-resolvable-location skip
    // below. That skip writes `version = targetVersion` (see run-stage.ts),
    // permanently marking the stage done. By throwing, the runner's
    // retry/backoff path handles the transient case. Reserve `skip` for
    // the genuine non-reapable cases: libraries loaded fine, but the asset
    // has no fileinfo entries at all (never-located skeleton) or a live
    // entry whose library is unregistered. The third null case — all
    // fileinfo entries soft-deleted (every on-disk location gone) — is the
    // genuinely-orphaned one: the runner stamps `missing_since` on that skip
    // instead of marking the stage done, so the missing-reaper sees it. See
    // run-stage.ts (`hasOnlySoftDeletedFileInfo`).
    const libs = await loadLibraryRoots();
    const thumbPath = resolveThumbPathForAsset(image as never, libs);
    const absPath = assetAbsPath(image as never, libs);
    if (!thumbPath || !absPath) {
      return { skip: 'no-resolvable-location' };
    }
    // An ENOENT here (original gone) is tagged `missing_since` by the runner
    // — this stage sets `tagsMissingOnEnoent` — for the missing-reaper.
    await generateThumb(absPath, thumbPath);
    // The thumb now lives on disk at the content-addressed path. We do NOT
    // persist that path on the asset: readers recompute it from (library root,
    // fileinfo[0].path, maple_id) via `resolveThumbPathForAsset`, so a stored
    // `thumb_path` would be dead, redundant data. `{ wrote: true }` marks the
    // stage done without patching any asset field.
    return { wrote: true };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
