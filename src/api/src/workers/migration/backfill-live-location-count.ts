/**
 * Migration: "Repair live_location_count".
 *
 * `live_location_count` is the number of locations an asset holds whose file is
 * still there — neither replaced in place (`deleted_at`) nor gone from disk
 * (`missing_since`). It is denormalised onto the asset row because "is this
 * asset live" is the base predicate of every browse, search and facet query,
 * and as a column it folds into a partial index's `WHERE` clause where as a
 * sub-select it costs one B-tree probe per candidate row.
 *
 * ## What changed at the SQLite cutover (#3787)
 *
 * This used to be a genuine backfill: the column was introduced in #1302 and
 * assets written before it simply had no such field, so the migration walked
 * `{ live_location_count: { $exists: false } }` and computed one for each.
 *
 * There is no such state any more. The column is `NOT NULL DEFAULT 0` and three
 * triggers derive it from `asset_locations`, so every write that can change a
 * location's liveness updates it in the same statement and nothing can be
 * "missing" it. The old pending filter would match nothing for ever, which is a
 * migration that silently does nothing — worse than one that is honest about
 * what it now checks.
 *
 * So it becomes a drift check: count the assets whose stored number disagrees
 * with their actual live locations, and recompute those. On a healthy library
 * that is zero and the migration idles immediately. It stays on Settings →
 * Workers because the number is load-bearing for every grid and facet query,
 * and an operator who doubts it should be able to verify and repair it without
 * shell access to the database.
 */

import {
  countLiveLocationCountDrift,
  repairLiveLocationCounts,
} from '../../db/repos/assets.migrations.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const MIGRATION_ID = 'backfill-live-location-count';

export const backfillLiveLocationCount: Migration = {
  id: MIGRATION_ID,
  title: 'Repair live_location_count',
  description:
    'Verifies the denormalised live-location count on every asset against its actual on-disk ' +
    'locations, and recomputes any that disagree. The count is maintained automatically, so a ' +
    'healthy library reports nothing to do; this is the operator-visible way to confirm that.',

  countRemaining(): Promise<number> {
    return countLiveLocationCountDrift();
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    // Bounded rather than a single unbounded recompute: correctness would be
    // the same either way, but a first run over a large library should not be
    // one enormous write holding the single writer.
    const processed = await repairLiveLocationCounts(batchSize);
    return { processed, errors: 0 };
  },
};
