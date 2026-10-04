import { CLOUD_BACKUP_DDL } from '../ddl/cloud-backup.ts';
import type { Migration } from '../migrate.ts';
import { GOOGLE_BACKUP_DDL } from '../../../cloud-backup/google/repo.ts';

export const cloudBackupMigration: Migration = {
  id: '0014-cloud-backup',
  async up(db): Promise<void> {
    await db.exec(CLOUD_BACKUP_DDL + GOOGLE_BACKUP_DDL);
  },
};
