import { GENERATED_SEARCHES_FIRST_PAGE_DDL } from '../ddl/settings.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/**
 * 0023 — the ordered asset ids of a card's first page, stored by the worker so
 * `/api/generated-searches/:id/assets` can serve the grid without re-running a
 * broad query per card (#4446). Null on rows written before this column.
 */
export const generatedSearchesFirstPageMigration: Migration = {
  id: '0023-generated-searches-first-page',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(GENERATED_SEARCHES_FIRST_PAGE_DDL);
  },
};
