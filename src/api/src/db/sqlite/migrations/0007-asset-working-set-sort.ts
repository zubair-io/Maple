import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const assetWorkingSetSortMigration: Migration = {
  id: '0007-asset-working-set-sort',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`
      ALTER TABLE assets ADD COLUMN sort_at TEXT
        GENERATED ALWAYS AS (COALESCE(captured_at, indexed_at)) VIRTUAL;
      CREATE INDEX assets_live_sorted ON assets (sort_at DESC, id)
        WHERE ${LIVE_ASSET_PREDICATE};
    `);
  },
};
