import { Elysia, t } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { loadDbBackupSettings, saveDbBackupPolicy } from '../cloudflare/backup-retain-config.ts';
import { backupConfiguration, backupRunning } from '../cloudflare/db-backup.ts';
import {
  maintenanceRunRequest,
  requestMaintenanceRun,
} from '../workers/maintenance/run-now.repo.ts';

const DB_BACKUP_TASK = 'db-backup';

/** The worker tier picks a request up within seconds; one this old is not going to be. */
const REQUEST_PICKUP_MS = 2 * 60_000;

/**
 * Running from the moment a backup is requested, until it finishes. A
 * request nobody picks up — no worker process, or no Temporal — stops counting
 * after a couple of minutes and is reported instead, so "Back up now" never
 * stays locked.
 */
async function backupState(now = Date.now()) {
  const settings = await loadDbBackupSettings();
  const request = await maintenanceRunRequest(DB_BACKUP_TASK);
  const unclaimed = request !== null && now - Date.parse(request.requestedAt) >= REQUEST_PICKUP_MS;
  return {
    ...settings,
    running: backupRunning(settings.status, now) || (request !== null && !unclaimed),
    ...(unclaimed
      ? {
          request_error: `The backup requested at ${request.requestedAt} was not picked up: check that the worker process and Temporal are running`,
        }
      : {}),
  };
}

const count = () => t.Integer({ minimum: 0, maximum: 1000 });
export const dbBackupRoutes = new Elysia({ prefix: '/api/admin/backup/db' })
  .use(requireAuth)
  .use(requireOwner)
  .get('', () => backupState())
  .put(
    '/config',
    async ({ body, set }) => {
      if (body.enabled && !body.bucket) {
        set.status = 400;
        return { error: 'A private R2 backup bucket is required' };
      }
      if (backupRunning((await loadDbBackupSettings()).status)) {
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
    if ((await backupState()).running) {
      set.status = 409;
      return { error: 'A database backup is already running' };
    }
    await requestMaintenanceRun(DB_BACKUP_TASK, { force: true });
    set.status = 202;
    return { accepted: true };
  });
