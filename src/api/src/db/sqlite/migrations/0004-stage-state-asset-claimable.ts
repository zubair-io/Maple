/**
 * 0004 — denormalise asset claimability onto `stage_state`, and give the
 * dependency gate an index of its own (#3804).
 *
 * Adds the column, rebuilds the two claim indexes with it, adds `stage_dep`,
 * backfills the minority that are not claimable, and installs the two triggers
 * that own the column from there. `../ddl/stage-state.ts` holds every one of
 * those definitions and says why; this module is only the migration wrapper
 * around them, the same split `0001` and `0002` use.
 *
 * Ordering inside `up` is load-bearing, and for a different reason than `0002`'s
 * was. The backfill has to run before the triggers exist — otherwise it is a
 * per-row trigger firing 4 million times instead of two set-based statements —
 * and the index rebuild has to run before the backfill, because the backfill's
 * first statement finds the rows that currently read 0 through `stage_claim`,
 * which only carries the column once it has been rebuilt. Every migration runs
 * inside one transaction, so a crash part-way leaves the database on the old
 * schema rather than half-converted.
 *
 * Cost, measured on a generated library of the production shape (335,377
 * assets, 4.02 million stage rows): 4 ms for the `ALTER TABLE`, which is
 * metadata-only because the column has a constant default, 6.8 s to rebuild
 * `stage_claim`, 0.6 s for `stage_claim_media`, 8.0 s to build `stage_dep`, and
 * 0.35 s for the backfill. `stage_dep` is 167 MB of the resulting 1.82 GB.
 */

import {
  STAGE_STATE_ASSET_CLAIMABLE_DDL,
  STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL,
  STAGE_STATE_ASSET_CLAIMABLE_TRIGGER_DDL,
} from '../ddl/stage-state.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const stageStateAssetClaimableMigration: Migration = {
  id: '0004-stage-state-asset-claimable',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(STAGE_STATE_ASSET_CLAIMABLE_DDL);
    await db.exec(STAGE_STATE_ASSET_CLAIMABLE_RECOMPUTE_SQL);
    await db.exec(STAGE_STATE_ASSET_CLAIMABLE_TRIGGER_DDL);
  },
};
