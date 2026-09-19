/**
 * `auth/native_code_store.ts` reaches the SQLite store (#3787).
 *
 * The PKCE properties — single use, and a wrong verifier that neither succeeds
 * nor burns the code — are covered against the repository in
 * `db/sqlite/repos/auth.sessions.repo.test.ts`. This file covers the module the
 * native auth routes actually import: that its three operations and the
 * re-exported `pkceS256` still resolve, and that they now write to SQLite.
 */

import { describe, it, expect } from 'bun:test';
import {
  claimNativeCode,
  issueNativeCode,
  pkceS256,
  redeemNativeCode,
} from '../../src/auth/native_code_store.ts';
import { insertUser } from '../../src/db/sqlite/repos/auth.users.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

const VERIFIER = 'verifier-abc123';

async function seedUser(live: LiveTestDatabase) {
  return await insertUser(
    {
      email: 'owner@maple.test',
      role: 'owner',
      created_at: new Date().toISOString(),
      last_seen_at: null,
    },
    live.handle,
  );
}

describe('native auth codes through the auth module', () => {
  it('issues a code the redirect hop can spend once', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const { code } = await issueNativeCode({
      userId,
      codeChallenge: pkceS256(VERIFIER),
      state: 'st1',
      deviceLabel: 'iPhone',
    });

    const redeemed = await redeemNativeCode(code, VERIFIER);
    expect(redeemed).toMatchObject({ deviceLabel: 'iPhone', state: 'st1' });
    expect(redeemed?.userId.toHexString()).toBe(userId.toHexString());
    expect(await redeemNativeCode(code, VERIFIER)).toBeNull();
  });

  it('issues a code the polling channel can spend without the code (#3063)', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    await issueNativeCode({
      userId,
      codeChallenge: pkceS256(VERIFIER),
      state: 'st2',
      deviceLabel: 'iPhone',
    });

    expect(await claimNativeCode('st2', 'wrong-verifier')).toBeNull();
    expect(await claimNativeCode('st2', VERIFIER)).toMatchObject({ state: 'st2' });
    expect(await claimNativeCode('st2', VERIFIER)).toBeNull();
  });
});
