export const BACKUP_PREFIX = 'backups/sqlite/';

export function computeBackupKey(schema: string, now = new Date()): string {
  return `${BACKUP_PREFIX}maple-backup-${now.toISOString()}-${schema}.db.gz`;
}

export function backupTimestamp(key: string): number | null {
  const match =
    /^backups\/sqlite\/maple-backup-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[\w-]+\.db\.gz$/.exec(
      key,
    );
  if (!match) return null;
  const time = Date.parse(match[1]!);
  return Number.isFinite(time) && new Date(time).toISOString() === match[1] ? time : null;
}
