import { LOCATION_SEARCH_TRIGGER_DDL } from '../ddl/location-search-triggers.ts';
import type { Migration } from '../migrate.ts';

/**
 * 0024 — re-queue `meili` and `embed` when an asset's primary location changes (#4491). The
 * primary location supplies the filename in the searchable text.
 */
export const locationSearchTriggersMigration: Migration = {
  id: '0024-location-search-triggers',
  async up(db): Promise<void> {
    await db.exec(LOCATION_SEARCH_TRIGGER_DDL);
  },
};
