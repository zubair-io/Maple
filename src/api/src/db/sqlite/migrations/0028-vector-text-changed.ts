import { VECTOR_TEXT_CHANGED_DDL } from '../ddl/asset-vectors.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/** 0028 — stamp a vector row when its asset's `search_blob` changes, for the search child (#4512). */
export const vectorTextChangedMigration: Migration = {
  id: '0028-vector-text-changed',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(VECTOR_TEXT_CHANGED_DDL);
  },
};
