/**
 * `invites` — the SQLite port of `auth/invites.ts` (#3751).
 *
 * Same four functions, same signatures, same thrown errors. An invite is a
 * short base32 code an owner hands to someone so their WebAuthn registration
 * is allowed to create an account on a server that is already claimed.
 *
 * `expires_at` stays a `Date` on the way out because `InviteDoc` declares one —
 * on Mongo it had to be a `Date` for the TTL monitor to see it at all. The
 * column is ISO text, swept by {@link sweepExpiredAuthRows} instead.
 *
 * Redeeming is deliberately still read-then-write rather than a single
 * compare-and-swap. The four rejection reasons — unknown code, wrong email,
 * already consumed, expired — are distinct 410s the caller reports separately,
 * and a swap can only say "nothing matched". Two people racing the same code
 * could in principle both pass the check, which is exactly as true on Mongo;
 * the invite names one email address, so the race is between two attempts by
 * the same person.
 */

import type { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import {
  assertInviteRedeemable,
  generateInviteCode,
  INVITE_TTL_MS,
} from '../../../auth/invite-code.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toDate, toHex, toObjectId } from './values.ts';
import type { InviteDoc } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';

// The alphabet and the lifetime are shared with the Mongo store rather than
// redeclared — see `auth/invite-code.ts` for why one definition matters.

interface InviteRow {
  code: string;
  email: string;
  invited_by: string;
  expires_at: string;
  consumed_at: string | null;
}

/** Mint an invite for one email address. */
export async function createInvite(
  invitedBy: ObjectId,
  email: string,
  dbOverride?: SqliteDb,
): Promise<InviteDoc & { code: string; expires_at: Date }> {
  const code = generateInviteCode();
  const doc: InviteDoc = {
    code,
    email: email.toLowerCase(),
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + INVITE_TTL_MS),
    consumed_at: null,
  };
  await sqliteDb(dbOverride).write(
    `INSERT INTO invites (id, code, email, invited_by, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newObjectIdHex(), doc.code, doc.email, toHex(invitedBy), doc.expires_at.toISOString(), null],
  );
  return doc;
}

/**
 * Spend an invite, or throw a 410 naming the reason.
 *
 * The checks run in the order the Mongo version ran them, because the message
 * a caller sees is part of the behaviour: "invite/email mismatch" and "invite
 * expired" are different things to tell someone who cannot register.
 */
export async function redeemInvite(
  code: string,
  email: string,
  dbOverride?: SqliteDb,
): Promise<{ ok: true; invitedBy: ObjectId }> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<InviteRow>(
    `SELECT code, email, invited_by, expires_at, consumed_at FROM invites WHERE code = ?`,
    [code],
  );
  const row = rows[0];
  assertInviteRedeemable(
    row === undefined ? null : { ...row, expires_at: toDate(row.expires_at) },
    email,
  );

  await db.write(`UPDATE invites SET consumed_at = ? WHERE code = ?`, [nowIso(), code]);
  // The assertion above threw unless the row exists, which TypeScript cannot
  // see through a function that returns void.
  return { ok: true, invitedBy: toObjectId(row!.invited_by) };
}

/**
 * Every invite, for the owner's pending-invites list.
 *
 * Ordered by id, which is the order they were created in — an ObjectId's
 * leading bytes are its timestamp — and therefore the same order Mongo's
 * unsorted `find` returned them in, only stated rather than incidental.
 */
export async function listInvites(
  dbOverride?: SqliteDb,
): Promise<Pick<InviteDoc, 'code' | 'email' | 'expires_at' | 'consumed_at'>[]> {
  const rows = await sqliteDb(dbOverride).read<InviteRow>(
    `SELECT code, email, expires_at, consumed_at FROM invites ORDER BY id ASC`,
  );
  return rows.map((row) => ({
    code: row.code,
    email: row.email,
    expires_at: toDate(row.expires_at),
    consumed_at: row.consumed_at,
  }));
}

/** Withdraw an unspent invite. */
export async function rescindInvite(code: string, dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM invites WHERE code = ?`, [code]);
}
