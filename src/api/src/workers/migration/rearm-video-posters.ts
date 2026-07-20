/**
 * Migration: "Re-arm video posters".
 *
 * Before #1649 every video was terminally skipped by the thumb, preview,
 * describe, and face stages — `isNoPreviewFilename` matched the container and
 * each handler returned `{ skip: 'stub-file' }`. A `skip` writes
 * `version = targetVersion`, so all of those stages consider every existing
 * video permanently handled. Teaching the pipeline to extract poster frames
 * therefore changes nothing on its own: the new code is never reached for a
 * single video already in the library.
 *
 * This migration resets those stage versions for video assets so the normal
 * stage machinery re-claims them and renders posters.
 *
 * Why not just bump `targetVersion` on the thumb stage — the built-in
 * mechanism for "re-run everything"? Because it re-queues the ENTIRE library,
 * not just video. The renders themselves would be cheap (`generateThumb`
 * short-circuits on a fresh cache after two `stat`s), but `stages/thumb.ts`
 * calls `resetCfThumbSyncVersion` on every successful pass — including the
 * cached no-op — so a global bump would re-upload every thumbnail in the
 * library to R2. That is a large, billable egress + storage-write event to fix
 * a few thousand videos. Scoping the reset to video assets avoids it entirely.
 *
 * Doubles as the operator action for "I just installed ffmpeg." A host with no
 * runnable ffmpeg makes the thumb/preview stages skip video with
 * `no-video-decoder`, which is also a terminal `skip` — so after installing
 * ffmpeg the operator flips this migration on again to pick those up. Toggle
 * lives in Settings → Workers like every other migration.
 *
 * Done-marker is `video_poster_rearm_version`, mirroring `video_meta_version`
 * in `backfill-video-exif.ts`. Without a marker the candidate set would refill
 * the moment the thumb stage re-stamped the asset, and the migration would
 * loop forever. Bump `VIDEO_POSTER_REARM_VERSION` to sweep again.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import { liveVideoFileinfoMatch } from './video-selectors.ts';

import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-posters');

const MIGRATION_ID = 'rearm-video-posters';

/** Bump to re-sweep every video again (e.g. after the poster extractor learns
 * to handle a container it previously failed on). */
export const VIDEO_POSTER_REARM_VERSION = 1;

/**
 * Stages whose stored result for a video is a pre-#1649 "nothing to do here."
 *
 * `thumb`/`preview` were skipped on the container extension and are what
 * actually render the poster. `describe`/`face-detect`/`face-embed` were
 * skipped by the same predicate and, being downstream of artefacts that never
 * existed, would otherwise stay marked done even once a poster appears.
 * `cf-thumb-sync` is included so the freshly rendered poster is mirrored to R2
 * — the thumb stage's own cascade covers that too, but resetting it here keeps
 * the migration correct on its own terms rather than relying on that side
 * effect.
 *
 * NOT `exif`: video EXIF is a separate concern owned by `backfill-video-exif`,
 * and re-running it here would undo that migration's work.
 */
const REARMED_STAGES = [
  'thumb',
  'preview',
  'cf-thumb-sync',
  'describe',
  'face-detect',
  'face-embed',
] as const;

/** Assets with a live video location that haven't been re-armed at the current
 * version yet. Deliberately NOT filtered on backup origin (unlike
 * `backfill-video-exif`) — any indexed video wants a poster, however it
 * arrived. */
function candidateFilter(): Filter<AssetDoc> {
  return {
    fileinfo: { $elemMatch: liveVideoFileinfoMatch() },
    video_poster_rearm_version: { $ne: VIDEO_POSTER_REARM_VERSION },
  } as Filter<AssetDoc>;
}

/**
 * The `$set` that re-queues one asset: every re-armed stage back to
 * unprocessed, plus the done-marker.
 *
 * The full five-field reset (`version`/`attempts`/`last_error`/`processed_at`/
 * `dead`) matches `reArmCacheStages()` in `workers/dedupe.helpers.ts` rather
 * than resetting `version` alone. Clearing the rest matters: an asset that
 * previously dead-lettered would stay `dead: true` and never be claimed, and a
 * stale `last_error` would keep showing in Settings → Workers for a stage
 * that's about to be retried clean.
 */
function rearmUpdate(): Record<string, unknown> {
  const set: Record<string, unknown> = {
    video_poster_rearm_version: VIDEO_POSTER_REARM_VERSION,
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

export const rearmVideoPosters: Migration = {
  id: MIGRATION_ID,
  title: 'Re-arm video posters',
  description:
    'Re-queues existing videos through the thumb, preview, describe, and face stages so they ' +
    'get poster-frame thumbnails. Videos were skipped outright before poster extraction ' +
    'existed, so they stay marked done until this runs. Requires ffmpeg on the server — ' +
    'run this again after installing it. One-time; idempotent per video.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();

    // Pure Mongo — no file I/O, no decode. This migration only moves stage
    // bookkeeping; the actual poster rendering is done by the stage workers on
    // their own schedule, under their own concurrency limits, once these rows
    // become claimable again. So a whole batch is one `updateMany` rather than
    // the per-document loop the file-moving migrations need.
    const ids = await coll
      .find(candidateFilter(), { projection: { _id: 1 } })
      .limit(batchSize)
      .toArray();

    if (ids.length === 0) return { processed: 0, errors: 0 };

    try {
      const res = await coll.updateMany(
        { _id: { $in: ids.map((d) => d._id) } },
        { $set: rearmUpdate() },
      );
      log.info(
        { matched: res.matchedCount, modified: res.modifiedCount },
        're-armed video posters',
      );
      return { processed: res.modifiedCount, errors: 0 };
    } catch (err) {
      // Left unstamped, so the next tick retries this same batch.
      log.error(
        { count: ids.length, err: err instanceof Error ? err.message : err },
        're-arm batch failed — left for retry',
      );
      return { processed: 0, errors: ids.length };
    }
  },
};
