/**
 * Preview stage — generates the 1280-px AVIF used by the describe stage
 * (and any future VLM stages that need more pixels than the 512-px thumb),
 * and by the on-demand `/api/preview/:slug/*` route.
 *
 * Delegates to `generatePreview` in `src/api/src/indexer/previewer.ts`.
 *
 * Cache-path resolution: path-keyed off `fileinfo[0]`, not `maple_id` — see
 * `cachePathForAsset`'s doc in `fs/xmp.ts` for why previews dropped
 * content-addressing (thumbs keep it). Writes to
 * `<lib>/<fileinfo[0].path>/.maple/previews/<fileinfo[0].filename>.avif`.
 *
 * dependsOn: ["thumb"]
 *   — chained on thumb so the FFI worker pool is already warm when this
 *     fires, and so a RAW with no embedded preview produces both artefacts
 *     (or neither) without an interleaving race.
 *
 * Not `pausedOnFirstBoot` — this is purely local file IO, free, and downstream
 * stages need it.
 */
import { generatePreview, PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isNoPreviewFilename } from '../../indexer/media-types.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { defineStage, runStage, type RunStageHandle, type StageResult } from '../run-stage.ts';

const previewStage = defineStage({
  name: 'preview',
  // v4 — KISS single-file migration (#2017): the cache filename dropped its
  // size token, collapsing `<filename>.1280.avif` to `<filename>.avif` (one
  // unversioned file per asset). Bump so every existing row re-renders at the
  // new name — the old `<filename>.1280.avif` (and any `<filename>.dev_*.jpg`
  // developed previews from the retired display-preview stage) become orphans,
  // reclaimed by the missing-reaper/dedupe cache-removal hook or cache-gc's
  // backstop sweep. (v3 was the earlier path-keyed + AVIF migration off the
  // `<maple_id>_1280.jpg` scheme.)
  targetVersion: 4,
  dependsOn: ['thumb'],
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
    // Video containers, metadata-only stub images (eip/braw/afphoto/ai), and
    // audio have no still frame to render — `generatePreview` skips
    // generation entirely for these (no decode path exists), so this guard
    // just avoids the wasted round-trip. The describe stage carries the same
    // guard as defense in depth.
    const primary = assetPrimaryFileInfo(image as never);
    if (primary && isNoPreviewFilename(primary.filename)) {
      return { skip: 'stub-file' };
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
    const previewPath = cachePathForAsset(image as never, libs, 'previews', PREVIEW_CACHE_SUFFIX);
    const absPath = assetAbsPath(image as never, libs);
    if (!previewPath || !absPath) {
      return { skip: 'no-resolvable-location' };
    }
    // An ENOENT here (original gone) is tagged `missing_since` by the runner
    // — this stage sets `tagsMissingOnEnoent` — for the missing-reaper.
    await generatePreview(absPath, previewPath);
    // The preview now lives on disk at the path-keyed location. We do NOT
    // persist that path on the asset: readers recompute it from (library
    // root, fileinfo[0].path, fileinfo[0].filename) via `cachePathForAsset`,
    // so a stored `preview_path` would be dead, redundant data. `{ wrote: true }`
    // marks the stage done without patching any asset field.
    return { wrote: true };
  },
});

export default previewStage;

export async function startPreviewStage(): Promise<RunStageHandle> {
  return runStage(previewStage);
}
