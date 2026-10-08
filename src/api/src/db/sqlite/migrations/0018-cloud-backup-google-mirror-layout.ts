import type { Migration } from '../migrate.ts';

/** Requeue legacy Google manifests and prevent persisted Drive-root collisions. */
export const cloudBackupGoogleMirrorLayoutMigration: Migration = {
  id: '0018-cloud-backup-google-mirror-layout',
  async up(db): Promise<void> {
    // Older releases allowed multiple destinations to bind the same root. Keep
    // the enabled, oldest destination and disconnect the others without touching
    // their remote files so users can reconnect them to distinct roots.
    await db.exec(`UPDATE backup_destinations
      SET root_id=NULL,account_id=NULL,enabled=0,generation=generation+1
      WHERE kind='google-drive' AND root_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM backup_destinations winner
        WHERE winner.kind='google-drive' AND winner.root_id=backup_destinations.root_id
          AND winner.id<>backup_destinations.id
          AND (winner.enabled>backup_destinations.enabled OR
            (winner.enabled=backup_destinations.enabled AND
              (winner.created_at<backup_destinations.created_at OR
                (winner.created_at=backup_destinations.created_at AND
                  winner.id<backup_destinations.id))))
      )`);
    await db.exec(`CREATE UNIQUE INDEX backup_destinations_google_root
      ON backup_destinations(root_id)
      WHERE kind='google-drive' AND root_id IS NOT NULL`);

    // Force every non-purged Google entry through the current mirror layout.
    // The old manifest remains available until the replacement manifest commits.
    await db.exec(`UPDATE backup_entries
      SET sequence=sequence+1,snapshot_hash=NULL,attempts=0,retry_at=0,last_error=NULL,
        lease_owner=NULL,lease_until=0
      WHERE state!='purged' AND destination_id IN (
        SELECT id FROM backup_destinations WHERE kind='google-drive'
      )`);
    await db.exec(`UPDATE stage_state
      SET version=0,attempts=0,dead=0,last_error=NULL,failed_at=NULL,next_attempt_at=NULL
      WHERE stage='cloud-backup' AND asset_id IN (
        SELECT DISTINCT e.asset_id FROM backup_entries e
        JOIN backup_destinations d ON d.id=e.destination_id
        WHERE d.kind='google-drive'
      )`);
  },
};
