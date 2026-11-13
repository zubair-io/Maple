/**
 * `sidecar_divergences` — edits a backup sidecar write could not place on the
 * sidecar itself, kept rather than lost (#4719): an edit a same-stem shared
 * sidecar refused (#4692) and a pre-#5021 old-name sidecar the canonical one
 * replaced (#5021). A stale re-send no longer lands here: the route reconciles
 * it onto the sidecar's edit history (#5796), so rows written before that stay
 * as they are.
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
): Promise<string> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO sidecar_divergences
       (id, asset_id, library_id, sidecar_rel_path, device_id, base_sha256,
        displaced_sha256, displaced_xmp, incoming_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
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
  return id;
}

export async function hasSidecarDivergence(
  query: {
    assetId: ObjectId;
    libraryId: ObjectId;
    sidecarRelPath: string;
    displacedSha256: string;
    incomingSha256?: string;
  },
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ found: number }>(
    `SELECT 1 AS found FROM sidecar_divergences
      WHERE asset_id = ? AND library_id = ? AND sidecar_rel_path = ? AND displaced_sha256 = ?
        AND (? IS NULL OR incoming_sha256 = ?) LIMIT 1`,
    [
      query.assetId.toHexString(),
      query.libraryId.toHexString(),
      query.sidecarRelPath,
      query.displacedSha256,
      query.incomingSha256 ?? null,
      query.incomingSha256 ?? null,
    ],
  );
  return rows.length > 0;
}
