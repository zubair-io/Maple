/**
 * `backup_sidecar_names_migrated` — the assets the canonical-backup-sidecars
 * migration (#5021) has handled. Its own table, so `assets` keeps its schema.
 */
import type { ObjectId } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

export const NOT_YET_MIGRATED = `NOT EXISTS (
  SELECT 1 FROM backup_sidecar_names_migrated m WHERE m.asset_id = a.id)`;

export async function markBackupSidecarNamesMigrated(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT OR IGNORE INTO backup_sidecar_names_migrated (asset_id) VALUES (?)`,
    [id.toHexString()],
  );
}
