import type { Migration, MigrationDb } from '../migrate.ts';

/** 0034 — the done-marker for the canonical-backup-sidecars migration (#5021),
 * kept in its own table so the `assets` schema is unchanged. */
export const backupSidecarNamesMigratedMigration: Migration = {
  id: '0034-backup-sidecar-names-migrated',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE backup_sidecar_names_migrated (
      asset_id TEXT NOT NULL PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE
    )`);
  },
};
