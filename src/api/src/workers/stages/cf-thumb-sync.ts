/**
 * `cf-thumb-sync` stage — mirrors each indexed asset's on-disk thumbnail to
 * the Cloudflare R2 edge cache (#1757). Replaces the old
 * `cf_thumb_backfill` JobRunner job and the inline upload hook that used to
 * live in `thumb.ts`'s handler directly: per CLAUDE.md's worker-design
 * convention, ongoing per-asset background work belongs in the pipeline as
 * a stage, not a one-off job behind a manual settings-page button — a
 * pipeline stage gets pause/resume, concurrency, retry/backoff, dead-letter,
 * and progress reporting for free from `run-stage.ts`, all visible on
 * Settings → Workers exactly like every other stage.
 *
 * `pausedOnFirstBoot: true` (mirrors `geocode.ts`): Cloudflare credentials
 * are operator-entered on Settings → Cloudflare, not known at first boot.
 * The operator must save valid, tested credentials and enable uploads there
 * before unpausing this stage on Settings → Workers. Unpausing immediately
 * processes the entire backlog of already-indexed thumbnails — this stage
 * IS the backfill, not a separate mechanism from the ongoing sync.
 *
 * `dependsOn: [{ name: 'thumb', minVersion: 2 }]` — needs the on-disk
 * thumbnail to exist. `thumb.ts` resets this stage's version back to 0 on
 * every rewrite (including a `targetVersion` bump like the v2 orientation
 * fix), so a re-rendered thumbnail always gets re-uploaded rather than
 * leaving a stale copy cached at the edge.
 *
 * Hidden assets are excluded (`{ skip: 'hidden' }`) — a Cloudflare Worker
 * edge cache has no per-request visibility check beyond bearer-token
 * validity, so anything in R2 is fetchable by any authenticated user for as
 * long as it's there. An asset that's ALREADY synced when it becomes hidden
 * is handled separately by `cloudflare/hidden-cleanup.ts` (active deletion,
 * hooked into every write path that can flip `hidden` to `true`) — this
 * stage only ever adds to R2, never removes.
 *
 * Retry/backoff and dead-lettering are entirely `run-stage.ts`'s generic
 * job — this handler just throws on failure (mirrors `geocode.ts`), rather
 * than hand-rolling its own retry loop the way the old JobRunner job did.
 */

import { readFile } from 'node:fs/promises';
import { assetPrimaryFileInfo, isEnoentError } from '../../indexer/images.repo.ts';
import { loadLibraryIdToSlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import {
  isCloudflareConfigComplete,
  loadCloudflareConfig,
  resolveCloudflareConfig,
} from '../../cloudflare/cloudflare-config.repo.ts';
import { uploadThumbToR2 } from '../../cloudflare/r2-client.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';
import { cleanupR2ThumbForHiddenAsset } from '../../cloudflare/hidden-cleanup.ts';
import { defineStage, runStage, type RunStageHandle, type StageResult } from '../run-stage.ts';

/** Bounds a single upload attempt's wall-clock — `run-stage.ts` retries the
 * whole handler on failure (up to `maxAttempts`), this just keeps one
 * stalled request from hanging the stage's concurrency slot indefinitely.
 * Same value the old inline thumb.ts hook used. */
const CF_UPLOAD_TIMEOUT_MS = 5_000;

const cfThumbSyncStage = defineStage({
  name: 'cf-thumb-sync',
  targetVersion: 1,
  dependsOn: [{ name: 'thumb', minVersion: 2 }],
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    pausedOnFirstBoot: true,
    last_seen_target_version: 0,
  },
  handler: async (image): Promise<StageResult> => {
    if (image.hidden === true) {
      if (image.cf_thumb_synced_at) {
        await cleanupR2ThumbForHiddenAsset(image);
      }
      return { skip: 'hidden' };
    }

    const dbConfig = await loadCloudflareConfig();
    const config = resolveCloudflareConfig(dbConfig);
    if (!isCloudflareConfigComplete(config)) {
      // Only reachable if an operator unpauses this stage before saving
      // complete, enabled Cloudflare credentials — `pausedOnFirstBoot`
      // keeps this off the common path. Throwing (not skipping) means it
      // dead-letters after `maxAttempts` and surfaces as an error on
      // Settings → Workers rather than silently marking every asset
      // "done" without ever having uploaded anything.
      throw new Error('cf-thumb-sync: Cloudflare config is not complete/enabled');
    }

    const primary = assetPrimaryFileInfo(image);
    const libs = await loadLibraryRoots();
    const thumbPath = resolveThumbPathForAsset(image, libs);
    const idToSlug = await loadLibraryIdToSlug();
    const slug = primary ? idToSlug.get(primary.library_id.toHexString()) : undefined;
    if (!primary || !thumbPath || !slug) {
      return { skip: 'no-resolvable-location' };
    }

    let bytes: Uint8Array;
    try {
      bytes = await readFile(thumbPath);
    } catch (err) {
      // Video assets, and anything else `thumb.ts` marked done without ever
      // writing a file (e.g. its own no-resolvable-location skip) — there's
      // nothing to upload. Not an error: skip terminally like `thumb.ts`
      // does for the same cases.
      if (isEnoentError(err)) return { skip: 'no-thumb' };
      throw err;
    }

    const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
    await uploadThumbToR2(config, key, bytes, AbortSignal.timeout(CF_UPLOAD_TIMEOUT_MS));
    return { patch: { cf_thumb_synced_at: new Date().toISOString() } };
  },
});

export default cfThumbSyncStage;

export async function startCfThumbSyncStage(): Promise<RunStageHandle> {
  return runStage(cfThumbSyncStage);
}
