/**
 * `challenges` — the SQLite port of the storage half of `auth/webauthn.ts`
 * (#3751).
 *
 * A WebAuthn ceremony hands the browser a random challenge and expects it back
 * inside a signed assertion. The row exists so the server can prove the
 * challenge it is verifying is one it issued, within the last five minutes,
 * exactly once.
 *
 * Everything else in `auth/webauthn.ts` — building the registration and
 * authentication options, verifying an attestation, reading a COSE key — is
 * `@simplewebauthn/server` and has no database in it. The cutover replaces that
 * module's two collection calls with these two functions and leaves the
 * ceremony code alone.
 *
 * ## Single use, without `findOneAndDelete`
 *
 * The Mongo version consumed a challenge with `findOneAndDelete`, which both
 * returns the row and guarantees nobody else gets it. The pool cannot return
 * rows from a write, so this reads the row and then deletes it, and treats a
 * delete that changed nothing as "already consumed" — which it is, because the
 * only thing that removes a row is another consumer. Two concurrent verifies of
 * one challenge still leave exactly one winner, and the loser gets the same
 * error it got before.
 *
 * Expiry is checked after the delete, deliberately: an expired challenge is
 * spent as well as rejected, so a stale ceremony cannot be retried.
 */

import type { ObjectId, WithId } from 'mongodb';
import { newObjectIdHex } from '../object-id.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toDate, toHex, toObjectId, toObjectIdOrNull } from './values.ts';
import type { ChallengeDoc, ChallengePurpose } from '../../schema.ts';

export type { SqliteDb } from './db-handle.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface ChallengeRow {
  id: string;
  challenge: string;
  purpose: ChallengePurpose;
  user_id: string | null;
  email: string | null;
  invite_code: string | null;
  expires_at: string;
}

function toChallenge(row: ChallengeRow): WithId<ChallengeDoc> {
  return {
    _id: toObjectId(row.id),
    challenge: row.challenge,
    purpose: row.purpose,
    user_id: toObjectIdOrNull(row.user_id),
    email: row.email,
    invite_code: row.invite_code,
    expires_at: toDate(row.expires_at),
  };
}

/**
 * Record a challenge the server just handed out.
 *
 * `user_id` and `email` are null for a discoverable-credential sign-in, where
 * no account is known yet — the assertion's signature is what identifies it.
 */
export async function storeChallenge(
  args: {
    challenge: string;
    purpose: ChallengePurpose;
    user_id: ObjectId | null;
    email: string | null;
    invite_code: string | null;
  },
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(
    `INSERT INTO challenges (id, challenge, purpose, user_id, email, invite_code, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newObjectIdHex(),
      args.challenge,
      args.purpose,
      args.user_id === null ? null : toHex(args.user_id),
      args.email,
      args.invite_code,
      new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    ],
  );
}

/**
 * Spend a challenge and return what it was issued for.
 *
 * Throws when it is unknown or already spent, and — after spending it — when
 * it has expired. Both messages are the ones `auth/webauthn.ts` already
 * produced, because the register and login routes surface them.
 */
export async function consumeChallenge(
  challenge: string,
  dbOverride?: SqliteDb,
): Promise<WithId<ChallengeDoc>> {
  const db = sqliteDb(dbOverride);
  const rows = await db.read<ChallengeRow>(
    `SELECT id, challenge, purpose, user_id, email, invite_code, expires_at
       FROM challenges WHERE challenge = ?`,
    [challenge],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('challenge not found / already consumed');

  const deleted = await db.write(`DELETE FROM challenges WHERE id = ?`, [row.id]);
  // Nothing to delete means a concurrent ceremony got there first. It is the
  // same outcome as never having found the row, so it is the same error.
  if (deleted.changes !== 1) throw new Error('challenge not found / already consumed');

  const consumed = toChallenge(row);
  if (consumed.expires_at.getTime() < Date.now()) throw new Error('challenge expired');
  return consumed;
}
