import type { Migration, MigrationDb } from '../migrate.ts';

/** 0029 — record what kind of failure a backup entry last hit, so a healthy
 * reconnect can rearm connection failures without matching message text (#4605). */
export const backupEntryErrorKindMigration: Migration = {
  id: '0029-backup-entry-error-kind',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE backup_entries ADD COLUMN error_kind TEXT`);
    // Partial: only rows waiting on a reconnect are indexed, so the per-transfer
    // "anything left to rearm?" probe is a single index lookup on a healthy
    // destination instead of a scan of every entry.
    await db.exec(`CREATE INDEX backup_entries_connection_failures
      ON backup_entries(destination_id) WHERE error_kind='connection'`);
  },
};
