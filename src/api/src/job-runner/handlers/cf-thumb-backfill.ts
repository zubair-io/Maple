/**
 * `cf_thumb_backfill` job handler (#1757 sub-issue 4).
 *
 * Payload: `{}` — no input. The job always operates on every asset
 * currently selected by `PENDING_FILTER` below (indexed, not yet mirrored to
 * R2, and not hidden — see the live-upload hook's comment in
 * `workers/stages/thumb.ts` for why hidden assets are excluded from R2
 * entirely). The `hidden` clause is part of the Mongo query itself
 * (`find`/`countDocuments` both take the full `PENDING_FILTER`), but it
 * isn't covered by the `cf_thumb_pending` index
 * (`{ cf_thumb_synced_at: 1, maple_id: 1 }`), so MongoDB applies it as a
 * FETCH-stage filter over the already-narrow index scan rather than a
 * collection scan — acceptable since hidden assets are a small minority.
 * The route layer (`routes/cloudflare.ts`) refuses to create the job unless
 * `isCloudflareConfigComplete()` at creation time, but config could still be
 * disabled mid-run by the operator — this handler re-checks periodically so
 * a disable takes effect promptly rather than continuing to hammer R2 with
 * a config that's no longer meant to be live.
 *
 * Iterates via a SINGLE Mongo cursor over the pending filter, not a
 * repeatedly-re-run `find().limit()` query: a skipped or failed asset never
 * gets `cf_thumb_synced_at` set, so it would still match the pending filter
 * on a fresh query — re-querying the same filter in an outer loop would
 * therefore re-select and retry it forever within one run instead of moving
 * on. A single cursor visits each currently-matching document once.
 *
 * Per asset: derive the same path-based R2 key the indexer's live-upload
 * hook uses (`cloudflare/thumb-key.ts`), read the already-generated
 * thumbnail off disk, upload with a few retries (this IS the retry/backoff
 * caller per `r2-client.ts`'s module contract — the indexer's live hook is
 * deliberately best-effort, this job is the durable catch-up path), then
 * `$set cf_thumb_synced_at`. An asset whose thumbnail hasn't been generated
 * yet (ENOENT) or has no resolvable library/location is skipped, not
 * failed — it naturally reappears in a future backfill run once the thumb
 * stage catches up, with no separate retry bookkeeping needed.
 */

import { readFile } from 'node:fs/promises';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { loadLibraryIdToSlug, loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';
import {
  isCloudflareConfigComplete,
  loadCloudflareConfig,
  resolveCloudflareConfig,
  type CloudflareConfig,
} from '../../cloudflare/cloudflare-config.repo.ts';
import { uploadThumbToR2, type ResolvedCloudflareConfig } from '../../cloudflare/r2-client.ts';
import { thumbR2Key } from '../../cloudflare/thumb-key.ts';
import { child as childLogger } from '../../log.ts';
import type { JobHandler, JobHandlerContext, JobHandlerResult } from './index.ts';

const log = childLogger('job:cf-thumb-backfill');

const BATCH_SIZE = 100;
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_MS = 500;
// Caps the per-failure detail array recorded on the job document. Without a
// cap, a systemic failure (wrong bucket, revoked credentials that slip past
// the mid-run completeness re-check, a sustained R2 outage) would push one
// `{ assetId, error }` entry per failed asset — across a large library that
// can approach MongoDB's 16MB document limit and make the runner's own
// completion write fail. `failedCount` still counts every failure; only the
// detail list is bounded.
const MAX_RECORDED_FAILURES = 100;

const PENDING_FILTER = {
  cf_thumb_synced_at: null,
  maple_id: { $gt: '' },
  hidden: { $ne: true },
} as const;

interface CfThumbBackfillResult {
  successCount: number;
  skippedCount: number;
  failedCount: number;
  failures: Array<{ assetId: string; error: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry(
  config: ResolvedCloudflareConfig,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      await uploadThumbToR2(config, key, bytes);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        await sleep(UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export const cfThumbBackfillHandler: JobHandler = {
  async run(_payload: Record<string, unknown>, ctx: JobHandlerContext): Promise<JobHandlerResult> {
    const coll = await assetsCollection();
    const total = await coll.countDocuments(PENDING_FILTER);

    const result: CfThumbBackfillResult = {
      successCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failures: [],
    };

    await ctx.reportProgress(0, total);
    if (total === 0) {
      return { kind: 'done', result: result as unknown as Record<string, unknown> };
    }

    const idToSlug = await loadLibraryIdToSlug();
    const libs = await loadLibraryRoots();

    // Successful uploads are batched into a single `updateMany` every
    // BATCH_SIZE (and flushed once more at the end) instead of one
    // `updateOne` per asset — an N+1 write pattern jules flagged, unnecessary
    // since these documents don't need individually-precise timestamps.
    let pendingSynced: ObjectId[] = [];
    async function flushSynced(): Promise<void> {
      if (pendingSynced.length === 0) return;
      await coll.updateMany(
        { _id: { $in: pendingSynced } },
        { $set: { cf_thumb_synced_at: new Date().toISOString() } },
      );
      pendingSynced = [];
    }

    let processed = 0;
    let cancelled = false;
    let sinceConfigCheck = 0;

    let dbConfig: CloudflareConfig | null = await loadCloudflareConfig();
    let config = resolveCloudflareConfig(dbConfig);
    if (!isCloudflareConfigComplete(config)) {
      log.warn('cf_thumb_backfill: config not complete/enabled at start — nothing to do');
      return { kind: 'done', result: result as unknown as Record<string, unknown> };
    }

    const cursor = coll.find(PENDING_FILTER).batchSize(BATCH_SIZE);
    for await (const asset of cursor) {
      if (await ctx.shouldCancel()) {
        cancelled = true;
        break;
      }

      // Config is re-resolved every BATCH_SIZE documents (not per-document)
      // so an operator disabling uploads mid-run halts new work promptly
      // without adding a DB round-trip to every single asset.
      if (sinceConfigCheck >= BATCH_SIZE) {
        await flushSynced();
        dbConfig = await loadCloudflareConfig();
        config = resolveCloudflareConfig(dbConfig);
        if (!isCloudflareConfigComplete(config)) {
          log.warn('cf_thumb_backfill: config no longer complete/enabled — stopping early');
          break;
        }
        sinceConfigCheck = 0;
      }
      sinceConfigCheck += 1;

      const assetId = asset._id.toHexString();
      try {
        const primary = assetPrimaryFileInfo(asset);
        const slug = primary ? idToSlug.get(primary.library_id.toHexString()) : undefined;
        const thumbPath = resolveThumbPathForAsset(asset, libs);
        if (!primary || !slug || !thumbPath) {
          result.skippedCount += 1;
        } else {
          const key = thumbR2Key({ slug, relDir: primary.path, filename: primary.filename });
          const bytes = await readFile(thumbPath);
          await uploadWithRetry(config, key, bytes);
          pendingSynced.push(asset._id);
          result.successCount += 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          // Thumbnail not generated yet — pending, not failed; the thumb
          // stage or a later backfill run will pick it up.
          result.skippedCount += 1;
        } else {
          result.failedCount += 1;
          // Cap recorded detail so a systemic failure (bad bucket, revoked
          // credentials, sustained outage) across a large library can't grow
          // this array past MongoDB's 16MB document limit — failedCount
          // still reflects every failure even once the detail list is full.
          if (result.failures.length < MAX_RECORDED_FAILURES) {
            result.failures.push({ assetId, error: message });
          }
          log.warn({ assetId, err: message }, 'cf_thumb_backfill: upload failed');
        }
      }

      processed += 1;
      await ctx.reportProgress(processed, total);
    }

    await flushSynced();

    return cancelled
      ? { kind: 'cancelled', result: result as unknown as Record<string, unknown> }
      : { kind: 'done', result: result as unknown as Record<string, unknown> };
  },
};
