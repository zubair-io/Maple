/**
 * `backup_sidecar_name_checks` — which assets the canonical-backup-sidecars
 * migration (#5021) has checked for pre-#5021 `IMG.HEIC.xmp` sidecars.
 */
import type { ObjectId } from '../object-id.ts';
import { BACKUP_ORIGIN, LIVE_LOCATION } from './assets.migrations.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

/** A backed-up asset never checked, or any asset a merge made due again. */
export const NEEDS_CANONICAL_SIDECAR_CHECK = `(
  EXISTS (SELECT 1 FROM backup_sidecar_name_checks c WHERE c.asset_id = a.id AND c.checked = 0)
  OR (${BACKUP_ORIGIN}
      AND NOT EXISTS (SELECT 1 FROM backup_sidecar_name_checks c WHERE c.asset_id = a.id)))`;

/** Stamp only while the asset still has the live locations the scan covered:
 * a merge that added some meanwhile keeps it due. `false` when not stamped. */
export async function markCanonicalSidecarsChecked(
  id: ObjectId,
  scannedLiveLocations: number,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const hex = id.toHexString();
  const result = await sqliteDb(dbOverride).write(
    `INSERT INTO backup_sidecar_name_checks (asset_id, checked)
     SELECT ?, 1 WHERE (SELECT COUNT(*) FROM asset_locations l
                         WHERE l.asset_id = ? AND ${LIVE_LOCATION}) = ?
     ON CONFLICT (asset_id) DO UPDATE SET checked = 1`,
    [hex, hex, scannedLiveLocations],
  );
  return result.changes > 0;
}
