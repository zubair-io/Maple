/**
 * Paired-device sessions — the read and the revoke that the Settings → Devices
 * panel is made of (#3751).
 *
 * These live beside `auth.refresh.repo.ts` rather than inside it because they
 * are a different question asked of the same table. Rotation is about one
 * token; this is about a *family*, the rotation lineage one device has held
 * since it paired, presented as a single row a person can recognise and sign
 * out.
 *
 * What makes a family a device session is the `platform` marker (`'tvos'` and
 * friends), which only the device-pairing mint endpoint stamps. An ordinary
 * browser login never carries one, so ordinary logins never appear in this
 * panel and — more importantly — cannot be signed out through it. Logout and
 * `revokeChain` are the paths for those.
 *
 * The aggregation this replaces grouped by `family_id` and took `$first` of
 * the label and platform. Both are constant within a family, because every
 * rotation copies them from its parent, so selecting them bare beside the
 * grouping key says the same thing.
 */

import type { ObjectId } from 'mongodb';
import { revokeFamily } from './auth.refresh.repo.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toHex } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

export interface DeviceSession {
  id: string;
  label: string;
  platform: string;
  created_at: string;
  last_used_at: string;
}

/**
 * Live paired-device families for a user, most recently used first.
 *
 * "Live" means the family still holds a token that is neither revoked nor
 * expired — a family whose last token lapsed is gone from the panel rather
 * than shown as a dead entry.
 */
export async function listDeviceSessions(
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<DeviceSession[]> {
  return await sqliteDb(dbOverride).read<DeviceSession>(
    `SELECT family_id AS id,
            device_label AS label,
            platform,
            MIN(issued_at) AS created_at,
            MAX(issued_at) AS last_used_at
       FROM refresh_tokens
      WHERE user_id = ? AND platform IS NOT NULL AND family_revoked_at IS NULL
      GROUP BY family_id
     HAVING SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) > 0
      ORDER BY last_used_at DESC`,
    [toHex(userId), nowIso()],
  );
}

/**
 * Sign one paired device out, ownership-checked.
 *
 * `false` when the family is not this user's, or is not a device session at
 * all — the panel must not become a way to end somebody else's browser
 * session.
 */
export async function revokeDeviceSession(
  userId: ObjectId,
  familyId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<{ id: string }>(
    `SELECT id FROM refresh_tokens
      WHERE family_id = ? AND user_id = ? AND platform IS NOT NULL LIMIT 1`,
    [toHex(familyId), toHex(userId)],
  );
  if (rows.length === 0) return false;
  await revokeFamily(familyId, db);
  return true;
}
