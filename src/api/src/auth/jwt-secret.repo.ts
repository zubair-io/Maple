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
 * `MAPLE_JWT_SECRET` (env) still wins when set — operators managing the key
 * out-of-band, and tests, rely on that.
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
 * Race-safe across instances booting simultaneously: the create path uses an
 * upsert with `$setOnInsert`, so only the first writer's value is stored and
 * every other racer reads back that same value. A `$setOnInsert` upsert can
 * still surface a duplicate-key error under a tight race; we treat that as
 * "someone else just created it" and re-read.
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
      { _id: JWT_SECRET_DOC_ID },
      { $setOnInsert: { value: candidate } },
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
