/**
 * DB-backed HS256 signing secret for access tokens.
 *
 * The secret lives in the `server_state` collection under `_id: "jwt_secret"`.
 * MongoDB is the persistent, shared store, so this fixes the two ways an
 * auto-generated secret silently rotates and invalidates every issued token
 * (surfacing to clients as `bad signature` 401s):
 *
 *   1. Container recreate / redeploy — a file on the ephemeral layer is lost,
 *      Mongo data (the `mongo_data` volume) is not.
 *   2. Multiple instances — a per-process file gives each replica its own
 *      secret; the DB gives them one.
 *
 * The secret is owned by the server, not configured via the environment. When
 * Mongo is unreachable at boot the caller falls back to an on-disk file (see
 * `index.ts`).
 */

import { randomBytes } from 'node:crypto';
import { serverStateCollection } from '../db/client.ts';

export const JWT_SECRET_DOC_ID = 'jwt_secret';

function isDuplicateKeyError(err: unknown): boolean {
  return typeof (err as { code?: unknown } | null)?.code === 'number'
    ? (err as { code: number }).code === 11000
    : false;
}

/**
 * Reads the shared JWT secret from the DB, creating it on first call.
 *
 * Race-safe across instances booting simultaneously, and robust to a row that
 * exists without a `value` (e.g. a partial prior write): the create path
 * matches only docs that lack `value` (`{ value: { $exists: false } }`) and
 * `$set`s the candidate. So it persists the secret whether the row is missing
 * entirely (upsert inserts) or present-but-empty (update fills it in) — the
 * earlier `$setOnInsert` version silently skipped the present-but-empty case,
 * returning an unpersisted candidate and letting each process mint a different
 * one. A doc that already HAS a value doesn't match the filter, so the upsert
 * attempts an insert and trips the duplicate `_id` key; we catch that and
 * re-read the winning value. Concurrent racers converge the same way.
 *
 * `created` is true only for the instance that actually minted the secret —
 * used by the caller to log at warn level (a brand-new secret means any
 * pre-existing tokens won't verify).
 */
export async function getOrCreateJwtSecret(): Promise<{
  secret: string;
  created: boolean;
}> {
  const coll = await serverStateCollection();

  const existing = await coll.findOne({ _id: JWT_SECRET_DOC_ID });
  if (existing?.value) return { secret: existing.value, created: false };

  const candidate = randomBytes(32).toString('base64url');
  try {
    const res = await coll.findOneAndUpdate(
      { _id: JWT_SECRET_DOC_ID, value: { $exists: false } },
      { $set: { value: candidate } },
      { upsert: true, returnDocument: 'after' },
    );
    const value = (res as { value?: string } | null)?.value ?? candidate;
    return { secret: value, created: value === candidate };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const doc = await coll.findOne({ _id: JWT_SECRET_DOC_ID });
      if (doc?.value) return { secret: doc.value, created: false };
    }
    throw err;
  }
}
