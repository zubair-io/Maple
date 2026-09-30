/**
 * Invite codes — now stored in SQLite (#3787).
 *
 * Invite operations live in `db/repos/auth.invites.repo.ts`, so this module is the re-export that
 * keeps `routes/auth.ts` importing the path it always has. The alphabet, the
 * generator, the lifetime and the redeemability assertion never moved: they
 * live in `./invite-code.ts` and both stores share them, which is what stops a
 * code minted from one alphabet being read back against another.
 *
 * The invite code is shared directly with the joining user and carries no
 * email address.
 */

export {
  createInvite,
  listInvites,
  redeemInvite,
  rescindInvite,
} from '../db/repos/auth.invites.repo.ts';
