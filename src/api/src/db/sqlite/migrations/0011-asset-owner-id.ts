/**
 * 0011 — add `owner_id` to `assets` table and backfill existing assets.
 *
 * Adds `owner_id TEXT REFERENCES users (id) ON DELETE SET NULL`, builds the
 * `assets_facet_owner` index over live assets, and backfills any unowned assets
 * with the primary server owner (first user with role = 'owner').
 */

import {
  ASSET_OWNER_BACKFILL_SQL,
  ASSET_OWNER_COLUMN_DDL,
  ASSET_OWNER_INDEX_DDL,
} from '../ddl/assets.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const assetOwnerIdMigration: Migration = {
  id: '0011-asset-owner-id',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(ASSET_OWNER_COLUMN_DDL);
    await db.exec(ASSET_OWNER_INDEX_DDL);
    await db.exec(ASSET_OWNER_BACKFILL_SQL);
  },
};
