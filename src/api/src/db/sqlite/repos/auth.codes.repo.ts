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

import { randomBytes } from 'node:crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { nowIso, toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/** One-time code TTL — short by design; both flows redeem immediately. */
const CODE_TTL_MS = 60_000;

/**
 * PKCE S256 transform: `base64url(sha256(verifier))`. The native app sends
 * this challenge when it launches the web flow and keeps the verifier private,
 * proving possession at redeem.
 */
export function pkceS256(codeVerifier: string): string {
  return b64url(sha256(utf8(codeVerifier)));
}

function hashCode(rawCode: string): string {
  return Buffer.from(sha256(utf8(rawCode))).toString('hex');
}

function newCode(): string {
  return b64url(randomBytes(32));
}

function expiryIso(): string {
  return new Date(Date.now() + CODE_TTL_MS).toISOString();
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
  const code = newCode();
  await sqliteDb(dbOverride).write(
    `INSERT INTO native_auth_codes
       (id, code_hash, code_challenge, state, user_id, device_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      hashCode(code),
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

/** The identity a spent code proves, read back after the swap won. */
async function redeemedNative(db: SqliteDb, id: string): Promise<RedeemedNativeCode | null> {
  const rows = await db.read<NativeCodeRow>(
    `SELECT user_id, device_label, state FROM native_auth_codes WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { userId: toObjectId(row.user_id), deviceLabel: row.device_label, state: row.state };
}

/**
 * Consume the code iff it is unspent, unexpired, and the supplied verifier
 * hashes to the stored challenge.
 *
 * The challenge match is part of the `WHERE`, so a wrong verifier changes
 * nothing — it neither succeeds nor burns the code for the real app. `null`
 * means nothing matched, and deliberately does not say which condition failed.
 */
export async function redeemNativeCode(
  rawCode: string,
  codeVerifier: string,
  dbOverride?: SqliteDb,
): Promise<RedeemedNativeCode | null> {
  const db = sqliteDb(dbOverride);
  const codeHash = hashCode(rawCode);
  // `code_hash` is UNIQUE, so this predicate names at most one row and the
  // swap needs no separate id lookup.
  const result = await db.write(
    `UPDATE native_auth_codes SET consumed_at = ?
      WHERE code_hash = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?`,
    [nowIso(), codeHash, pkceS256(codeVerifier), nowIso()],
  );
  if (result.changes !== 1) return null;
  const rows = await db.read<NativeCodeRow>(
    `SELECT user_id, device_label, state FROM native_auth_codes WHERE code_hash = ?`,
    [codeHash],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { userId: toObjectId(row.user_id), deviceLabel: row.device_label, state: row.state };
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
  return await redeemedNative(db, id);
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
  const code = newCode();
  await sqliteDb(dbOverride).write(
    `INSERT INTO lan_handoff_codes
       (id, code_hash, user_id, device_label, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newObjectIdHex(), hashCode(code), toHex(args.userId), args.deviceLabel, nowIso(), expiryIso()],
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
  const db = sqliteDb(dbOverride);
  const codeHash = hashCode(rawCode);
  const result = await db.write(
    `UPDATE lan_handoff_codes SET consumed_at = ?
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    [nowIso(), codeHash, nowIso()],
  );
  if (result.changes !== 1) return null;
  const rows = await db.read<{ user_id: string; device_label: string }>(
    `SELECT user_id, device_label FROM lan_handoff_codes WHERE code_hash = ?`,
    [codeHash],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { userId: toObjectId(row.user_id), deviceLabel: row.device_label };
}
