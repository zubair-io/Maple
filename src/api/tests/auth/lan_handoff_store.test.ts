/**
 * `auth/lan_handoff_store.ts` reaches the SQLite store (#3787).
 *
 * The single-use guarantee and the refusal of an expired or unknown code are
 * covered against the repository in
 * `db/repos/auth.sessions.repo.test.ts`. This file covers the module
 * `routes/auth-lan-handoff.ts` imports: that both operations still resolve and
 * now write to SQLite.
 */

import { describe, it, expect } from 'bun:test';
import { issueLanHandoffCode, redeemLanHandoffCode } from '../../src/auth/lan_handoff_store.ts';
import { insertUser } from '../../src/db/repos/auth.users.repo.ts';
import { createLiveTestDatabase } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

describe('LAN handoff codes through the auth module', () => {
  it('issues a code the same browser can spend once on the LAN address', async () => {
    using live = await createLiveTestDatabase();
    const userId = await insertUser(
      {
        email: 'owner@maple.test',
        role: 'owner',
        created_at: new Date().toISOString(),
        last_seen_at: null,
      },
      live.handle,
    );

    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Local network session' });
    const redeemed = await redeemLanHandoffCode(code);
    expect(redeemed?.deviceLabel).toBe('Local network session');
    expect(redeemed?.userId.toHexString()).toBe(userId.toHexString());

    expect(await redeemLanHandoffCode(code)).toBeNull();
    expect(await redeemLanHandoffCode('no-such-code')).toBeNull();
  });
});
