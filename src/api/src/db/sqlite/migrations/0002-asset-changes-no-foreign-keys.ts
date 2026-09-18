/**
 * 0002 — remove the foreign keys from `asset_changes`.
 *
 * The argument for removing them is in `../ddl/library.ts`, next to the table:
 * a journal row has to outlive the thing it refers to, and the single most
 * important row in this table is a `delete`, written after the asset row is
 * already gone. This migration exists because that argument arrived (#3747)
 * after `0001-initial-schema` had shipped, and a migration the runner has
 * already recorded never runs again — `migrate.ts` skips on the recorded id
 * alone. Editing 0001's DDL in place therefore fixes a database created *after*
 * the edit and leaves every database created before it carrying
 * `ON DELETE SET NULL`, with nothing anywhere to say so. The first delete event
 * written on such a database is rejected by the key and swallowed by the change
 * repository's best-effort handler, and the File Provider extension never
 * learns which item to drop.
 *
 * SQLite cannot drop a constraint, so the repair is the twelve-step table
 * rebuild from its own ALTER TABLE documentation, minus the steps that only
 * apply to views and triggers (this table has neither). The rows are copied
 * rather than discarded: `cursor` is the client's sync anchor, so dropping the
 * journal would strand every client below the new floor on a 409 for no reason.
 *
 * It is conditional. A database created from the current 0001 already has the
 * table in its final shape, and rebuilding it there would be pure churn —
 * `PRAGMA foreign_key_list` is the direct question and answers no rows when
 * there is nothing to repair.
 *
 * `PRAGMA foreign_keys` is deliberately not touched. The pragma is per
 * connection and is set ON by `SCHEMA_PRAGMAS`, but SQLite defers it inside a
 * transaction — a change to it is a no-op until the transaction commits — and
 * `runMigrations` wraps every migration in `BEGIN IMMEDIATE`. The rebuild is
 * safe under enforcement anyway: the copy writes the same ids the old table
 * already held, and the only keys involved are the two being removed.
 */

import { ASSET_CHANGES_INDEX_DDL, ASSET_CHANGES_TABLE_DDL } from '../ddl/library.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

/** One row of `PRAGMA foreign_key_list`; only the count is read. */
interface ForeignKeyRow {
  id: number;
}

export const assetChangesNoForeignKeysMigration: Migration = {
  id: '0002-asset-changes-no-foreign-keys',
  async up(db: MigrationDb): Promise<void> {
    const keys = await db.all<ForeignKeyRow>(`PRAGMA foreign_key_list('asset_changes')`);
    if (keys.length === 0) return;

    // Renaming carries the old indexes with the table, so they have to go with
    // it — dropping the renamed table takes them, and the fresh ones are
    // created afterwards under their original names.
    await db.exec(`ALTER TABLE asset_changes RENAME TO asset_changes_pre_0002`);
    await db.exec(ASSET_CHANGES_TABLE_DDL);
    await db.exec(`
      INSERT INTO asset_changes (cursor, asset_id, folder_id, kind, abs_path, relative_path, at)
        SELECT cursor, asset_id, folder_id, kind, abs_path, relative_path, at
          FROM asset_changes_pre_0002
         ORDER BY cursor`);
    await db.exec(`DROP TABLE asset_changes_pre_0002`);
    await db.exec(ASSET_CHANGES_INDEX_DDL);
  },
};
