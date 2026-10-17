/**
 * Refresh tokens and paired-device sessions — now stored in SQLite (#3787).
 *
 * Rotation, family revocation and the device-session panel moved to
 * `db/repos/auth.refresh.repo.ts` and
 * `db/repos/auth.device-sessions.repo.ts` under the same names and
 * signatures. Two questions asked of one table, so two modules: rotation is
 * about a single token, a device session is about a whole family.
 *
 * The rotation is still atomic. What was one `findOneAndUpdate` is now two
 * statements inside one transaction — insert the successor from the old row,
 * then consume the old row under the same liveness predicate — and the second
 * statement's row count is what says this caller won. See the repository's
 * module comment for why the insert has to come first.
 *
 * The error class, the grace window and the option/result shapes stay in
 * `./refresh-contract.ts` and are re-exported here. `routes/auth.ts` picks a
 * status code with `err instanceof RefreshError`, so there has to be exactly
 * one such class no matter which module threw it.
 */

import type { ObjectId } from '../db/object-id.ts';
import { hasLivePrimaryRefreshToken } from '../db/repos/auth.device-sessions.repo.ts';
import { verifyStepUpToken } from './tokens.ts';

export { RefreshError } from './refresh-contract.ts';

export {
  issueRefreshToken,
  revokeChain,
  revokeFamilyByToken,
  rotateRefreshToken,
} from '../db/repos/auth.refresh.repo.ts';

export {
  hasLivePrimaryRefreshToken,
  listDeviceSessions,
  revokeDeviceSession,
} from '../db/repos/auth.device-sessions.repo.ts';

/**
 * Whether a caller has proven persistent-login authority (a live primary
 * refresh token via cookie or request body) or fresh passkey step-up
 * (`X-Step-Up` header) before minting a new refresh-token family (#4673).
 *
 * A short-lived 15-minute access JWT on its own cannot mint a 90-day refresh
 * family via `/api/auth/native-code` or `/api/auth/lan-handoff`.
 */
export async function hasHandoffProof(args: {
  userId: ObjectId;
  cookieRefreshToken?: unknown;
  bodyRefreshToken?: string;
  stepUpToken?: string;
  jwtSecret: string;
}): Promise<boolean> {
  if (typeof args.stepUpToken === 'string' && args.stepUpToken.length > 0) {
    try {
      const claims = await verifyStepUpToken(args.stepUpToken, args.jwtSecret);
      if (claims.sub === args.userId.toHexString()) return true;
    } catch {
      // Invalid or expired step-up token; fall through to check refresh proof.
    }
  }
  const rawRefresh =
    typeof args.cookieRefreshToken === 'string' && args.cookieRefreshToken.length > 0
      ? args.cookieRefreshToken
      : typeof args.bodyRefreshToken === 'string' && args.bodyRefreshToken.length > 0
        ? args.bodyRefreshToken
        : null;
  if (!rawRefresh) return false;
  return await hasLivePrimaryRefreshToken(args.userId, rawRefresh);
}
