import type { Migration, MigrationDb } from '../migrate.ts';

/** 0045 — what a backup send carried when the server merged it into something else
 * (#5796). The device keeps what it sent, not the merged sidecar, so its next send
 * is reconciled from these adjustments. Keyed by the history entry the send became. */
export const backupSidecarSendsMigration: Migration = {
  id: '0045-backup-sidecar-sends',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE backup_sidecar_sends (
      library_id       TEXT NOT NULL,
      sidecar_rel_path TEXT NOT NULL,
      entry_id         TEXT NOT NULL,
      asset_id         TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      sent_checkpoint  TEXT NOT NULL,
      PRIMARY KEY (library_id, sidecar_rel_path, entry_id)
    )`);
    await db.exec(`CREATE INDEX backup_sidecar_sends_asset ON backup_sidecar_sends(asset_id)`);
  },
};
