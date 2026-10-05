import { CLOUD_BACKUP_DDL } from '../ddl/cloud-backup.ts';
import type { Migration } from '../migrate.ts';
import { GOOGLE_BACKUP_DDL } from '../../../cloud-backup/google/repo.ts';

export const cloudBackupMigration: Migration = {
  id: '0014-cloud-backup',
  async up(db): Promise<void> {
    await db.exec(CLOUD_BACKUP_DDL + GOOGLE_BACKUP_DDL);
    // Existing assets predate the new manifest entry. Dense stage rows are
    // required by the claim index; UPDATE-only rearming cannot create them.
    await db.exec(`INSERT INTO stage_state(asset_id,stage)
      SELECT id,'cloud-backup' FROM assets WHERE true
      ON CONFLICT(asset_id,stage) DO NOTHING`);
  },
};
