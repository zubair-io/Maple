import type { Migration, MigrationDb } from '../migrate.ts';

/** 0034 — the canonical-backup-sidecars migration's per-asset state (#5021):
 * `checked = 1` done, `0` due again (e.g. after a merge). Its own table, so the
 * `assets` schema is unchanged. */
export const backupSidecarNameChecksMigration: Migration = {
  id: '0034-backup-sidecar-name-checks',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE backup_sidecar_name_checks (
      asset_id TEXT NOT NULL PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      checked  INTEGER NOT NULL CHECK (checked IN (0, 1))
    )`);
  },
};
