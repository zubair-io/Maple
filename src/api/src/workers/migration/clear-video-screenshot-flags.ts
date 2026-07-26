/**
 * Migration: "Clear video screenshot flags."
 *
 * `is_screenshot` is a stills-only concept (#2325), but videos could acquire
 * it three ways before the fix: the filename heuristic seeded it in the EXIF
 * stage, the VLM returned it for a poster frame that looked like a UI (a
 * screen recording does every time), and the sidecar re-index read that
 * verdict back. A flagged video drops out of the Photos bucket of the
 * Photos/Screenshots filter, and the prompt-v5 screenshot short-circuit also
 * nulled its whole scene description.
 *
 * The code fix only stops NEW flags. A stage does not re-run once its
 * version is stamped, so every video already carrying the flag keeps it
 * until this migration resets them.
 *
 * Why not bump the describe stage's targetVersion — the built-in "re-run
 * everything" mechanism? Because that re-queues the ENTIRE library through a
 * VLM inference per asset. Scoping to flagged video keeps the cost
 * proportional to the damage.
 *
 * Pure Mongo: no file I/O, no decode, and so — unlike `rearm-video-posters`
 * — no ffmpeg precondition. The describe re-run itself happens later, on the
 * stage worker's own schedule and under its own concurrency limits.
 *
 * Known limitation: re-running describe on a genuine screen recording will
 * probably null the scene fields again, because the short-circuit lives in
 * the prompt and the model still sees a UI. The FLAG stays correct either
 * way, and the re-run does recover videos that were only ever misclassified
 * by the filename heuristic. Ticket #2158 (multi-frame video-describe) is
 * the better home for the description-quality half.
 *
 * Done-marker is `video_screenshot_clear_version`, mirroring
 * `video_poster_rearm_version` in `rearm-video-posters.ts`. Bump
 * `VIDEO_SCREENSHOT_CLEAR_VERSION` to sweep again.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import { liveVideoFileinfoMatch } from './video-selectors.ts';

import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-screenshot');

const MIGRATION_ID = 'clear-video-screenshot-flags';

/** Bump to re-sweep every flagged video again. */
export const VIDEO_SCREENSHOT_CLEAR_VERSION = 1;

/**
 * Stages re-armed once the flag is cleared.
 *
 * `describe` because the v5 screenshot short-circuit nulled `scene_type`,
 * `setting`, `activity`, `time_of_day`, `lighting`, `weather`,
 * `composition`, and `shot_type` on every flagged row — a re-run is the only
 * way those come back. `meili` because the search index and its facet counts
 * hold the stale `true`, and the Photos/Screenshots filter reads them.
 *
 * NOT `thumb` / `preview` / `cf-thumb-sync`: the derivatives are correct and
 * unaffected, and resetting `cf-thumb-sync` would re-upload every one of
 * these thumbnails to R2 for no benefit.
 */
const REARMED_STAGES = ['describe', 'meili'] as const;

/** Videos with a live on-disk location still carrying the flag, either on
 * the top-level mirror or in the stored vision subdoc, that haven't been
 * cleared at the current version yet. */
function candidateFilter(): Filter<AssetDoc> {
  return {
    fileinfo: { $elemMatch: liveVideoFileinfoMatch() },
    video_screenshot_clear_version: { $ne: VIDEO_SCREENSHOT_CLEAR_VERSION },
    $or: [{ is_screenshot: true }, { 'vision.is_screenshot': true }],
  } as Filter<AssetDoc>;
}

/**
 * The `$set` that clears one asset: the top-level flag, the done-marker, and
 * every re-armed stage back to unprocessed.
 *
 * The full five-field stage reset (`version`/`attempts`/`last_error`/
 * `processed_at`/`dead`) matches `reArmCacheStages()` in
 * `workers/dedupe.helpers.ts` rather than resetting `version` alone. An asset
 * that previously dead-lettered would otherwise stay `dead: true` and never
 * be claimed, and a stale `last_error` would keep showing in
 * Settings → Workers for a stage that is about to be retried clean.
 *
 * `vision.is_screenshot` is deliberately NOT in here — see `runBatch`.
 */
function clearUpdate(): Record<string, unknown> {
  const set: Record<string, unknown> = {
    is_screenshot: false,
    video_screenshot_clear_version: VIDEO_SCREENSHOT_CLEAR_VERSION,
  };
  for (const name of REARMED_STAGES) {
    set[`stages.${name}.version`] = 0;
    set[`stages.${name}.attempts`] = 0;
    set[`stages.${name}.last_error`] = null;
    set[`stages.${name}.processed_at`] = null;
    set[`stages.${name}.dead`] = false;
  }
  return set;
}

export const clearVideoScreenshotFlags: Migration = {
  id: MIGRATION_ID,
  title: 'Clear video screenshot flags',
  description:
    'Clears is_screenshot on videos that were wrongly classified as screenshots, and re-queues ' +
    'them through describe and meili so their scene description and search entry are rebuilt. ' +
    'Videos could pick up the flag from the filename heuristic or from the vision model reading ' +
    'a poster frame as a UI, which dropped them out of the Photos filter. One-time; idempotent ' +
    'per video.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();

    // Pure Mongo — this migration only moves flags and stage bookkeeping, so
    // a whole batch is two `updateMany` calls rather than the per-document
    // loop the file-moving migrations need.
    const ids = await coll
      .find(candidateFilter(), { projection: { _id: 1 } })
      .limit(batchSize)
      .toArray();

    if (ids.length === 0) return { processed: 0, errors: 0 };

    const _id = { $in: ids.map((d) => d._id) };

    try {
      // Two writes, each SELF-CONTAINED: every row is fully handled — flag
      // cleared and done-marker stamped — by exactly one of them. That is
      // what makes a failure between the two safe: the rows the failed write
      // would have covered still match `candidateFilter()`, so the next tick
      // retries them.
      //
      // The obvious shape — clear the vision mirror, then stamp everything —
      // has an atomicity gap. A row flagged ONLY in `vision.is_screenshot`
      // would have that mirror cleared by the first write and then, if the
      // second failed, match neither arm of the `$or` on the retry: stranded
      // with the right flag but its describe/meili stages never re-armed, and
      // silently so.
      //
      // Order matters and vision-first is required. A row carrying BOTH flags
      // must have its mirror cleared in the same write that stamps it —
      // stamping first would make the marker's `$ne` exclude it before the
      // mirror write landed, stranding it the same way.
      const visionRes = await coll.updateMany(
        { _id, 'vision.is_screenshot': true } as Filter<AssetDoc>,
        { $set: { ...clearUpdate(), 'vision.is_screenshot': false } },
      );

      // Rows flagged only on the top-level mirror. `vision.is_screenshot` is
      // absent from this `$set` on purpose: folding it in would make Mongo
      // fabricate `vision: { is_screenshot: false }` on every
      // heuristic-flagged row that never ran describe — a malformed VisionDoc
      // with no caption, and one that would then satisfy the "vision exists"
      // branch in `sidecar-metadata-index`, permanently shadowing the
      // filename heuristic for that asset.
      const mirrorRes = await coll.updateMany({ _id, is_screenshot: true } as Filter<AssetDoc>, {
        $set: clearUpdate(),
      });

      const modified = visionRes.modifiedCount + mirrorRes.modifiedCount;
      log.info(
        { vision: visionRes.modifiedCount, mirror: mirrorRes.modifiedCount },
        'cleared video screenshot flags',
      );
      return { processed: modified, errors: 0 };
    } catch (err) {
      // Left unstamped, so the next tick retries this same batch.
      log.error(
        { count: ids.length, err: err instanceof Error ? err.message : err },
        'clear batch failed — left for retry',
      );
      return { processed: 0, errors: ids.length };
    }
  },
};
