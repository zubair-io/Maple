/**
 * `backup_sidecar_name_checks` — which assets the canonical-backup-sidecars
 * migration (#5021) has checked for pre-#5021 `IMG.HEIC.xmp` sidecars.
 */
import type { ObjectId } from '../object-id.ts';
import type { FileInfo } from '../schema.ts';
import { BACKUP_ORIGIN, LIVE_LOCATION } from './assets.migrations.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** A backed-up asset never checked, or any asset a merge made due again. */
export const NEEDS_CANONICAL_SIDECAR_CHECK = `(
  EXISTS (SELECT 1 FROM backup_sidecar_name_checks c WHERE c.asset_id = a.id AND c.checked = 0)
  OR (${BACKUP_ORIGIN}
      AND NOT EXISTS (SELECT 1 FROM backup_sidecar_name_checks c WHERE c.asset_id = a.id)))`;

/** A merge or rename that changed the locations since the scan keeps the asset due. */
export async function markCanonicalSidecarsChecked(
  id: ObjectId,
  scanned: readonly Pick<FileInfo, 'library_id' | 'path' | 'filename'>[],
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const hex = id.toHexString();
  const keys = JSON.stringify(
    scanned.map((l) => [l.library_id.toHexString(), l.path, l.filename].join('\u001e')),
  );
  const result = await sqliteDb(dbOverride).write(
    `INSERT INTO backup_sidecar_name_checks (asset_id, checked)
     SELECT ?, 1 WHERE
       (SELECT COUNT(*) FROM asset_locations l WHERE l.asset_id = ? AND ${LIVE_LOCATION}) = ?
       AND (SELECT COUNT(*) FROM asset_locations l WHERE l.asset_id = ? AND ${LIVE_LOCATION}
              AND l.library_id || char(30) || l.path || char(30) || l.filename
                  IN (SELECT value FROM json_each(?))) = ?
     ON CONFLICT (asset_id) DO UPDATE SET checked = 1`,
    [hex, hex, scanned.length, hex, keys, scanned.length],
  );
  return result.changes > 0;
}
