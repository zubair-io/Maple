/**
 * `users` and `credentials` — the SQLite port of the account half of
 * authentication (#3751).
 *
 * ## Why this file has a surface the Mongo side does not
 *
 * The other ported repositories mirror a module one-for-one, because their
 * collection already had one. These two do not: every read and write to
 * `users` and `credentials` is spelled inline in a route handler
 * (`routes/auth.ts`, `routes/auth-account.ts`, `routes/users.ts`,
 * `auth/webauthn.ts`, `auth/server_claim.ts`). So the functions here are named
 * after the operations those handlers perform, one function per distinct
 * query, and the cutover (#3752) replaces each inline `collection(...)` call
 * with the matching call here. Nothing new is invented — if a function below
 * has no caller in the current code, it should not be here.
 *
 * ## The three reads over `credentials` are deliberately not one read
 *
 * A passkey row carries a COSE public key, and only one of the four call sites
 * needs it. `/api/auth/me` lists device labels, `credentials/options` builds an
 * exclude list of ids, and `buildAuthenticationOptions` needs ids and
 * transports; none of them has any use for the key bytes. Returning whole rows
 * to all three would ship the keys of every passkey a user owns on every
 * account-page load, which is the same unprojected-read defect #3746 fixed on
 * the asset list. Only {@link findCredentialByCredentialId}, the verification
 * path, reads the key.
 *
 * ## Absent is not false
 *
 * `UserDoc.file_access` is optional and an absent value reads as **true** —
 * owners always have file access and members did before #2893 added the
 * switch. The column is therefore nullable, and a NULL comes back as an
 * omitted key rather than `false`, because `auth/permissions.ts` distinguishes
 * the two.
 */

import type { ObjectId, WithId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import {
  deleteOutcome,
  sqliteDb,
  updateOutcome,
  type DeleteOutcome,
  type SqliteDb,
  type UpdateOutcome,
} from './db-handle.ts';
import { fromBool, nowIso, parseJson, toHex, toObjectId } from './values.ts';
import type { CredentialDoc, UserDoc, UserRole } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  file_access: number | null;
  created_at: string;
  last_seen_at: string | null;
}

const USER_COLUMNS = `id, email, role, file_access, created_at, last_seen_at`;

function toUser(row: UserRow): WithId<UserDoc> {
  return {
    _id: toObjectId(row.id),
    email: row.email,
    role: row.role,
    // NULL means "never set", which permissions.ts reads as true. Emitting
    // `false` here would silently revoke file access for every legacy account.
    ...(row.file_access === null ? {} : { file_access: row.file_access === 1 }),
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

/** One user by id, or `null`. */
export async function findUserById(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<WithId<UserDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    [toHex(id)],
  );
  return rows[0] === undefined ? null : toUser(rows[0]);
}

/**
 * One user by email address, matched exactly.
 *
 * The uniqueness constraint is case-insensitive — two accounts cannot differ
 * only in case — but the lookup is not, which is what `findOne({ email })` did
 * on Mongo: an index's collation does not change a query's comparison unless
 * the query asks for it. Callers lowercase the address before they get here.
 */
export async function findUserByEmail(
  email: string,
  dbOverride?: SqliteDb,
): Promise<WithId<UserDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`,
    [email],
  );
  return rows[0] === undefined ? null : toUser(rows[0]);
}

/** Every user, oldest first — the order `GET /api/users` renders. */
export async function listUsers(dbOverride?: SqliteDb): Promise<WithId<UserDoc>[]> {
  const rows = await sqliteDb(dbOverride).read<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`,
  );
  return rows.map(toUser);
}

/**
 * Whether any account exists at all.
 *
 * Backs the bootstrap route's `claimed` flag and the ownership-claim backfill.
 * `EXISTS` rather than a count because both callers only ever compare against
 * zero, and the Mongo version already capped itself with `{ limit: 1 }`.
 */
export async function anyUserExists(dbOverride?: SqliteDb): Promise<boolean> {
  const rows = await sqliteDb(dbOverride).read<{ present: number }>(
    `SELECT EXISTS (SELECT 1 FROM users) AS present`,
  );
  return rows[0]?.present === 1;
}

/**
 * How many owners there are besides this one.
 *
 * The last-owner guard: demoting the only owner locks every admin surface, so
 * `PATCH /api/users/:id` counts fresh at request time rather than trusting
 * whatever the UI last saw.
 */
export async function countOtherOwners(
  excluding: ObjectId,
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND id != ?`,
    [toHex(excluding)],
  );
  return rows[0]?.n ?? 0;
}

/** Insert one account and return the id it was given. */
export async function insertUser(doc: UserDoc, dbOverride?: SqliteDb): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO users (id, email, role, file_access, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      doc.email,
      doc.role,
      doc.file_access === undefined ? null : fromBool(doc.file_access),
      doc.created_at,
      doc.last_seen_at,
    ],
  );
  return toObjectId(id);
}

/** Stamp the sign-in time. */
export async function touchUserLastSeen(
  id: ObjectId,
  seenAt: string = nowIso(),
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(`UPDATE users SET last_seen_at = ? WHERE id = ?`, [
    seenAt,
    toHex(id),
  ]);
}

/**
 * Apply an owner's edit to a member's role and/or file-access permission.
 *
 * Only the fields present in `patch` are written, so a role change does not
 * reset a permission the caller never mentioned.
 */
export async function updateUser(
  id: ObjectId,
  patch: { role?: UserRole; file_access?: boolean },
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const fields = [
    ...(patch.role === undefined
      ? []
      : [{ sql: 'role = ?', value: patch.role as string | number }]),
    ...(patch.file_access === undefined
      ? []
      : [{ sql: 'file_access = ?', value: fromBool(patch.file_access) }]),
  ];
  if (fields.length === 0) return updateOutcome(0);
  const result = await sqliteDb(dbOverride).write(
    `UPDATE users SET ${fields.map((f) => f.sql).join(', ')} WHERE id = ?`,
    [...fields.map((f) => f.value), toHex(id)],
  );
  return updateOutcome(result.changes);
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}

/** One passkey a user owns, as `/api/auth/me` renders it. */
export interface CredentialSummary {
  _id: ObjectId;
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}

/** The fields WebAuthn needs to name a credential in a ceremony's options. */
export interface CredentialDescriptor {
  credential_id: string;
  transports: string[];
}

function toCredential(row: CredentialRow): WithId<CredentialDoc> {
  return {
    _id: toObjectId(row.id),
    user_id: toObjectId(row.user_id),
    credential_id: row.credential_id,
    // The DTO promises a Node Buffer; SQLite hands back a Uint8Array view.
    // `Buffer.from` on a view copies exactly those bytes, so the key cannot
    // pick up a neighbouring row's tail the way `.buffer` would.
    public_key: Buffer.from(row.public_key),
    counter: row.counter,
    transports: parseJson<string[]>(row.transports, []),
    device_label: row.device_label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

/**
 * The credential an assertion names, with its public key — the one read that
 * needs the key bytes, because verifying the signature is what it is for.
 */
export async function findCredentialByCredentialId(
  credentialId: string,
  dbOverride?: SqliteDb,
): Promise<WithId<CredentialDoc> | null> {
  const rows = await sqliteDb(dbOverride).read<CredentialRow>(
    `SELECT id, user_id, credential_id, public_key, counter, transports, device_label,
            created_at, last_used_at
       FROM credentials WHERE credential_id = ?`,
    [credentialId],
  );
  return rows[0] === undefined ? null : toCredential(rows[0]);
}

/** A user's passkeys as the account page lists them. No key bytes. */
export async function listCredentialSummariesForUser(
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<CredentialSummary[]> {
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    device_label: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    `SELECT id, device_label, created_at, last_used_at
       FROM credentials WHERE user_id = ? ORDER BY created_at ASC`,
    [toHex(userId)],
  );
  return rows.map((row) => ({
    _id: toObjectId(row.id),
    device_label: row.device_label,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  }));
}

/**
 * A user's passkeys as a WebAuthn ceremony names them — the `allowCredentials`
 * list when signing in, and the `excludeCredentials` list when adding another.
 */
export async function listCredentialDescriptorsForUser(
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<CredentialDescriptor[]> {
  const rows = await sqliteDb(dbOverride).read<{
    credential_id: string;
    transports: string | null;
  }>(
    `SELECT credential_id, transports FROM credentials WHERE user_id = ? ORDER BY created_at ASC`,
    [toHex(userId)],
  );
  return rows.map((row) => ({
    credential_id: row.credential_id,
    transports: parseJson<string[]>(row.transports, []),
  }));
}

/** How many passkeys a user has. The "cannot remove the last one" guard. */
export async function countCredentialsForUser(
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`,
    [toHex(userId)],
  );
  return rows[0]?.n ?? 0;
}

/** Register one passkey and return the id it was given. */
export async function insertCredential(
  doc: CredentialDoc,
  dbOverride?: SqliteDb,
): Promise<ObjectId> {
  const id = newObjectIdHex();
  await sqliteDb(dbOverride).write(
    `INSERT INTO credentials
       (id, user_id, credential_id, public_key, counter, transports, device_label,
        created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      toHex(doc.user_id),
      doc.credential_id,
      new Uint8Array(doc.public_key),
      doc.counter,
      JSON.stringify(doc.transports),
      doc.device_label,
      doc.created_at,
      doc.last_used_at,
    ],
  );
  return toObjectId(id);
}

/**
 * Record a successful assertion: the authenticator's new signature counter and
 * the time it was used.
 */
export async function touchCredential(
  id: ObjectId,
  counter: number,
  usedAt: string = nowIso(),
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const result = await sqliteDb(dbOverride).write(
    `UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?`,
    [counter, usedAt, toHex(id)],
  );
  return updateOutcome(result.changes);
}

/**
 * Remove one passkey, scoped to its owner so a stolen id cannot delete someone
 * else's. The caller checks the "not the last one" rule first.
 */
export async function deleteCredential(
  id: ObjectId,
  userId: ObjectId,
  dbOverride?: SqliteDb,
): Promise<DeleteOutcome> {
  const result = await sqliteDb(dbOverride).write(
    `DELETE FROM credentials WHERE id = ? AND user_id = ?`,
    [toHex(id), toHex(userId)],
  );
  return deleteOutcome(result.changes);
}
