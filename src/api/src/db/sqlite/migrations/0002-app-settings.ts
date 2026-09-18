/**
 * 0002 — `app_settings`, the operator's DB-backed configuration.
 *
 * A table the initial schema did not cover. The collection has no accessor in
 * `db/client.ts` — a dozen `*-config.repo.ts` modules open it by name — so it
 * was missed when the schema was enumerated from that file, and the omission
 * only became visible when the importer went looking for somewhere to put
 * Cloudflare credentials, the map configuration and the worker tunables.
 *
 * It lands as its own migration rather than as an edit to 0001 because 0001 has
 * shipped: `assertMigrationOrder` and the `schema_migrations` sentinel both
 * assume an applied id is frozen, and a database that already recorded
 * `0001-initial-schema` would never re-run an amended copy of it.
 */

import { APP_SETTINGS_TABLE_DDL } from '../ddl/app-settings.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const appSettingsMigration: Migration = {
  id: '0002-app-settings',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(APP_SETTINGS_TABLE_DDL);
  },
};
