import type { Migration } from '../migrate.ts';

/**
 * The assets a default search never lists: trashed, without a live file, or
 * hidden (#4425). Spelled as the exact complement of the live predicate plus
 * `hidden = 0`, so a text search's total can be counted as "every full-text
 * match, less the unlisted ones" without reading a row per match.
 */
export const UNLISTED_ASSET_PREDICATE =
  'deleted_at IS NOT NULL OR live_location_count <= 0 OR hidden = 1';

export const assetsUnlistedMigration: Migration = {
  id: '0020-assets-unlisted',
  async up(db): Promise<void> {
    await db.exec(`
      CREATE INDEX assets_unlisted
        ON assets (id)
        WHERE ${UNLISTED_ASSET_PREDICATE};
    `);
  },
};
