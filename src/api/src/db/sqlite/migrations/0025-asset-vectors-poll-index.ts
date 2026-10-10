import { ASSET_VECTORS_POLL_INDEX_DDL } from '../ddl/asset-vectors.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/** 0025 — the covering index the search child polls `asset_vectors` through (#4463). */
export const assetVectorsPollIndexMigration: Migration = {
  id: '0025-asset-vectors-poll-index',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(ASSET_VECTORS_POLL_INDEX_DDL);
  },
};
