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
    if (!(await backupEngine.repo.attachGoogleRoot(id, rootId, accountId, generation)))
      throw new GoogleConnectionError(
        'Destination changed, this Drive root is already used by another library, or the account does not match.',
      );
    const destination = await backupEngine.repo.destination(id);
    if (destination) await backupEngine.repo.rearmLibrary(destination.libraryId);
  },
  connectionChanged: async (id) => {
    await backupEngine.repo.db.transaction([
      {
        sql: `UPDATE backup_destinations SET generation=generation+1 WHERE id=?`,
        params: [id],
      },
      {
        sql: `UPDATE backup_entries SET sequence=sequence+1,snapshot_hash=NULL,lease_owner=NULL,lease_until=0 WHERE destination_id=? AND state!='purged'`,
        params: [id],
      },
    ]);
    const destination = await backupEngine.repo.destination(id);
    if (destination) await backupEngine.repo.rearmLibrary(destination.libraryId);
  },
  connectionRestored: (id) => backupEngine.repo.clearResolvedGoogleConnectionErrors(id),
});
