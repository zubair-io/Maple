import { patchAppSettings, readAppSettings } from '../db/repos/app-settings.repo.ts';

export interface DbBackupPolicy {
  enabled: boolean;
  bucket: string;
  hour: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export interface DbBackupStatus {
  state: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at?: string;
  key?: string;
  bytes?: number;
  compressed_bytes?: number;
  error?: string;
  retention_error?: string;
}

export const DEFAULT_DB_BACKUP_POLICY: DbBackupPolicy = {
  enabled: false,
  bucket: '',
  hour: 3,
  daily: 7,
  weekly: 4,
  monthly: 12,
  yearly: 5,
};

export async function loadDbBackupSettings() {
  const doc = await readAppSettings<{
    policy?: DbBackupPolicy;
    status?: DbBackupStatus;
    last_success_at?: string;
  }>('db-backups');
  return {
    policy: { ...DEFAULT_DB_BACKUP_POLICY, ...doc?.policy },
    status: doc?.status ?? null,
    last_success_at: doc?.last_success_at ?? null,
  };
}

export async function saveDbBackupPolicy(policy: DbBackupPolicy): Promise<void> {
  await patchAppSettings('db-backups', { policy });
}

export async function saveDbBackupStatus(status: DbBackupStatus): Promise<void> {
  await patchAppSettings('db-backups', {
    status,
    ...(status.state === 'succeeded' ? { last_success_at: status.finished_at } : {}),
  });
}
