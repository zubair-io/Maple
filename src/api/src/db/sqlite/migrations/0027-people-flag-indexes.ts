import { PEOPLE_FLAG_INDEX_DDL } from '../ddl/faces.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/** 0027 — partial indexes for the hidden/excluded person lookups every read path makes (#4546). */
export const peopleFlagIndexesMigration: Migration = {
  id: '0027-people-flag-indexes',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(PEOPLE_FLAG_INDEX_DDL);
  },
};
