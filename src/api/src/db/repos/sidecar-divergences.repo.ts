/**
 * `sidecar_divergences` — the sidecar versions a compare-and-swap backup
 * re-send displaced (#4719). A device names the version its edit was based on;
 * when the server's copy has moved on, the incoming edit still lands and the
 * copy it replaced is kept here rather than overwritten into oblivion.
 */

import type { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso } from './values.ts';

interface SidecarDivergence {
  assetId: ObjectId;
  libraryId: ObjectId;
  sidecarRelPath: string;
  deviceId: string;
  baseSha256: string | null;
  displacedSha256: string;
  displacedXmp: string;
  incomingSha256: string;
}

export async function recordSidecarDivergence(
  divergence: SidecarDivergence,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO sidecar_divergences
       (id, asset_id, library_id, sidecar_rel_path, device_id, base_sha256,
        displaced_sha256, displaced_xmp, incoming_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      divergence.assetId.toHexString(),
      divergence.libraryId.toHexString(),
      divergence.sidecarRelPath,
      divergence.deviceId,
      divergence.baseSha256,
      divergence.displacedSha256,
      divergence.displacedXmp,
      divergence.incomingSha256,
      nowIso(),
    ],
  );
}
