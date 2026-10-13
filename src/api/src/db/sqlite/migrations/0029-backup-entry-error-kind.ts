import type { Migration, MigrationDb } from '../migrate.ts';

/** 0029 — record what kind of failure a backup entry last hit, so a healthy
 * reconnect can rearm connection failures without matching message text (#4605). */
export const backupEntryErrorKindMigration: Migration = {
  id: '0029-backup-entry-error-kind',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE backup_entries ADD COLUMN error_kind TEXT`);
  },
};
