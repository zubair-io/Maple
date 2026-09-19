/**
 * 0002 — denormalise the asset's media kind onto `stage_state` (#3795).
 *
 * Adds the column, the partial claim index the media-only stages scan, the two
 * triggers that own the column, and the one-time backfill. `../ddl/stage-state.ts`
 * holds every one of those definitions and says why; this module is only the
 * migration wrapper around them, the same split `0001` uses.
 *
 * It is a second migration rather than an edit to the initial schema because
 * `0001` has shipped: the SQLite cutover (#3786) is live on a real library, and
 * a database that has recorded a migration id never runs it again. Editing the
 * initial schema would give new installs the column and leave that library
 * without it, with no error anywhere.
 *
 * Ordering inside `up` is load-bearing. The column and the index come first;
 * the backfill runs before the triggers exist, so it does the work in two
 * set-based statements rather than firing a per-row trigger 4.9 million times;
 * the triggers then keep the column true from that point on. Every migration
 * runs inside one transaction, so a crash part-way leaves the database on the
 * old schema rather than half-converted.
 *
 * Cost, measured on a generated library of the production shape (335,377
 * assets, 4.02 million stage rows): 3 ms for the `ALTER TABLE` — which is
 * metadata-only, because the column has a constant default — 1.3 s for the
 * backfill and 0.35 s for the index.
 */

import {
  STAGE_STATE_MEDIA_KIND_DDL,
  STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL,
  STAGE_STATE_MEDIA_KIND_TRIGGER_DDL,
} from '../ddl/stage-state.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const stageStateMediaKindMigration: Migration = {
  id: '0002-stage-state-media-kind',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(STAGE_STATE_MEDIA_KIND_DDL);
    await db.exec(STAGE_STATE_MEDIA_KIND_RECOMPUTE_SQL);
    await db.exec(STAGE_STATE_MEDIA_KIND_TRIGGER_DDL);
  },
};
