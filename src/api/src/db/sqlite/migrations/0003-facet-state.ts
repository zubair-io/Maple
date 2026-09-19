/**
 * 0003 — the mirrored facet state and the indexes over it (#3768).
 *
 * A separate migration rather than an edit to `0001-initial-schema`, because
 * that id shipped at the cutover (#3752). A database that has recorded it never
 * looks at it again, so an edit there would reach new installs only and leave
 * every existing one behind with no error anywhere.
 *
 * `0003` rather than the `0002` this was written as: `0002-stage-state-media-kind`
 * (#3795) merged first and owns that number. Nothing here depends on it — that
 * migration adds a column and two triggers on `stage_state`, which no facet
 * touches — so the two are independent and only the ordering is shared.
 *
 * The order is load-bearing in one place: the recompute runs before the indexes
 * are created, so each index is built once over final values rather than built
 * empty and then rewritten row by row. On a 335,377-asset library the whole
 * migration takes roughly fifteen seconds, almost all of it the one pass over
 * `asset_detail` — a table whose rows average several kilobytes, so setting two
 * columns rewrites them.
 */

import {
  ASSET_SUBJECTS_TABLE_DDL,
  FACET_STATE_COLUMNS_DDL,
  FACET_STATE_INDEX_DDL,
  FACET_STATE_RECOMPUTE_SQL,
  FACET_STATE_TRIGGER_DDL,
} from '../ddl/facet-state.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const facetStateMigration: Migration = {
  id: '0003-facet-state',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(FACET_STATE_COLUMNS_DDL);
    await db.exec(ASSET_SUBJECTS_TABLE_DDL);
    await db.exec(FACET_STATE_RECOMPUTE_SQL);
    await db.exec(FACET_STATE_INDEX_DDL);
    await db.exec(FACET_STATE_TRIGGER_DDL);
  },
};
