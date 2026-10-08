import type { Migration } from '../migrate.ts';

/** Supports exact per-entry erasure of stale mirror paths after an interrupted move. */
export const cloudBackupObjectEntryIndexMigration: Migration = {
  id: '0017-cloud-backup-object-entry-index',
  async up(db): Promise<void> {
    await db.exec(
      `CREATE INDEX backup_objects_entry ON backup_objects(destination_id,entry_id,key)`,
    );
  },
};
