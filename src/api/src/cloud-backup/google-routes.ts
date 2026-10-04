import { buildGoogleBackupRoutes } from '../routes/cloud-backup-google.ts';
import { loadPublicOrigin } from '../network/public-origin.ts';
import { backupEngine } from './runtime.ts';
import { GoogleConnectionError } from './google/config.ts';

export const googleBackupRoutes = buildGoogleBackupRoutes({
  origin: async () => {
    const origin = await loadPublicOrigin();
    if (!origin) throw new Error('Configure the browser-facing domain in Settings → Network first');
    return origin;
  },
  destination: (id) => backupEngine.repo.destination(id),
  attachRoot: async (id, rootId, accountId, generation) => {
    const result = await backupEngine.repo.db.write(
      `UPDATE backup_destinations SET root_id=?,account_id=?,generation=generation+1
      WHERE id=? AND kind='google-drive' AND generation=? AND (root_id IS NULL OR root_id=?)
      AND (account_id IS NULL OR account_id=?)`,
      [rootId, accountId, id, generation, rootId, accountId],
    );
    if (!result.changes)
      throw new GoogleConnectionError(
        'Destination changed or already owns another root/account. Create a new destination to change it.',
      );
    const destination = await backupEngine.repo.destination(id);
    if (destination) await backupEngine.repo.rearmLibrary(destination.libraryId);
  },
  connectionChanged: async (id) => {
    await backupEngine.repo.db.transaction([
      { sql: `UPDATE backup_destinations SET generation=generation+1 WHERE id=?`, params: [id] },
      {
        sql: `UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,lease_owner=NULL,lease_until=0 WHERE destination_id=? AND state!='purged'`,
        params: [id],
      },
    ]);
    const destination = await backupEngine.repo.destination(id);
    if (destination) await backupEngine.repo.rearmLibrary(destination.libraryId);
  },
});
