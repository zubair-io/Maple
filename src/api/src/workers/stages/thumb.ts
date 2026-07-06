/**
 * Thumb stage — generates the 512px JPEG thumbnail for an image.
 *
 * Delegates to `generateThumb` in `src/api/src/indexer/thumbnailer.ts`, which
 * routes all decode through isolated child processes (ffi-pool for RAW,
 * imgdecode-pool for bitmap formats). Orientation is baked at decode time:
 * FFI path bakes it during preview extraction; imgdecode child calls
 * sharp's .rotate() inline.
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
 *
 * Mirroring the written thumbnail to Cloudflare R2 is NOT done here — it's
 * the independent `cf-thumb-sync` stage (`stages/cf-thumb-sync.ts`), which
 * depends on this one. Every rewrite here resets that stage's own version
 * back to 0 (see `resetCfThumbSyncVersion` below) so a re-render — most
 * notably a `targetVersion` bump like the v2 orientation fix — re-triggers
 * a fresh R2 upload instead of leaving a stale copy cached at the edge.
 */
import { assetsCollection } from '../../db/client.ts';
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

/** Reset `cf-thumb-sync`'s stage state to unprocessed — the full reset
 * shape (`version`/`attempts`/`last_error`/`processed_at`/`dead`), matching
 * `reArmCacheStages()` in `workers/dedupe.helpers.ts`. Clearing
 * `last_error`/`processed_at` alongside `version`/`dead`/`attempts` matters:
 * a stage that previously dead-lettered or errored on this asset would
 * otherwise keep showing that stale error in the Settings → Workers UI even
 * though the reset means it's about to be retried clean. Best-effort — a
 * failure here just means that stage catches up on its own next poll once
 * whatever transient issue clears, same as the thumb stage's own retry
 * path; it must never fail the thumb write itself. Mirrors the
 * cross-stage-reset precedent in `sidecar-metadata-index.ts` (GPS change
 * → reset `stages.geocode`). */
async function resetCfThumbSyncVersion(imageId: ImageDoc['_id']): Promise<void> {
  try {
    const assets = await assetsCollection();
    await assets.updateOne(
      { _id: imageId },
      {
        $set: {
          'stages.cf-thumb-sync.version': 0,
          'stages.cf-thumb-sync.attempts': 0,
          'stages.cf-thumb-sync.last_error': null,
          'stages.cf-thumb-sync.processed_at': null,
          'stages.cf-thumb-sync.dead': false,
        },
      },
    );
  } catch {
    // Best-effort — see doc comment above.
  }
}

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
    await resetCfThumbSyncVersion(image._id);
    return { wrote: true };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
