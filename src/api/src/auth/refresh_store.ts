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

export { RefreshError } from './refresh-contract.ts';

export {
  issueRefreshToken,
  revokeChain,
  revokeFamilyByToken,
  rotateRefreshToken,
} from '../db/repos/auth.refresh.repo.ts';

export {
  listDeviceSessions,
  revokeDeviceSession,
} from '../db/repos/auth.device-sessions.repo.ts';
