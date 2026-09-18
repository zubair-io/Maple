/**
 * 0001 — the initial relational schema.
 *
 * Creates every table, index and trigger in one transaction. The DDL itself
 * lives under `../ddl/`, split by domain for readability; this module is only
 * the migration wrapper around it.
 *
 * There is no `down`. A schema this size has no meaningful reverse — the
 * rollback for a failed migration is the database file's backup, which is a
 * copy of one file, and that is one of the reasons the migration is worth
 * doing in the first place.
 */

import { INITIAL_INDEXES_SQL, INITIAL_TABLES_SQL, INITIAL_TRIGGERS_SQL } from '../ddl/index.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const initialSchemaMigration: Migration = {
  id: '0001-initial-schema',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(INITIAL_TABLES_SQL);
    await db.exec(INITIAL_INDEXES_SQL);
    await db.exec(INITIAL_TRIGGERS_SQL);
  },
};
