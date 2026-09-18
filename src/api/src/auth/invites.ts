/**
 * Invite codes — now stored in SQLite (#3787).
 *
 * The four operations moved verbatim to `db/sqlite/repos/auth.invites.repo.ts`
 * under the same names and signatures, so this module is the re-export that
 * keeps `routes/auth.ts` importing the path it always has. The alphabet, the
 * generator, the lifetime and the redeemability assertion never moved: they
 * live in `./invite-code.ts` and both stores share them, which is what stops a
 * code minted from one alphabet being read back against another.
 *
 * Deleting MongoDB is #3785; until then this file is what makes the cutover a
 * one-line revert rather than an edit to every caller.
 */

export {
  createInvite,
  listInvites,
  redeemInvite,
  rescindInvite,
} from '../db/sqlite/repos/auth.invites.repo.ts';
