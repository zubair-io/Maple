import { buildGoogleBackupRoutes } from '../routes/cloud-backup-google.ts';
import { loadPublicOrigin } from '../network/public-origin.ts';
import { backupEngine } from './runtime.ts';
import { GoogleConnectionError } from './google/config.ts';
import { ConnectionRefresh } from './connection-refresh.ts';

const connectionRefresh = new ConnectionRefresh(backupEngine.repo);

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
  connectionChanged: (id) => connectionRefresh.changed(id),
  connectionFenced: (id) => connectionRefresh.fenced(id),
  connectionRestored: (id) => connectionRefresh.restored(id),
});
