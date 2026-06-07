import { ObjectId } from 'mongodb';
import { usersCollection } from '../db/client.ts';

/**
 * Bump a user's access-token generation counter (#860).
 *
 * Every access JWT carries the issuing `token_version` as its `tv` claim;
 * `requireAuth` rejects any token whose `tv` is behind the user's current
 * `token_version`. Incrementing it therefore invalidates ALL of that user's
 * live access tokens within one verify — the instant "kill this user now" lever
 * that a short TTL alone can't provide.
 *
 * Pair this with refresh revocation (`revokeChain`) so "sign out everywhere"
 * kills both the durable session and the in-flight access tokens together.
 */
export async function bumpTokenVersion(userId: ObjectId): Promise<void> {
  const users = await usersCollection();
  // $inc treats a missing field as 0, so a pre-#860 user goes 0 → 1.
  await users.updateOne({ _id: userId }, { $inc: { token_version: 1 } });
}
