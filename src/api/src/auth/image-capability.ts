/**
 * Short-lived, path-bound image capabilities — storage now in SQLite (#3787).
 *
 * The request gate stays here and the row lookup moved: this module decides
 * whether a request is even eligible to present a capability, and
 * `db/sqlite/repos/auth.image-capability.repo.ts` decides whether the token it
 * presents is live for that exact path.
 *
 * The two halves kept different names because they answer different
 * questions — `verifyImageCapability` takes a `Request`, the repository
 * function takes a token and a path — so this is a rewire rather than a
 * re-export. The exported name and the middleware's call site are unchanged;
 * only the optional test override's type moved from a Mongo `Db` to a
 * `SqliteDb`.
 *
 * Expiry is enforced in the repository's `WHERE` clause, not by a background
 * collector, so an expired grant is never selected in the first place. That was
 * already true on Mongo — its TTL monitor runs once a minute and an expired
 * document stays readable until it fires — so nothing here got weaker. The
 * periodic `DELETE` that keeps the table small is
 * `db/sqlite/repos/auth.expiry.ts`.
 */

import { imageCapabilityIsValid } from '../db/sqlite/repos/auth.image-capability.repo.ts';
import type { SqliteDb } from '../db/sqlite/repos/db-handle.ts';

/** A 32-byte value in base64url — what `issueImageCapability` hands out. */
const IMAGE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Validate a short-lived, path-bound image capability from the URL. These are
 * intentionally narrower than access JWTs: GET-only, exact path, and limited
 * to the thumbnail/preview route families.
 *
 * Every condition that can be decided without the database is decided first,
 * so a malformed token costs no query at all.
 */
export async function verifyImageCapability(
  request: Request,
  dbOverride?: SqliteDb,
): Promise<boolean> {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/thumb/') && !url.pathname.startsWith('/api/preview/'))
    return false;
  const token = url.searchParams.get('token');
  if (!token || !IMAGE_CAPABILITY_PATTERN.test(token)) return false;
  return await imageCapabilityIsValid(token, url.pathname, dbOverride);
}
