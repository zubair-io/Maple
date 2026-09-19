/**
 * `auth/invites.ts` reaches the SQLite store (#3787).
 *
 * The invite rules themselves — the four distinct 410s, creation order, the
 * `Date` the DTO promises — are covered against the repository in
 * `db/repos/auth.enrolment.repo.test.ts`. This file exists for the one
 * thing that test cannot see: that the module `routes/auth.ts` imports still
 * exports those four operations, and that they now land in SQLite rather than
 * in a collection nothing opens any more.
 */

import { describe, it, expect } from 'bun:test';
import { createInvite, listInvites, redeemInvite, rescindInvite } from '../../src/auth/invites.ts';
import { insertUser } from '../../src/db/repos/auth.users.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

async function seedOwner(live: LiveTestDatabase) {
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

describe('invites through the auth module', () => {
  it('mints a readable code, redeems it once, and lists it', async () => {
    using live = await createLiveTestDatabase();
    const owner = await seedOwner(live);

    const invite = await createInvite(owner, 'Alice@Example.com');
    // Base32 without 0/1/8/9 — an invite is read out loud or typed from a
    // message, so the confusable characters are not in the alphabet.
    expect(invite.code).toMatch(/^[A-Z2-7]{8}$/);
    expect(invite.email).toBe('alice@example.com');

    expect(await listInvites()).toHaveLength(1);
    expect(await redeemInvite(invite.code, 'alice@example.com')).toMatchObject({ ok: true });
    await expect(redeemInvite(invite.code, 'alice@example.com')).rejects.toThrow(/consumed/);
  });

  it('rescinding takes the code out of the store', async () => {
    using live = await createLiveTestDatabase();
    const owner = await seedOwner(live);
    const invite = await createInvite(owner, 'alice@example.com');

    await rescindInvite(invite.code);
    expect(await listInvites()).toHaveLength(0);
    await expect(redeemInvite(invite.code, 'alice@example.com')).rejects.toThrow(/not found/);
  });
});
