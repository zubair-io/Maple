import { serverStateCollection, usersCollection } from '../db/client.ts';

/**
 * Atomic server-ownership claim (#865).
 *
 * The first WebAuthn registration "claims the server" and becomes the owner.
 * The previous count-then-insert (`isClaimed()` + `register/verify`) had a TOCTOU
 * race: two simultaneous first-registrations could both observe "unclaimed" and
 * both become owner. We close it with a single sentinel document in
 * `server_state` whose `_id` is the Mongo primary key (unique by construction) —
 * so exactly one concurrent `insertOne` wins, no replica-set transaction needed
 * (the dev/CI mongod is standalone).
 */
export const OWNER_CLAIM_ID = 'owner_claim';

function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
}

/**
 * Attempt to claim server ownership. Returns `true` iff THIS caller won the
 * single owner slot. Under concurrency exactly one caller gets `true`; the rest
 * get `false` (the server is already claimed → they must be invited members).
 */
export async function tryClaimOwnership(): Promise<boolean> {
  const c = await serverStateCollection();
  try {
    await c.insertOne({ _id: OWNER_CLAIM_ID });
    return true;
  } catch (e) {
    if (isDuplicateKeyError(e)) return false;
    throw e;
  }
}

/**
 * Release a just-made ownership claim. Used to roll back when user/credential
 * creation fails AFTER the claim succeeded, so the server can be claimed again
 * rather than being stranded "claimed" with no owner account.
 */
export async function releaseOwnershipClaim(): Promise<void> {
  const c = await serverStateCollection();
  await c.deleteOne({ _id: OWNER_CLAIM_ID });
}

/**
 * Boot-time backfill (#2920): plant the ownership sentinel on installs
 * whose owner predates it — owners created before #865, or via dev-login
 * (which never claimed). Without this, `isClaimed()` (any-user-exists,
 * which gates "invite required") and `tryClaimOwnership()` (the sentinel)
 * disagree, and the NEXT invited registration wins the free sentinel and
 * escalates to owner.
 *
 * Self-gating and cheap: one `_id` point-read on `server_state`
 * short-circuits every boot after the first.
 */
export async function backfillOwnershipClaim(): Promise<void> {
  const c = await serverStateCollection();
  if ((await c.findOne({ _id: OWNER_CLAIM_ID })) != null) return;
  const users = await usersCollection();
  const anyUser = (await users.countDocuments({}, { limit: 1 })) > 0;
  if (!anyUser) return; // genuinely fresh install — first registration claims
  await tryClaimOwnership(); // idempotent; a concurrent claim losing is fine
}
