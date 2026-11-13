import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlitePool } from '../db/sqlite/index.ts';
import {
  hasCloudflareCredentials,
  loadCloudflareConfig,
  resolveCloudflareConfig,
} from './cloudflare-config.repo.ts';
import {
  loadDbBackupSettings,
  saveDbBackupStatus,
  type DbBackupStatus,
} from './backup-retain-config.ts';
import { createSnapshot } from './backup-snapshot.ts';
import { computeBackupKey } from './backup-key.ts';
import { BackupR2 } from './backup-r2.ts';
import { verifyBackup } from './backup-restore.ts';
import { expiredBackups } from './backup-retention.ts';
import { version } from '../../package.json';
import { child } from '../log.ts';

const log = child('db-backup');

const ATTEMPT_SPACING_MS = 60 * 60_000;
const HEARTBEAT_MS = 30_000;
/** Several missed heartbeats: whatever process was writing them is gone. */
const HEARTBEAT_STALE_MS = 5 * 60_000;

/**
 * A backup is running while its stored status says so and its heartbeat is
 * recent. A worker that died mid-backup leaves `running` behind with a
 * heartbeat that stops moving, which stops counting after a few minutes.
 */
export function backupRunning(status: DbBackupStatus | null, now = Date.now()): boolean {
  return (
    status?.state === 'running' &&
    Date.parse(status.heartbeat_at ?? status.started_at) > now - HEARTBEAT_STALE_MS
  );
}

export async function backupConfiguration() {
  const { policy } = await loadDbBackupSettings();
  const config = resolveCloudflareConfig(await loadCloudflareConfig());
  if (!hasCloudflareCredentials(config) || !policy.bucket)
    throw new Error('Save R2 credentials and a database backup bucket first');
  return { policy, config: { ...config, bucket: policy.bucket } };
}

const runningStatus = (started_at: string): DbBackupStatus => ({
  state: 'running',
  started_at,
  heartbeat_at: new Date().toISOString(),
});

/** Stopping waits for a heartbeat already being written, so it cannot land after the final status. */
function keepHeartbeat(started_at: string): () => Promise<void> {
  let latestBeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    latestBeat = saveDbBackupStatus(runningStatus(started_at)).catch((error: unknown) => {
      log.warn({ err: error }, 'Could not record the database backup heartbeat');
    });
  }, HEARTBEAT_MS);
  return async () => {
    clearInterval(timer);
    await latestBeat;
  };
}

async function inScratchDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'maple-db-backup-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn({ err: error, directory }, 'Could not remove the database backup scratch directory');
    });
  }
}

async function snapshotAndUpload(
  directory: string,
  started_at: string,
  signal: AbortSignal,
): Promise<DbBackupStatus> {
  const { policy, config } = await backupConfiguration();
  const storage = new BackupR2(config);
  const path = join(directory, 'snapshot.db');
  const info = await createSnapshot(sqlitePool().path, path);
  signal.throwIfAborted();
  const key = computeBackupKey(info.schema);
  await storage.upload(key, `${path}.gz`, info, version);
  signal.throwIfAborted();
  await verifyBackup(await storage.download(key), join(directory, 'verified.db'));
  await storage.confirm(key, info.sha256);
  const retention_error = await storage
    .list()
    .then((keys) => storage.delete(expiredBackups(keys, policy)))
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  return {
    state: 'succeeded',
    started_at,
    finished_at: new Date().toISOString(),
    key,
    bytes: info.bytes,
    compressed_bytes: info.compressed_bytes,
    ...(retention_error ? { retention_error } : {}),
  };
}

async function runBackup(signal: AbortSignal): Promise<void> {
  const started_at = new Date().toISOString();
  await saveDbBackupStatus(runningStatus(started_at));
  const stopHeartbeat = keepHeartbeat(started_at);
  try {
    const succeeded = await inScratchDirectory((directory) =>
      snapshotAndUpload(directory, started_at, signal),
    );
    await stopHeartbeat();
    await saveDbBackupStatus(succeeded);
  } catch (error) {
    log.error({ err: error }, 'Database backup failed');
    await stopHeartbeat();
    await saveDbBackupStatus({
      state: 'failed',
      started_at,
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function backupDue(hour: number, lastSuccess: string | null, now = new Date()): boolean {
  const scheduled = new Date(now);
  scheduled.setHours(hour, 0, 0, 0);
  return now >= scheduled && (!lastSuccess || Date.parse(lastSuccess) < scheduled.getTime());
}

/** Enabled, past today's configured hour with no success since, and no attempt in the last hour. */
async function scheduledBackupDue(now = Date.now()): Promise<boolean> {
  const { policy, status, last_success_at } = await loadDbBackupSettings();
  const lastAttempt = status ? Date.parse(status.started_at) : 0;
  return (
    policy.enabled &&
    backupDue(policy.hour, last_success_at, new Date(now)) &&
    now - lastAttempt >= ATTEMPT_SPACING_MS
  );
}

/**
 * One backup check: a scheduled pass backs up only when one is due, a forced
 * pass (an operator's "Back up now") always does. The maintenance activity
 * never runs two passes at once, and makes a forced one wait its turn.
 */
export async function runDbBackupPass(
  signal: AbortSignal,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  if (force || (await scheduledBackupDue())) await runBackup(signal);
}
