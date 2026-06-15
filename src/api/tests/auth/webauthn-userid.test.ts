/**
 * WebAuthn user handle is not PII (#864).
 *
 * The registration `user.id` (the handle stored in the credential / synced to
 * the user's password manager) must never be the email. New accounts get a
 * random handle; an additional credential reuses the stable account `_id`.
 */
process.env.MAPLE_RP_ID = 'localhost';
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { buildRegistrationOptions } from '../../src/auth/webauthn.ts';
import { challengesCollection } from '../../src/db/client.ts';

const EMAIL = 'owner@maple.test';

beforeEach(async () => {
  await (await challengesCollection()).deleteMany({});
});

describe('webauthn user handle (#864)', () => {
  it('new-account registration uses a random handle, never the email', async () => {
    const opts = await buildRegistrationOptions({
      email: EMAIL,
      inviteCode: null,
      existingUserId: null,
      excludeCredentialIds: [],
    });
    // The handle must NOT be the email encoded (that was the PII). Assert on the
    // base64url directly — decoding random bytes as UTF-8 to look for '@' is
    // flaky (a random 0x40 byte decodes to '@').
    expect(opts.user.id).not.toBe(Buffer.from(EMAIL).toString('base64url'));
    // 32 random bytes → 43-char base64url.
    expect(opts.user.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('add-credential reuses the stable account id (still not the email)', async () => {
    const userId = new ObjectId();
    const opts = await buildRegistrationOptions({
      email: EMAIL,
      inviteCode: null,
      existingUserId: userId,
      excludeCredentialIds: [],
    });
    expect(Buffer.from(opts.user.id, 'base64url').toString('utf8')).toBe(userId.toHexString());
  });
});
