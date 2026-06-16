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
 * Processes assets in batches of `batchSize` using `$lt: cursor` pagination
 * so a large collection is never loaded into memory at once.
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

    // Process a batch of assets missing the field. Using updateMany with a
    // pipeline so the recompute is atomic per row and never needs a cursor.
    // We limit via $limit in an aggregation + bulkWrite to avoid loading the
    // whole collection; a pipeline updateMany without a limit would process
    // ALL pending rows in one shot — fine for correctness but potentially a
    // large write on first run.
    const candidates = await assets
      .find(pendingFilter(), { projection: { _id: 1 }, limit: batchSize })
      .toArray();

    if (candidates.length === 0) return { processed: 0, errors: 0 };

    const ids = candidates.map((c) => c._id);

    let processed = 0;
    let errors = 0;
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
      errors = candidates.length;
      throw err;
    }

    return { processed, errors };
  },
};
