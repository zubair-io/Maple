/**
 * WebAuthn user handle is not PII (#864).
 *
 * The registration `user.id` (the handle stored in the credential / synced to
 * the user's password manager) must never be the email. New accounts get a
 * random handle; an additional credential reuses the stable account `_id`.
 *
 * `buildRegistrationOptions` records the ceremony's challenge as a side effect,
 * so the test installs a database for the block rather than passing one in —
 * the function takes no handle, because neither does the route that calls it.
 */
process.env.MAPLE_RP_ID = 'localhost';

import { describe, it, expect } from 'bun:test';
import { buildRegistrationOptions } from '../../src/auth/webauthn.ts';
import { insertUser } from '../../src/db/repos/auth.users.repo.ts';
import { createLiveTestDatabase } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

const EMAIL = 'owner@maple.test';

describe('webauthn user handle (#864)', () => {
  it('new-account registration uses a random handle, never the email', async () => {
    using live = await createLiveTestDatabase();
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
    // The ceremony is recorded, unbound to any account.
    const rows = live.db
      .query(`SELECT purpose, user_id FROM challenges WHERE challenge = ?`)
      .all(opts.challenge) as Array<{ purpose: string; user_id: string | null }>;
    expect(rows).toEqual([{ purpose: 'register', user_id: null }]);
  });

  it('add-credential reuses the stable account id (still not the email)', async () => {
    using live = await createLiveTestDatabase();
    const userId = await insertUser(
      { email: EMAIL, role: 'owner', created_at: new Date().toISOString(), last_seen_at: null },
      live.handle,
    );
    const opts = await buildRegistrationOptions({
      email: EMAIL,
      inviteCode: null,
      existingUserId: userId,
      excludeCredentialIds: [],
    });
    expect(Buffer.from(opts.user.id, 'base64url').toString('utf8')).toBe(userId.toHexString());
  });
});
