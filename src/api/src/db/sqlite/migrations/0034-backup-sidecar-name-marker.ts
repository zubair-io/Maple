import type { Migration, MigrationDb } from '../migrate.ts';

/** 0034 — the done-marker for the canonical-backup-sidecars migration (#5021). */
export const backupSidecarNameMarkerMigration: Migration = {
  id: '0034-backup-sidecar-name-marker',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`ALTER TABLE assets ADD COLUMN backup_sidecar_name_version INTEGER`);
  },
};
