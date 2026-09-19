/**
 * What a refresh-token store promises its callers, with no store in it.
 *
 * The error class, its codes, the grace window and the two option/result
 * shapes were declared inside `refresh_store.ts`, which was fine while there
 * was one implementation. The SQLite port (#3751) adds a second, and a second
 * copy of an error class is worse than it looks: `routes/auth.ts` decides
 * between a 401 and a 409 with `err instanceof RefreshError`, so two classes
 * of the same name would make that check depend on which store threw.
 *
 * Extracting them here means both stores throw the one class and every caller
 * keeps working across the cutover (#3752) without noticing it happened.
 * Nothing in this file touches a database.
 */

import type { ObjectId } from '../db/object-id.ts';

export interface IssuedRefresh {
  raw: string;
  userId: ObjectId;
  familyId: ObjectId;
  /** Whether the caller's cookie for this token must be `Secure`. */
  secure: boolean;
}

export type RefreshErrorCode =
  | 'unknown_token'
  | 'token_expired'
  | 'rotation_conflict'
  | 'reuse_detected';

/** Why a rotation was refused, in a form the route can map to a status code. */
export class RefreshError extends Error {
  constructor(
    public readonly code: RefreshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * Lost-response / concurrent-rotation grace window (#858).
 *
 * A just-rotated (revoked) token replayed within this window — *while its
 * family still has a live token* — is treated as a benign retry and re-minted,
 * NOT as theft. This is what stops the original "refresh token reuse detected —
 * chain revoked" logout: a refresh whose response was lost (or a concurrent
 * multi-tab/in-flight refresh) replays the old token and recovers instead of
 * nuking the session.
 *
 * It bounds the theft-detection gap to ~this window and pairs with the
 * short-access-TTL pivot (#860). It covers concurrent refreshes and quick
 * reloads; a lost response followed by a delayed return (minutes later) still
 * lands outside the window and requires a re-login — an acceptable, safe
 * outcome for a long-dormant tab.
 */
export const REFRESH_GRACE_MS = 60_000;

export interface IssueRefreshTokenOptions {
  /** Rotation lineage. Omitting starts a NEW family (a fresh login / device);
   * a rotation passes the parent token's family so the whole lineage is
   * tracked together and can be revoked as a unit. */
  familyId?: ObjectId;
  platform?: string;
  /** Whether the caller's cookie for this token must be `Secure`. Defaults to
   * `true` — pass `false` only for the LAN-handoff redeem, whose cookie
   * answers on a plain-HTTP LAN origin. */
  secure?: boolean;
}
