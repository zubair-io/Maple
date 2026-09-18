/**
 * 0002 — the tables the remaining-collections port (#3751) needs and the
 * initial schema did not have.
 *
 * This migration belongs to PR #3763, not to the importer. It is carried here,
 * under #3763's id and filename, for one reason: the importer has to put the
 * operator's settings somewhere, and two branches inventing two differently
 * named migrations that each `CREATE TABLE app_settings` is how a fresh
 * install breaks after both merge with no conflict to warn anyone. Sharing the
 * id and the path means git reports the collision instead of hiding it, and
 * #3763's version — a strict superset, five tables and a correction — is the
 * one to keep when the two meet.
 *
 * It is a migration at all only because #3763 already made it one. Nothing in
 * this epic has shipped and no database carries `0001-initial-schema` yet, so
 * editing the initial schema directly is still available and is what #3747,
 * #3749 and #3750 each did; migrations become the only option at cutover, not
 * before.
 */

import { APP_SETTINGS_TABLE_DDL } from '../ddl/settings.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const settingsAndAuditTablesMigration: Migration = {
  id: '0002-settings-and-audit-tables',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(APP_SETTINGS_TABLE_DDL);
  },
};
