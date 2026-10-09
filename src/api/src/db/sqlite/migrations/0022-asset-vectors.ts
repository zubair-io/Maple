import { ASSET_VECTORS_INDEX_DDL, ASSET_VECTORS_TABLE_DDL } from '../ddl/asset-vectors.ts';
import type { Migration } from '../migrate.ts';

/**
 * 0022 — the vector table behind the `embed` stage (#4461), plus the dense `stage_state` rows
 * the claim index needs for assets that predate the stage.
 */
export const assetVectorsMigration: Migration = {
  id: '0022-asset-vectors',
  async up(db): Promise<void> {
    await db.exec(ASSET_VECTORS_TABLE_DDL);
    await db.exec(ASSET_VECTORS_INDEX_DDL);
    await db.exec(`INSERT INTO stage_state(asset_id,stage)
      SELECT id,'embed' FROM assets WHERE true
      ON CONFLICT(asset_id,stage) DO NOTHING`);
  },
};
