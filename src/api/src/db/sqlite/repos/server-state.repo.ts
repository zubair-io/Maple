/**
 * `server_state` — the SQLite port of the two server-wide singletons the auth
 * layer keeps there: the shared JWT signing secret and the ownership sentinel
 * (#3751).
 *
 * Both are the same shape of problem — several processes booting at once, one
 * of them has to win, and every loser has to agree on who did — and on Mongo
 * both are written around the driver's duplicate-key error. SQLite answers
 * both without an error code: `INSERT … ON CONFLICT` says what to do when the
 * key is taken, and the statement's row count says whether this caller was the
 * one that wrote. A conditional insert whose outcome is read off `changes` is
 * also the only shape available, because the pool's writer returns
 * `{ changes, lastInsertRowid }` and no rows — `RETURNING` would execute and
 * have its output discarded, and a `read` runs on a read-only connection.
 *
 * ## What is deliberately not here
 *
 * The third occupant of this table is the asset-change cursor
 * (`id = 'asset_changes_cursor'`, allocated by `$inc` on `seq` in
 * `db/changes.repo.ts`). It belongs to the change-feed slice, ticket #3747,
 * and porting it here would mean two modules issuing writes against one table
 * for no benefit — the cursor shares nothing with these two beyond the table
 * name. The `seq` column exists for it; nothing in this file touches it.
 *
 * MongoDB is still the live database; nothing imports this module yet. The
 * cutover (#3752) swaps the import paths.
 */

import { randomBytes } from 'node:crypto';
import { anyUserExists } from './auth.users.repo.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';

export type { SqliteDb } from './db-handle.ts';

export const JWT_SECRET_DOC_ID = 'jwt_secret';
export const OWNER_CLAIM_ID = 'owner_claim';

/** The stored secret, or null when the row is missing or holds no value. */
async function readSecret(db: SqliteDb): Promise<string | null> {
  const rows = await db.read<{ value: string | null }>(
    `SELECT value FROM server_state WHERE id = ?`,
    [JWT_SECRET_DOC_ID],
  );
  const value = rows[0]?.value;
  return value === undefined || value === null || value === '' ? null : value;
}

/**
 * The shared HS256 signing secret, minted on first call.
 *
 * The secret lives in the database rather than in a file or the environment so
 * that it survives a container recreate and so that every instance signs with
 * the same key — the two ways an auto-generated secret silently rotates and
 * turns every issued token into a `bad signature` 401.
 *
 * Racing boots converge on one value, and a row that exists without a usable
 * secret is filled rather than treated as settled. The conflict branch writes
 * only where the stored value is one {@link readSecret} counts as absent —
 * SQL NULL or the empty string — so it fills a half-written row and refuses to
 * overwrite a real secret; a caller whose candidate loses that test reads back
 * the winner's. This is the bug the Mongo version's comment describes
 * `$setOnInsert` having, closed by the statement rather than by a retry.
 *
 * The empty string has to be in that test, not just NULL. `readSecret` already
 * treats `''` as no secret, so without it the two halves disagree: the read
 * says "nothing stored, mint one", the upsert's guard says "a value is already
 * there, leave it", and the re-read says "nothing stored" again — and the
 * function throws. That is not a transient failure; the row never changes, so
 * every subsequent boot throws too and the server can never issue a token
 * again.
 *
 * `created` keeps its exact meaning: true only for the caller whose own
 * candidate landed, which the caller logs at warn level because a brand-new
 * secret invalidates every pre-existing token.
 */
export async function getOrCreateJwtSecret(
  dbOverride?: SqliteDb,
): Promise<{ secret: string; created: boolean }> {
  const db = sqliteDb(dbOverride);

  // The common path once the server has booted once: one read, no minting.
  const existing = await readSecret(db);
  if (existing !== null) return { secret: existing, created: false };

  const candidate = randomBytes(32).toString('base64url');
  const result = await db.write(
    `INSERT INTO server_state (id, value) VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET value = excluded.value
     WHERE server_state.value IS NULL OR server_state.value = ''`,
    [JWT_SECRET_DOC_ID, candidate],
  );
  if (result.changes === 1) return { secret: candidate, created: true };

  // Somebody else's candidate is already in the row. Theirs is the secret
  // every instance must sign with, so adopt it.
  const winner = await readSecret(db);
  if (winner === null) {
    throw new Error('getOrCreateJwtSecret: server_state row has no value after a lost race');
  }
  return { secret: winner, created: false };
}

/**
 * Attempt to claim server ownership. True iff THIS caller won the single owner
 * slot; under concurrency exactly one caller gets true and the rest must be
 * invited members.
 *
 * The first WebAuthn registration claims the server. The count-then-insert it
 * replaced had a race — two simultaneous first-registrations could both see
 * "unclaimed" and both become owner — closed by making the claim a single
 * sentinel row whose primary key is unique by construction. `DO NOTHING` plus
 * a row count of 1 identifies the winner without inspecting an error.
 */
export async function tryClaimOwnership(dbOverride?: SqliteDb): Promise<boolean> {
  const result = await sqliteDb(dbOverride).write(
    `INSERT INTO server_state (id) VALUES (?) ON CONFLICT (id) DO NOTHING`,
    [OWNER_CLAIM_ID],
  );
  return result.changes === 1;
}

/**
 * Release a just-made ownership claim, so the server can be claimed again
 * rather than stranded "claimed" with no owner account. Used to roll back when
 * user or credential creation fails after the claim succeeded.
 */
export async function releaseOwnershipClaim(dbOverride?: SqliteDb): Promise<void> {
  await sqliteDb(dbOverride).write(`DELETE FROM server_state WHERE id = ?`, [OWNER_CLAIM_ID]);
}

/**
 * Boot-time backfill: plant the ownership sentinel on installs whose owner
 * predates it — owners created before the sentinel existed, or through
 * dev-login, which never claimed.
 *
 * Without it the two ways of asking "is this server claimed?" disagree: the
 * any-user-exists check that gates "invite required" says yes while the
 * sentinel says no, and the next invited registration wins the free sentinel
 * and escalates itself to owner. Self-gating and cheap — one keyed read
 * short-circuits every boot after the first — and a genuinely fresh install is
 * left alone so its first registration still claims.
 *
 * The user probe comes from the users repository rather than from a local
 * count: "is there an account" is that module's question, and the bootstrap
 * route's `claimed` flag already asks it there, so one answer serves both.
 */
export async function backfillOwnershipClaim(dbOverride?: SqliteDb): Promise<void> {
  const db = sqliteDb(dbOverride);
  const claimed = await db.read<{ id: string }>(`SELECT id FROM server_state WHERE id = ?`, [
    OWNER_CLAIM_ID,
  ]);
  if (claimed.length > 0) return;
  if (!(await anyUserExists(db))) return;
  await tryClaimOwnership(db); // idempotent; losing a concurrent claim is fine
}
