import { ASSET_VECTORS_SEARCH_SYNC_INDEX_DDL } from '../ddl/asset-vectors.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/** 0023 — the covering index the search child polls `asset_vectors` through (#4463). */
export const assetVectorsSearchSyncMigration: Migration = {
  id: '0023-asset-vectors-search-sync',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(ASSET_VECTORS_SEARCH_SYNC_INDEX_DDL);
  },
};
