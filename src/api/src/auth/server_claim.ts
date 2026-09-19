/**
 * Atomic server-ownership claim (#865) — now stored in SQLite (#3787).
 *
 * The first WebAuthn registration "claims the server" and becomes the owner.
 * The count-then-insert this replaced had a race: two simultaneous first
 * registrations could both observe "unclaimed" and both become owner. It is
 * closed by a single sentinel row in `server_state` whose primary key is
 * unique by construction, so exactly one concurrent insert wins.
 *
 * The three operations — claim, release, and the boot-time backfill for
 * installs whose owner predates the sentinel — moved to
 * `db/sqlite/repos/server-state.repo.ts` under the same names. On Mongo the
 * winner was identified by catching a duplicate-key error; here it is the
 * `INSERT … ON CONFLICT DO NOTHING` row count, which needs no error code.
 */

export {
  backfillOwnershipClaim,
  OWNER_CLAIM_ID,
  releaseOwnershipClaim,
  tryClaimOwnership,
} from '../db/sqlite/repos/server-state.repo.ts';
