/**
 * Migration: "Re-drive describe rows skipped on a missing preview".
 *
 * Before #2177 a describe run that found the 1280-px preview absent returned
 * `{ skip: 'preview-missing' }` — and a `skip` writes
 * `version = targetVersion`, marking the row permanently done. Every asset
 * that hit that branch (cache drift, a moved file, a preview write that never
 * landed) is therefore stamped done with no caption and nothing queued to
 * regenerate its preview. The new `{ rearm }` result fixes the behaviour going
 * forward, but changes nothing for rows already stamped.
 *
 * This migration resets the describe stage (full five-field reset) on exactly
 * those rows so the normal machinery re-claims them under the new code, which
 * then decides per asset: re-arm the preview stage (drift — the preview
 * regenerates and describe follows), or re-skip terminally (the preview stage
 * itself recorded a terminal `skip:`, e.g. `no-video-decoder` on a no-ffmpeg
 * host, where re-arming could never produce a poster).
 *
 * Only `stages.describe` is touched — the preview stage is deliberately NOT
 * reset here. Whether preview needs a re-run is the describe handler's call
 * (it can see whether the artefact is genuinely absent and why); resetting it
 * from the migration would re-render previews that are present and fine.
 *
 * Done-marker is `preview_missing_redrive_version`, mirroring
 * `video_poster_rearm_version` in `rearm-video-posters.ts`. Without it, a row
 * that legitimately re-skips under the new code (terminal video case writes
 * the same `skip: preview-missing` string) would re-enter the candidate set
 * the moment describe re-stamped it, and the migration would loop forever.
 * Bump `PREVIEW_MISSING_REDRIVE_VERSION` to sweep again.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';

import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:preview-missing-redrive');

const MIGRATION_ID = 'redrive-preview-missing-describe';

/** The exact `last_error` the runner's skip branch records for this case —
 * `skip: ${result.skip}` with describe's `preview-missing` reason. */
const SKIP_MARKER = 'skip: preview-missing';

/** Bump to re-sweep every previously-skipped row again. */
export const PREVIEW_MISSING_REDRIVE_VERSION = 1;

/** Rows stamped done by the pre-#2177 terminal skip that this sweep hasn't
 * re-driven yet. */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'stages.describe.last_error': SKIP_MARKER,
    preview_missing_redrive_version: { $ne: PREVIEW_MISSING_REDRIVE_VERSION },
  } as Filter<AssetDoc>;
}

/** The `$set` that re-queues one asset: the describe stage back to
 * unprocessed (full five-field reset — see `rearm-video-posters.ts` for why
 * `version` alone is not enough), plus the done-marker. */
function redriveUpdate(): Record<string, unknown> {
  return {
    preview_missing_redrive_version: PREVIEW_MISSING_REDRIVE_VERSION,
    'stages.describe.version': 0,
    'stages.describe.attempts': 0,
    'stages.describe.last_error': null,
    'stages.describe.processed_at': null,
    'stages.describe.dead': false,
  };
}

export const redrivePreviewMissingDescribe: Migration = {
  id: MIGRATION_ID,
  title: 'Re-drive describe rows skipped on a missing preview',
  description:
    'Re-queues assets whose describe stage was marked done with "skip: preview-missing" before ' +
    'the pipeline learned to re-arm the preview stage (#2177). Each re-driven row either ' +
    'regenerates its preview and gets captioned, or re-skips terminally where no preview can ' +
    'exist (e.g. video on a host without ffmpeg). One-time; idempotent per asset.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();

    // Pure Mongo — no file I/O. This only moves stage bookkeeping; the actual
    // preview/describe work is done by the stage workers on their own
    // schedule, under their own concurrency limits, once these rows become
    // claimable again. So a whole batch is one `updateMany`.
    const ids = await coll
      .find(candidateFilter(), { projection: { _id: 1 } })
      .limit(batchSize)
      .toArray();

    if (ids.length === 0) return { processed: 0, errors: 0 };

    try {
      const res = await coll.updateMany(
        { _id: { $in: ids.map((d) => d._id) } },
        { $set: redriveUpdate() },
      );
      log.info(
        { matched: res.matchedCount, modified: res.modifiedCount },
        're-drove preview-missing describe rows',
      );
      return { processed: res.modifiedCount, errors: 0 };
    } catch (err) {
      // Left unstamped, so the next tick retries this same batch.
      log.error(
        { count: ids.length, err: err instanceof Error ? err.message : err },
        're-drive batch failed — left for retry',
      );
      return { processed: 0, errors: ids.length };
    }
  },
};
