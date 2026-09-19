/**
 * `native_auth_codes` and `lan_handoff_codes` — the SQLite port of
 * `auth/native_code_store.ts` and `auth/lan_handoff_store.ts` (#3751).
 *
 * Both tables hold the same kind of thing: a single-use, one-minute code that
 * moves an already-authenticated session from one place to another without
 * repeating the passkey ceremony. The native one carries a PKCE challenge
 * because the code travels through a redirect the app does not control; the
 * LAN one does not, because both ends are the same browser tab and a verifier
 * would ride in the same URL as the code.
 *
 * Neither table ever stores a code. It stores `sha256(code)`, so a database
 * read cannot mint a session.
 *
 * ## Redeeming is still a single-use compare-and-swap
 *
 * The property that matters is that a code can be spent exactly once, and that
 * a wrong PKCE verifier neither succeeds nor burns the code. On Mongo that was
 * one `findOneAndUpdate` whose filter carried every condition. Here it is one
 * `UPDATE` whose `WHERE` carries the same conditions, and `changes === 1` is
 * the proof that this caller is the one that spent it — a second attempt finds
 * `consumed_at` already set and changes nothing.
 *
 * The identifying columns are then read back afterwards, which is safe because
 * they are immutable: `user_id`, `device_label` and `state` are written once at
 * issue and never updated. The only mutable column is the one the swap just
 * claimed.
 */

import type { ObjectId } from '../../object-id.ts';
import { newObjectIdHex } from '../../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toHex, toObjectId } from './values.ts';
import {
  hashHandoffCode,
  HANDOFF_CODE_TTL_MS,
  newHandoffCode,
  pkceS256,
} from '../../../auth/handoff-code.ts';

export type { SqliteDb } from './db-handle.ts';

// The hashing, the generator and the PKCE transform are shared with the Mongo
// stores rather than reimplemented: a code hashed one way at issue and another
// at redeem simply stops working, and one definition cannot drift from itself.
export { pkceS256 };

function expiryIso(): string {
  return new Date(Date.now() + HANDOFF_CODE_TTL_MS).toISOString();
}

/**
 * Spend a code by its hash and read back what it proves, or `null` when
 * nothing matched.
 *
 * Both tables redeem the same way — a compare-and-swap that sets `consumed_at`
 * under the whole filter, then a read of the columns the caller needs — and
 * differ only in the table, those columns, and whether there is an extra
 * condition (the native code adds its PKCE challenge; the LAN code has none).
 *
 * `changes === 1` is what says this caller spent it, exactly as a returned
 * document did under `findOneAndUpdate`. The read afterwards is safe because
 * every column it names is written once at issue and never updated; the only
 * mutable column is the one the swap just claimed.
 *
 * `table` and `columns` are literals from this module, never caller input.
 */
async function spendCodeByHash<T>(
  db: SqliteDb,
  table: 'native_auth_codes' | 'lan_handoff_codes',
  columns: string,
  codeHash: string,
  extra: { sql: string; params: readonly string[] } = { sql: '', params: [] },
): Promise<T | null> {
  const now = nowIso();
  const result = await db.write(
    `UPDATE ${table} SET consumed_at = ?
      WHERE code_hash = ?${extra.sql} AND consumed_at IS NULL AND expires_at > ?`,
    [now, codeHash, ...extra.params, now],
  );
  if (result.changes !== 1) return null;
  const rows = await db.read<T>(`SELECT ${columns} FROM ${table} WHERE code_hash = ?`, [codeHash]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// native_auth_codes — the Apple shell's PKCE code exchange (#856)
// ---------------------------------------------------------------------------

export interface IssuedNativeCode {
  code: string;
}

export interface RedeemedNativeCode {
  userId: ObjectId;
  deviceLabel: string;
  state: string;
}

interface NativeCodeRow {
  user_id: string;
  device_label: string;
  state: string;
}

/**
 * Issue a single-use code bound to the user, the PKCE challenge and an opaque
 * `state`. The raw code is returned once; only its hash is persisted.
 */
export async function issueNativeCode(
  args: {
    userId: ObjectId;
    codeChallenge: string;
    state: string;
    deviceLabel: string;
  },
  dbOverride?: SqliteDb,
): Promise<IssuedNativeCode> {
  const code = newHandoffCode();
  await sqliteDb(dbOverride).write(
    `INSERT INTO native_auth_codes
       (id, code_hash, code_challenge, state, user_id, device_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      hashHandoffCode(code),
      args.codeChallenge,
      args.state,
      toHex(args.userId),
      args.deviceLabel,
      nowIso(),
      expiryIso(),
    ],
  );
  return { code };
}

const NATIVE_IDENTITY_COLUMNS = 'user_id, device_label, state';

/** A spent native code's row as the caller's result. */
function toRedeemedNative(row: NativeCodeRow): RedeemedNativeCode {
  return { userId: toObjectId(row.user_id), deviceLabel: row.device_label, state: row.state };
}

/**
 * Consume the code iff it is unspent, unexpired, and the supplied verifier
 * hashes to the stored challenge.
 *
 * The challenge match is part of the `WHERE`, so a wrong verifier changes
 * nothing — it neither succeeds nor burns the code for the real app. `null`
 * means nothing matched, and deliberately does not say which condition failed.
 *
 * `code_hash` is UNIQUE, so the predicate names at most one row and the swap
 * needs no separate id lookup.
 */
export async function redeemNativeCode(
  rawCode: string,
  codeVerifier: string,
  dbOverride?: SqliteDb,
): Promise<RedeemedNativeCode | null> {
  const row = await spendCodeByHash<NativeCodeRow>(
    sqliteDb(dbOverride),
    'native_auth_codes',
    NATIVE_IDENTITY_COLUMNS,
    hashHandoffCode(rawCode),
    { sql: ' AND code_challenge = ?', params: [pkceS256(codeVerifier)] },
  );
  return row === null ? null : toRedeemedNative(row);
}

/**
 * Consume a pending code by `state` and PKCE verifier, without the raw code
 * (#3063).
 *
 * The polling completion channel. Chromium refuses to launch `maple-app://`
 * from a script navigation with no user gesture, so a browser that was already
 * signed in mints a code it can never deliver through the redirect. The raw
 * code only ever existed to bind that redirect hop; a caller holding the
 * private verifier and the ceremony's `state` is the same principal, so the
 * same single-use, unexpired, challenge-must-match swap applies. `null` while
 * nothing is pending — the app keeps polling.
 *
 * Unlike {@link redeemNativeCode}, `state` is not a unique column, so the row
 * is pinned by id first and the swap is scoped to it. Without that, a reused
 * `state` would let one call consume several codes, where `findOneAndUpdate`
 * consumed exactly one.
 */
export async function claimNativeCode(
  state: string,
  codeVerifier: string,
  dbOverride?: SqliteDb,
): Promise<RedeemedNativeCode | null> {
  const db = sqliteDb(dbOverride);
  const challenge = pkceS256(codeVerifier);
  const candidates = await db.read<{ id: string }>(
    `SELECT id FROM native_auth_codes
      WHERE state = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at, id LIMIT 1`,
    [state, challenge, nowIso()],
  );
  const id = candidates[0]?.id;
  if (id === undefined) return null;
  const result = await db.write(
    `UPDATE native_auth_codes SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`,
    [nowIso(), id, nowIso()],
  );
  if (result.changes !== 1) return null;
  const rows = await db.read<NativeCodeRow>(
    `SELECT ${NATIVE_IDENTITY_COLUMNS} FROM native_auth_codes WHERE id = ?`,
    [id],
  );
  return rows[0] === undefined ? null : toRedeemedNative(rows[0]);
}

// ---------------------------------------------------------------------------
// lan_handoff_codes — same browser, public URL → LAN address
// ---------------------------------------------------------------------------

export interface IssuedLanHandoffCode {
  code: string;
}

export interface RedeemedLanHandoffCode {
  userId: ObjectId;
  deviceLabel: string;
}

/** Issue a single-use, short-TTL code bound to the user. */
export async function issueLanHandoffCode(
  args: { userId: ObjectId; deviceLabel: string },
  dbOverride?: SqliteDb,
): Promise<IssuedLanHandoffCode> {
  const code = newHandoffCode();
  await sqliteDb(dbOverride).write(
    `INSERT INTO lan_handoff_codes
       (id, code_hash, user_id, device_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      hashHandoffCode(code),
      toHex(args.userId),
      args.deviceLabel,
      nowIso(),
      expiryIso(),
    ],
  );
  return { code };
}

/**
 * Consume the code iff it is unspent and unexpired. `null` when nothing
 * matched — an unknown, expired or already-spent code are one answer on
 * purpose.
 */
export async function redeemLanHandoffCode(
  rawCode: string,
  dbOverride?: SqliteDb,
): Promise<RedeemedLanHandoffCode | null> {
  const row = await spendCodeByHash<{ user_id: string; device_label: string }>(
    sqliteDb(dbOverride),
    'lan_handoff_codes',
    'user_id, device_label',
    hashHandoffCode(rawCode),
  );
  return row === null ? null : { userId: toObjectId(row.user_id), deviceLabel: row.device_label };
}
