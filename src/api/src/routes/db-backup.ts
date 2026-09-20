import { Elysia, t } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { loadDbBackupSettings, saveDbBackupPolicy } from '../cloudflare/backup-retain-config.ts';
import { backupRunning, backupConfiguration, startDbBackup } from '../cloudflare/db-backup.ts';

const count = () => t.Integer({ minimum: 0, maximum: 1000 });
export const dbBackupRoutes = new Elysia({ prefix: '/api/admin/backup/db' })
  .use(requireAuth)
  .use(requireOwner)
  .get('', async () => ({ ...(await loadDbBackupSettings()), running: backupRunning() }))
  .put(
    '/config',
    async ({ body, set }) => {
      if (body.enabled && !body.bucket) {
        set.status = 400;
        return { error: 'A private R2 backup bucket is required' };
      }
      if (backupRunning()) {
        set.status = 409;
        return { error: 'Wait for the active backup before changing its policy' };
      }
      await saveDbBackupPolicy(body);
      return loadDbBackupSettings();
    },
    {
      body: t.Object({
        enabled: t.Boolean(),
        bucket: t.String({ maxLength: 63, pattern: '^$|^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }),
        hour: t.Integer({ minimum: 0, maximum: 23 }),
        daily: count(),
        weekly: count(),
        monthly: count(),
        yearly: count(),
      }),
    },
  )
  .post('', async ({ set }) => {
    try {
      await backupConfiguration();
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!startDbBackup()) {
      set.status = 409;
      return { error: 'A database backup is already running' };
    }
    set.status = 202;
    return { accepted: true };
  });
