/**
 * 0002 — the tables the remaining-collections port (#3751) needs and the
 * initial schema did not have.
 *
 * Five collections were not enumerated by #3743 (`app_settings`,
 * `indexer_checkpoints`, `managed_certificates`, `generated_searches`,
 * `video_geo_backfill_audit`) and one was modelled from its name rather than
 * its contents (`image_access_tokens`). Both kinds of gap are fixed here
 * rather than by editing `0001`, because a shipped migration id is frozen: a
 * database that already recorded `0001-initial-schema` would never re-run it,
 * so an edit there would apply to new installs only and the two would diverge
 * silently.
 *
 * The DDL lives in `../ddl/settings.ts`, beside the rest of the schema.
 */

import {
  APP_SETTINGS_TABLE_DDL,
  GENERATED_SEARCHES_INDEX_DDL,
  GENERATED_SEARCHES_TABLE_DDL,
  IMAGE_ACCESS_TOKENS_REBUILD_DDL,
  INDEXER_CHECKPOINTS_TABLE_DDL,
  MANAGED_CERTIFICATES_TABLE_DDL,
  VIDEO_GEO_BACKFILL_AUDIT_TABLE_DDL,
} from '../ddl/settings.ts';
import type { Migration, MigrationDb } from '../migrate.ts';

export const settingsAndAuditTablesMigration: Migration = {
  id: '0002-settings-and-audit-tables',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(APP_SETTINGS_TABLE_DDL);
    await db.exec(INDEXER_CHECKPOINTS_TABLE_DDL);
    await db.exec(MANAGED_CERTIFICATES_TABLE_DDL);
    await db.exec(GENERATED_SEARCHES_TABLE_DDL);
    await db.exec(VIDEO_GEO_BACKFILL_AUDIT_TABLE_DDL);
    await db.exec(GENERATED_SEARCHES_INDEX_DDL);
    await db.exec(IMAGE_ACCESS_TOKENS_REBUILD_DDL);
  },
};
