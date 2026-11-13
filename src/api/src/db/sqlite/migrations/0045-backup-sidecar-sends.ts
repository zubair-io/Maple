import type { Migration, MigrationDb } from '../migrate.ts';

/** 0045 — what a backup device sent where the sidecar's history cannot show it (#5796):
 * a send the server merged into other adjustments, keyed by the entry it became, and a
 * send acknowledged as unchanged, keyed by the entry it was acknowledged at (`''` for
 * none). The device's next send names the digest and is reconciled from these
 * adjustments. Keyed by asset, so a moved photo and every copy of it keep them. */
export const backupSidecarSendsMigration: Migration = {
  id: '0045-backup-sidecar-sends',
  async up(db: MigrationDb): Promise<void> {
    await db.exec(`CREATE TABLE backup_sidecar_sends (
      asset_id         TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      sent_sha256      TEXT NOT NULL,
      entry_id         TEXT NOT NULL,
      sent_checkpoint  TEXT NOT NULL,
      PRIMARY KEY (asset_id, sent_sha256, entry_id)
    )`);
  },
};
