import { LIVE_ASSET_PREDICATE } from '../ddl/assets.ts';
import type { Migration } from '../migrate.ts';

export const assetsLiveMonthMigration: Migration = {
  id: '0019-assets-live-month',
  async up(db): Promise<void> {
    // The month-of-year filter (#4413). `captured_month` is a virtual column
    // over the exif JSON, so without this every candidate row was fetched and
    // its JSON parsed; `id` makes the index covering for the probe a text
    // search's count and facets make per match.
    await db.exec(`
      CREATE INDEX assets_live_month
        ON assets (captured_month, hidden, id)
        WHERE ${LIVE_ASSET_PREDICATE};
    `);
  },
};
