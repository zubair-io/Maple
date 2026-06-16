/**
 * Migration: "Backfill live_location_count".
 *
 * Computes `live_location_count` — the number of live (non-tombstoned)
 * `fileinfo` entries per asset — for existing rows that pre-date the
 * denormalization introduced in #1302. A `fileinfo` entry is live when
 * neither `deleted_at` nor `missing_since` is set (same definition as
 * `isLiveFileInfo` in `indexer/images.repo.ts`).
 *
 * After this migration runs, `countDocuments({ live_location_count: { $gte: 2 } })`
 * is index-covered by the `live_location_count_gte2` partial index and
 * replaces the `$expr`+`$filter` FETCH scan the deduplicate `/status`
 * count previously used.
 *
 * Processes assets in batches of `batchSize`. Each batch queries rows that
 * are still missing the field (`pendingFilter`) with a `limit`; because the
 * batch SETS `live_location_count`, processed rows drop out of `pendingFilter`
 * automatically, so the next batch sees fresh rows — no cursor or sort needed.
 */

import { getDb } from '../../db/client.ts';
import { liveLocationCountExpression } from '../../indexer/images.repo.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const MIGRATION_ID = 'backfill-live-location-count';

/** Assets that have no `live_location_count` field yet. */
function pendingFilter(): Record<string, unknown> {
  return { live_location_count: { $exists: false } };
}

export const backfillLiveLocationCount: Migration = {
  id: MIGRATION_ID,
  title: 'Backfill live_location_count',
  description:
    'Computes the denormalized live-location count for existing assets, enabling an index-covered ' +
    'deduplicate status count without the expensive $expr FETCH scan introduced in #1290.',

  async countRemaining(): Promise<number> {
    const db = await getDb();
    return db.collection('assets').countDocuments(pendingFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const db = await getDb();
    const assets = db.collection('assets');

    // Collect a batch of IDs missing the field, then atomically recompute
    // live_location_count for each via a single pipeline updateMany. Using
    // find(pendingFilter, { limit }) + updateMany({_id:{$in:ids}}) rather
    // than an unbounded updateMany, which would process ALL pending rows in
    // one shot — fine for correctness but potentially a large write on first run.
    const candidates = await assets
      .find(pendingFilter(), { projection: { _id: 1 }, limit: batchSize })
      .toArray();

    if (candidates.length === 0) return { processed: 0, errors: 0 };

    const ids = candidates.map((c) => c._id);

    let processed = 0;
    try {
      const result = await assets.updateMany({ _id: { $in: ids } }, [
        {
          $set: {
            live_location_count: liveLocationCountExpression(),
          },
        },
      ]);
      processed = result.modifiedCount;
    } catch (err) {
      throw err;
    }

    return { processed, errors: 0 };
  },
};
