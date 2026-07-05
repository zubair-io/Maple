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
 */
import { readFile } from 'node:fs/promises';
import { generateThumb } from '../../indexer/thumbnailer.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { loadLibraryIdToSlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  isCloudflareConfigComplete,
  loadCloudflareConfig,
  resolveCloudflareConfig,
} from '../../cloudflare/cloudflare-config.repo.ts';
import { uploadThumbToR2 } from '../../cloudflare/r2-client.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';
import { getDb } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import {
  defineStage,
  runStage,
  type ImageDoc,
  type RunStageHandle,
  type StageResult,
} from '../run-stage.ts';

const log = childLogger('workers/stages/thumb');

/** Upper bound on how long the stage will wait for the Cloudflare upload
 * before giving up and moving on. A bounded await (not blind fire-and-
 * forget) so an in-flight upload isn't silently lost if the process exits
 * mid-request — but short enough that an R2 outage can't meaningfully slow
 * the indexer, whose thumb-stage concurrency is already only 2. Passed as
 * an `AbortSignal` into the fetch itself (not just raced against it) so a
 * stalled request is actually cancelled — sockets/TLS state don't leak
 * into the background once the stage moves on. */
const CF_UPLOAD_TIMEOUT_MS = 5_000;

/**
 * Best-effort mirror of a freshly-written thumbnail to Cloudflare R2. Never
 * throws — a failure here must not fail the thumb stage itself; an
 * asset whose upload didn't land simply stays selected by the
 * `cf_thumb_pending` index until the backfill job (sub-issue 4) catches it.
 */
async function maybeUploadThumbToCloudflare(image: ImageDoc, thumbPath: string): Promise<void> {
  if (!image.maple_id) return;
  const dbConfig = await loadCloudflareConfig();
  const config = resolveCloudflareConfig(dbConfig);
  if (!isCloudflareConfigComplete(config)) return;

  const primary = assetPrimaryFileInfo(image);
  if (!primary) return;
  const idToSlug = await loadLibraryIdToSlug();
  const slug = idToSlug.get(primary.library_id.toHexString());
  if (!slug) return;

  const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
  try {
    const bytes = await readFile(thumbPath);
    await uploadThumbToR2(config, key, bytes, AbortSignal.timeout(CF_UPLOAD_TIMEOUT_MS));
    const db = await getDb();
    await db
      .collection('assets')
      .updateOne({ _id: image._id }, { $set: { cf_thumb_synced_at: new Date().toISOString() } });
  } catch (err) {
    log.warn(
      { assetId: image._id.toHexString(), key, err: err instanceof Error ? err.message : err },
      'cloudflare thumb upload failed — will retry via backfill job',
    );
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
    await maybeUploadThumbToCloudflare(image, thumbPath);
    return { wrote: true };
  },
});

export default thumbStage;

export async function startThumbStage(): Promise<RunStageHandle> {
  return runStage(thumbStage);
}
