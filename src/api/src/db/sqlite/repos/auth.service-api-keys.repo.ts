/**
 * `service_api_keys` — the SQLite port of the storage half of
 * `auth/service-api-keys.ts` (#3751).
 *
 * The module this replaces mixes two things: a key format (a `maple_sk` prefix,
 * a public key id, a base64url secret, a SHA-256 hash, a constant-time
 * comparison) and four collection operations. Only the second half is storage,
 * and only the second half moves — the cutover swaps those four calls and
 * leaves the format, the hashing and the timing-safe compare exactly where
 * they are. Duplicating that crypto into a database module would be the wrong
 * kind of thoroughness: two copies of a constant-time comparison is one copy
 * too many.
 *
 * {@link revokeServiceApiKey} keeps its name and signature from the Mongo
 * module because it is storage all the way down, id guard included.
 *
 * `expires_at` is declared `Date | null` by `ServiceApiKeyDoc` and stays that
 * way. It was a `Date` on Mongo so the TTL monitor would see it; here the
 * column is ISO text and expiry is enforced at read time by the caller — which
 * it already was, because the TTL monitor only runs once a minute and an
 * expired document stayed readable until it fired.
 */

import type { ObjectId, WithId } from '../../object-id.ts';
import { newObjectIdHex } from '../../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, parseJson, toDateOrNull, toHex, toObjectId } from './values.ts';
import type { ServiceApiKeyDoc, ServiceApiScope } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';

interface ServiceApiKeyRow {
  id: string;
  key_id: string;
  name: string;
  secret_hash: string;
  scopes: string;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

const COLUMNS = `id, key_id, name, secret_hash, scopes, created_at, created_by,
                 expires_at, revoked_at, last_used_at`;

function toKey(row: ServiceApiKeyRow): WithId<ServiceApiKeyDoc> {
  return {
    _id: toObjectId(row.id),
    key_id: row.key_id,
    name: row.name,
    secret_hash: row.secret_hash,
    scopes: parseJson<ServiceApiScope[]>(row.scopes, []),
    created_at: row.created_at,
    created_by: toObjectId(row.created_by),
    expires_at: toDateOrNull(row.expires_at),
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  };
}

/** Store a freshly minted key and return the id it was given. */
export async function insertServiceApiKey(
  doc: ServiceApiKeyDoc,
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO service_api_keys
       (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      doc.key_id,
      doc.name,
      doc.secret_hash,
      JSON.stringify(doc.scopes),
      doc.created_at,
      toHex(doc.created_by),
      doc.expires_at === null ? null : doc.expires_at.toISOString(),
      doc.revoked_at,
      doc.last_used_at,
    ],
  );
  return toObjectId(id);
}

/**
 * The key a bearer token names, by its public key id.
 *
 * Returns the row whether or not it is revoked or expired: the caller compares
 * the secret hash first and only then reports which of the three reasons
 * applies, so that an unknown key and a revoked one take the same path through
 * the timing-safe comparison.
 */
export async function findServiceApiKeyByKeyId(
  keyId: string,
  dbOverride?: SqliteDb,
): Promise<WithId<ServiceApiKeyDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<ServiceApiKeyRow>(
    `SELECT ${COLUMNS} FROM service_api_keys WHERE key_id = ?`,
    [keyId],
  );
  return rows[0] === undefined ? null : toKey(rows[0]);
}

/** Every key, newest first — the order the settings page lists them. */
export async function listServiceApiKeyRows(
  dbOverride?: SqliteDb,
): Promise<WithId<ServiceApiKeyDoc>[]> {
  const rows = await sqliteDb(dbOverride).read<ServiceApiKeyRow>(
    `SELECT ${COLUMNS} FROM service_api_keys ORDER BY created_at DESC`,
  );
  return rows.map(toKey);
}

/**
 * Stamp the last-used time on a live key.
 *
 * The `revoked_at IS NULL` guard is the Mongo filter's, and it is what stops a
 * request that was authorised a moment before a revocation from re-marking the
 * revoked key as active. The caller fires this without awaiting it.
 */
export async function markServiceApiKeyUsed(
  id: ObjectId,
  usedAt: string = nowIso(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `UPDATE service_api_keys SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL`,
    [usedAt, toHex(id)],
  );
}

/**
 * Revoke a key by its public id. `false` when the id is malformed or names
 * nothing live, which is what the route turns into a 404.
 */
export async function revokeServiceApiKey(keyId: string, dbOverride?: SqliteDb): Promise<boolean> {
  if (!/^[a-f0-9]{16}$/.test(keyId)) return false;
  const result = await sqliteDb(dbOverride).write(
    `UPDATE service_api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`,
    [nowIso(), keyId],
  );
  return result.changes > 0;
}
