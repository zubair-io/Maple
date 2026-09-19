/**
 * How an invite code is minted and how long it lives, with no store in it.
 *
 * The alphabet is RFC 4648 base32 without `0`, `1`, `8` and `9`, because an
 * invite is something one person reads out or types from a message and those
 * four are the characters that get confused with letters. That property only
 * holds if the generator and the validator agree, which is why there is one
 * definition rather than a copy in each store — the Mongo one and the SQLite
 * port (#3751).
 */

import { randomBytes } from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** How long an invite stays redeemable. */
export const INVITE_TTL_MS = 15 * 60 * 1000;

/** An eight-character invite code. */
export function generateInviteCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHA[b % 32]).join('');
}

/** The part of a stored invite that decides whether it may be spent. */
export interface RedeemableInvite {
  email: string;
  consumed_at: string | null;
  expires_at: Date;
}

/**
 * Throw unless this invite may be spent for this address.
 *
 * All four refusals are 410s, and the messages are part of the behaviour: an
 * invite meant for somebody else and an invite that has lapsed are different
 * things to tell a person who cannot register, and the route surfaces the text
 * verbatim. Shared between the two stores so neither can drift into saying
 * something the other does not.
 *
 * The `asserts` return type is what makes the guard load-bearing to the
 * compiler rather than only to a reader. Both stores go on to read a field off
 * the invite they just checked; declared `void`, that read needed a `!` and the
 * day a branch of this chain stopped throwing the failure would be a crash on
 * an absent field instead of the 410 the caller means to send, with nothing in
 * the type system objecting.
 */
export function assertInviteRedeemable(
  invite: RedeemableInvite | null,
  email: string,
): asserts invite is RedeemableInvite {
  const reject = (message: string): never => {
    throw Object.assign(new Error(message), { status: 410 });
  };
  if (!invite) reject('invite not found');
  else if (invite.email !== email.toLowerCase()) reject('invite/email mismatch');
  else if (invite.consumed_at !== null) reject('invite consumed');
  else if (invite.expires_at.getTime() < Date.now()) reject('invite expired');
}
