/**
 * `apns_device_tokens` — the SQLite port of `apns/apns-devices.repo.ts`
 * (#3751).
 *
 * One row per (user, device) the device wants File Provider wake-ups for. Not
 * per library: a device holds exactly one push registration per server it has
 * mounted, so the fan-out list is "every row", and re-registering the same pair
 * updates the row rather than adding a second one.
 *
 * `normalizeDeviceToken` is not ported. It is a regular expression over a
 * string with no database in it, so it stays in the Mongo module and the routes
 * keep importing it from there after the cutover (#3752) — the same treatment
 * `quantizedKey` gets in the geocode cache.
 *
 * ## Timestamps
 *
 * `ApnsDeviceTokenDoc` declares `created_at` and `updated_at` as `Date`, and
 * `routes/apns-devices.ts` calls `.toISOString()` on one of them, so the DTO's
 * declared type has to survive. The columns are ISO TEXT — every timestamp in
 * this schema is — and {@link toDate} converts at the boundary.
 */

import type { ObjectId } from '../../object-id.ts';
import type { ApnsDeviceTokenWithId, ApnsEnvironment } from '../../schema.ts';
import { newObjectIdHex } from '../../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, placeholders, toDate, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { ApnsDeviceTokenWithId, ApnsEnvironment };

/**
 * Re-registering an existing pair keeps the row's identity and its
 * `created_at`; only the mutable half is overwritten. The id bound to the
 * insert branch is discarded on conflict, which is the cost of minting
 * identifiers client-side and is one wasted counter tick.
 */
const REGISTER_SQL = `
  INSERT INTO apns_device_tokens
    (id, user_id, device_token, platform, environment, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, device_token) DO UPDATE SET
    platform = excluded.platform,
    environment = excluded.environment,
    updated_at = excluded.updated_at`;

const SELECT_COLUMNS = `id, user_id, device_token, platform, environment, created_at, updated_at`;

interface DeviceRow {
  id: string;
  user_id: string;
  device_token: string;
  platform: 'ios' | 'macos';
  environment: ApnsEnvironment;
  created_at: string;
  updated_at: string;
}

function toDoc(row: DeviceRow): ApnsDeviceTokenWithId {
  return {
    _id: toObjectId(row.id),
    user_id: toObjectId(row.user_id),
    device_token: row.device_token,
    platform: row.platform,
    environment: row.environment,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  };
}

export interface RegisterDeviceInput {
  userId: ObjectId;
  deviceToken: string;
  platform: 'ios' | 'macos';
  environment: ApnsEnvironment;
}

/**
 * Upsert on the natural key (user, device) — an app relaunch or a token
 * refresh that reports the same value updates `updated_at` and any changed
 * platform/environment rather than duplicating.
 */
export async function registerDeviceToken(
  input: RegisterDeviceInput,
  dbOverride?: SqliteDb,
): Promise<void> {
  const now = nowIso();
  await sqliteDb(dbOverride).write(REGISTER_SQL, [
    newObjectIdHex(),
    input.userId.toHexString(),
    input.deviceToken,
    input.platform,
    input.environment,
    now,
    now,
  ]);
}

export interface UnregisterDeviceInput {
  userId: ObjectId;
  deviceToken: string;
}

/** Rows removed: 0 or 1, since the natural key is unique. */
export async function unregisterDeviceToken(
  input: UnregisterDeviceInput,
  dbOverride?: SqliteDb,
): Promise<number> {
  const result = await sqliteDb(dbOverride).write(
    `DELETE FROM apns_device_tokens WHERE user_id = ? AND device_token = ?`,
    [input.userId.toHexString(), input.deviceToken],
  );
  return result.changes;
}

/**
 * Remove device tokens by value alone, across every user — what the push
 * trigger does when APNs reports tokens as permanently invalid. No user
 * scoping: an unregistered token is dead regardless of who registered it.
 *
 * Takes an array so a burst that rejects many devices at once prunes in one
 * statement rather than one round trip per device, and skips the round trip
 * entirely for an empty list.
 */
export async function pruneDeviceTokens(
  deviceTokens: string[],
  dbOverride?: SqliteDb,
): Promise<number> {
  if (deviceTokens.length === 0) return 0;
  const result = await sqliteDb(dbOverride).write(
    `DELETE FROM apns_device_tokens WHERE device_token IN (${placeholders(deviceTokens.length)})`,
    deviceTokens,
  );
  return result.changes;
}

/** One user's registrations, most recently refreshed first. */
export async function listDeviceTokensForUser(
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<ApnsDeviceTokenWithId[]> {
  const rows = await sqliteDb(dbOverride).read<DeviceRow>(
    `SELECT ${SELECT_COLUMNS} FROM apns_device_tokens WHERE user_id = ? ORDER BY updated_at DESC`,
    [userId.toHexString()],
  );
  return rows.map(toDoc);
}

/**
 * Every device registered on this server — the push trigger's fan-out list for
 * one coalesced change burst, since a device's single registration covers every
 * library on the server.
 */
export async function listAllDeviceTokens(dbOverride?: SqliteDb): Promise<ApnsDeviceTokenWithId[]> {
  const rows = await sqliteDb(dbOverride).read<DeviceRow>(
    `SELECT ${SELECT_COLUMNS} FROM apns_device_tokens`,
  );
  return rows.map(toDoc);
}
