/**
 * `invites` — the SQLite port of `auth/invites.ts` (#3751).
 *
 * An invite is a short base32 code an owner shares with someone so their
 * WebAuthn registration can create a member account on a claimed server.
 *
 * Expiry is checked before and during the atomic update that spends a code.
 * The timestamp is stored as ISO text and returned as a Date.
 *
 * Codes are single-use, expire after fifteen minutes, and accept no email identity.
 */

import type { ObjectId } from '../object-id.ts';
import { newObjectIdHex } from '../object-id.ts';
import {
  assertInviteRedeemable,
  generateInviteCode,
  INVITE_TTL_MS,
} from '../../auth/invite-code.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toDate, toHex, toObjectId } from './values.ts';
import type { InviteDoc } from '../schema.ts';

export type { SqliteDb } from './db-handle.ts';

interface InviteRow {
  code: string;
  invited_by: string;
  expires_at: string;
  consumed_at: string | null;
}

/** Mint an invite code that can be shared directly, without an email address. */
export async function createInvite(
  invitedBy: ObjectId,
  dbOverride?: SqliteDb,
): Promise<InviteDoc & { code: string; expires_at: Date }> {
  const code = generateInviteCode();
  const doc: InviteDoc = {
    code,
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + INVITE_TTL_MS),
    consumed_at: null,
  };
  await sqliteDb(dbOverride).write(
    `INSERT INTO invites (id, code, invited_by, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newObjectIdHex(), doc.code, toHex(invitedBy), doc.expires_at.toISOString(), null],
  );
  return doc;
}

/**
 * Spend an invite, or throw a 410 naming the reason.
 *
 * The guarded update elects exactly one winner when registrations race and
 * refuses a code revoked or expired after the initial read.
 */
export async function redeemInvite(
  code: string,
  dbOverride?: SqliteDb,
): Promise<{ ok: true; invitedBy: ObjectId }> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<InviteRow>(
    `SELECT code, invited_by, expires_at, consumed_at FROM invites WHERE code = ?`,
    [code],
  );
  const row = rows[0];
  // Named rather than passed inline so the assertion's narrowing lands on
  // something the rest of the function can use.
  const invite = row === undefined ? null : { ...row, expires_at: toDate(row.expires_at) };
  assertInviteRedeemable(invite);

  const now = nowIso();
  const spent = await db.write(
    `UPDATE invites SET consumed_at = ?
     WHERE code = ? AND consumed_at IS NULL AND expires_at >= ?`,
    [now, code, now],
  );
  if (spent.changes !== 1) {
    throw Object.assign(new Error('invite no longer redeemable'), { status: 410 });
  }
  return { ok: true, invitedBy: toObjectId(invite.invited_by) };
}

/**
 * One invite by its code, without spending it.
 *
 * `POST /api/auth/register/options` needs this: it has to know whether the code
 * a stranger typed is usable *before* the WebAuthn ceremony starts, but it must
 * not consume it — the registration is only allowed to spend the invite once
 * the authenticator has actually produced a credential, on `/register/verify`.
 * It also reports a narrower set of reasons than {@link redeemInvite} does (one
 * "invite invalid" covering unknown/consumed/expired), so it checks the row rather than
 * borrowing the assertion.
 */
export async function findInviteByCode(
  code: string,
  dbOverride?: SqliteDb,
): Promise<Pick<InviteDoc, 'code' | 'expires_at' | 'consumed_at'> | null> {
  const rows = await sqliteDb(dbOverride).read<InviteRow>(
    `SELECT code, expires_at, consumed_at FROM invites WHERE code = ?`,
    [code],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    code: row.code,
    expires_at: toDate(row.expires_at),
    consumed_at: row.consumed_at,
  };
}

/**
 * Every invite, for the owner's pending-invites list.
 *
 * Ordered by id, which is the order they were created in — an ObjectId's
 * leading bytes are its timestamp.
 */
export async function listInvites(
  dbOverride?: SqliteDb,
): Promise<Pick<InviteDoc, 'code' | 'expires_at' | 'consumed_at'>[]> {
  const rows = await sqliteDb(dbOverride).read<InviteRow>(
    `SELECT code, expires_at, consumed_at FROM invites ORDER BY id ASC`,
  );
  return rows.map((row) => ({
    code: row.code,
    expires_at: toDate(row.expires_at),
    consumed_at: row.consumed_at,
  }));
}

/** Withdraw an unspent invite. */
export async function rescindInvite(code: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM invites WHERE code = ?`, [code]);
}
