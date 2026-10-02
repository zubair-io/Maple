import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import type { Migration } from '../migrate.ts';

export const ownerCapturePaginationMigration: Migration = {
  id: '0013-owner-capture-pagination',
  async up(db): Promise<void> {
    // Each direction keeps id ascending for the existing cursor tie breaker.
    // Reversing one index would reverse id too and require sorting burst frames.
    await db.exec(`
      CREATE INDEX assets_live_owner_captured
        ON assets (owner_id, captured_at DESC, id)
        WHERE ${LIVE_ASSET_PREDICATE};
      CREATE INDEX assets_live_owner_captured_asc
        ON assets (owner_id, captured_at ASC, id)
        WHERE ${LIVE_ASSET_PREDICATE};
    `);
  },
};
