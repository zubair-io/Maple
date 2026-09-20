import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlitePool } from '../db/sqlite/index.ts';
import {
  hasCloudflareCredentials,
  loadCloudflareConfig,
  resolveCloudflareConfig,
} from './cloudflare-config.repo.ts';
import { loadDbBackupSettings, saveDbBackupStatus } from './backup-retain-config.ts';
import { createSnapshot } from './backup-snapshot.ts';
import { computeBackupKey } from './backup-key.ts';
import { BackupR2 } from './backup-r2.ts';
import { verifyBackup } from './backup-restore.ts';
import { expiredBackups } from './backup-retention.ts';
import { version } from '../../package.json';
import { child } from '../log.ts';

const log = child('db-backup');
let running: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;
let lastAttempt = 0;

export function backupRunning(): boolean {
  return running !== null;
}

export async function backupConfiguration() {
  const { policy } = await loadDbBackupSettings();
  const config = resolveCloudflareConfig(await loadCloudflareConfig());
  if (!hasCloudflareCredentials(config) || !policy.bucket)
    throw new Error('Save R2 credentials and a database backup bucket first');
  return { policy, config: { ...config, bucket: policy.bucket } };
}

async function runBackup(): Promise<void> {
  const started_at = new Date().toISOString();
  let directory: string | undefined;
  try {
    await saveDbBackupStatus({ state: 'running', started_at });
    directory = await mkdtemp(join(tmpdir(), 'maple-db-backup-'));
    const { policy, config } = await backupConfiguration();
    const storage = new BackupR2(config);
    const path = join(directory, 'snapshot.db');
    const info = await createSnapshot(sqlitePool().path, path);
    const key = computeBackupKey(info.schema);
    await storage.upload(key, `${path}.gz`, info, version);
    await verifyBackup(await storage.download(key), join(directory, 'verified.db'));
    await storage.confirm(key, info.sha256);
    const retention_error = await storage
      .list()
      .then((keys) => storage.delete(expiredBackups(keys, policy)))
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await saveDbBackupStatus({
      state: 'succeeded',
      started_at,
      finished_at: new Date().toISOString(),
      key,
      bytes: info.bytes,
      compressed_bytes: info.compressed_bytes,
      ...(retention_error ? { retention_error } : {}),
    });
  } catch (error) {
    await saveDbBackupStatus({
      state: 'failed',
      started_at,
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function startDbBackup(): boolean {
  if (running) return false;
  lastAttempt = Date.now();
  running = runBackup()
    .catch((error) => {
      log.error({ err: error }, 'Database backup failed');
    })
    .finally(() => {
      running = null;
    });
  return true;
}

export function backupDue(hour: number, lastSuccess: string | null, now = new Date()): boolean {
  const scheduled = new Date(now);
  scheduled.setHours(hour, 0, 0, 0);
  return now >= scheduled && (!lastSuccess || Date.parse(lastSuccess) < scheduled.getTime());
}

async function tick(): Promise<void> {
  if (checking || running || Date.now() - lastAttempt < 60 * 60_000) return;
  checking = true;
  try {
    const { policy, last_success_at } = await loadDbBackupSettings();
    if (timer && policy.enabled && backupDue(policy.hour, last_success_at)) startDbBackup();
  } catch (error) {
    log.error({ err: error }, 'Database backup scheduler failed');
  } finally {
    checking = false;
  }
}

export function startDbBackupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, 60_000);
  timer.unref();
  void tick();
}

export async function stopDbBackupScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await running;
}
