/**
 * Thumb stage — generates the 512px JPEG thumbnail for an image.
 *
 * Delegates to `generateThumb` in `src/api/src/indexer/thumbnailer.ts`, which
 * routes all decode through isolated child processes (ffi-pool for RAW,
 * imgdecode-pool for bitmap formats). Orientation is baked at decode time:
 * FFI path bakes it during preview extraction; imgdecode child calls
 * maple's .rotate() inline.
 *
 * Cache-path resolution: the ONE path-keyed location every reader computes —
 * `<lib>/<fileinfo[0].path>/.maple/thumbs/<sha256_prefix16(filename)>.avif`,
 * via `resolveThumbPathForAsset`, which is just `resolveThumbPath` applied to
 * the asset's primary absolute path. Writing anywhere else is what made
 * `/api/fs/thumb` re-decode every source from scratch: it computes the
 * path-keyed name, so a `maple_id`-keyed file in the same directory was
 * invisible to it. See `resolveThumbPathForAsset` for why path-keying is the
 * right call for a UI over a local filesystem.
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
 * back to 0 so a re-render — most notably a `targetVersion` bump like the v2
 * orientation fix — re-triggers a fresh R2 upload instead of leaving a stale
 * copy cached at the edge.
 *
 * That reset is the runner's `invalidates` mechanism, and moving to it is the
 * one behaviour change in the SQLite port. On Mongo it was a best-effort
 * `updateOne` this stage issued itself after `generateThumb` returned, outside
 * the runner's writeback: a failure between the thumbnail landing on disk and
 * the reset landing in the database left `cf-thumb-sync` marked done against
 * bytes it had never uploaded, and nothing would notice. Declared as
 * `invalidates` instead, the reset is one statement in the same transaction as
 * this stage's own success row, so either both land or neither does.
 */
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
import { ffmpegBinary } from '../../thumbs/video-poster.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageResult,
} from '../run-stage.ts';

/**
 * The stage whose output this one invalidates on every rewrite.
 *
 * Named rather than inlined because the runner validates it against a stage
 * name pattern and a typo would be a silently-never-re-armed edge cache.
 */
const CF_THUMB_SYNC_STAGE = 'cf-thumb-sync';

const thumbStage = defineStage({
  name: 'thumb',
  // v2 — raw-ffi FFI fix #328: orientation is now baked into the embedded-
  // preview JPEG before re-encode. Bump so existing rows re-render and the
  // on-disk thumbs in `.maple/thumbs/` get rewritten upright.
  // v3 — thumbnail format changed JPEG → AVIF (`.jpg` → `.avif` on disk).
  // Bump forces every asset to re-render under the new path; the existing
  // `resetCfThumbSyncVersion` cascade below re-triggers a fresh R2 upload
  // with the new bytes + `image/avif` Content-Type. Old `.jpg` files become
  // orphans — `cache-gc.ts`/`dedupe.ts`/`restructure-fs.ts` recognize both
  // extensions so they still get reaped.
  // v4 — cache key changed from `maple_id` back to the path-keyed
  // `sha256_prefix16(filename)` that every reader (notably `/api/fs/thumb`)
  // actually computes. Bump so every asset re-renders at the name readers look
  // for; until it lands, the browse/timeline grids re-decode each source on
  // first request despite a valid thumb already sitting in the same directory.
  // The old `<maple_id>.avif` files are deliberately NOT renamed — they orphan
  // out via cache-gc, same as the v3 `.jpg` files did. `resetCfThumbSyncVersion`
  // cascades as before so R2 picks up the re-render.
  targetVersion: 4,
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
    // Metadata-only stub images (eip/braw/afphoto/ai) and audio
    // (mp3/wav/m4a/aac) have no still frame to thumbnail. Without this guard
    // the fall-through in `generateThumb` (`copyImageAsThumb`) copies the
    // source bytes verbatim to `<maple_id>.avif`, so `/api/thumb/...` would
    // then serve 200 image/avif with raw non-image bytes — a broken <img> in
    // the grid. Skip terminally; the preview/describe/face stages carry the
    // same guard.
    const primary = assetPrimaryFileInfo(image as unknown as ImageDoc);
    if (primary && isUndecodableFilename(primary.filename)) {
      return { skip: 'stub-file' };
    }

    // Video posters need a runnable host ffmpeg (#1649). When there isn't one,
    // skip BEFORE `generateThumb` rather than letting its video branch fail:
    // a failed render still returns `{ wrote: true }` below, which would mark
    // the stage done having published nothing, and would also cascade a
    // pointless `cf-thumb-sync` reset for a thumb that doesn't exist.
    //
    // This skip does write `version = targetVersion` — i.e. "handled" — so an
    // operator who installs ffmpeg later needs the `rearm-video-posters`
    // migration (Settings → Workers) to bring these back into the queue. That
    // is the same one-button path existing videos take, since they were all
    // marked done by the pre-#1649 blanket skip anyway. No process restart is
    // needed for the install to register: `ffmpegBinary` caches only positive
    // results, so absence is re-probed, and the migration holds off entirely
    // until a decoder exists so it can't burn its marker on a pass that would
    // just re-skip everything.
    if (primary && isVideoFilename(primary.filename) && !(await ffmpegBinary())) {
      return { skip: 'no-video-decoder' };
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
    // We do NOT persist the path on the asset: every reader derives it from the
    // source path alone via `resolveThumbPath`, so a stored `thumb_path` would
    // be dead, redundant data — and a DB field is exactly the dependency
    // path-keying exists to avoid. So the patch is empty and the whole point of
    // the result is the invalidation beside it, which re-arms the edge upload
    // against the bytes just written.
    return { patch: [], invalidates: [CF_THUMB_SYNC_STAGE] };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
