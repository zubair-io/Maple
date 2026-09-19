/**
 * Refresh rotation across more than one family (#858).
 *
 * One family's rotation — the compare-and-swap, the grace window, reuse
 * detection — is covered against the repository in
 * `db/sqlite/repos/auth.sessions.repo.test.ts`. What is left, and what this
 * file is for, is the behaviour that only shows up with two families or two
 * callers: logging one device out must not sign the others out, logging out
 * everywhere must, and two tabs refreshing the same token at the same instant
 * must not be mistaken for theft.
 *
 * It also drives `auth/refresh_store.ts` rather than the repository directly,
 * which is deliberate: that module is what every route imports, so these cases
 * are also the check that its exports still resolve to the SQLite store.
 */

import { describe, it, expect } from 'bun:test';
import type { ObjectId } from 'mongodb';
import {
  issueRefreshToken,
  revokeChain,
  revokeFamilyByToken,
  rotateRefreshToken,
} from '../../src/auth/refresh_store.ts';
import { insertUser } from '../../src/db/sqlite/repos/auth.users.repo.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';

async function seedUser(live: LiveTestDatabase, email = 'owner@maple.test'): Promise<ObjectId> {
  return await insertUser(
    { email, role: 'owner', created_at: new Date().toISOString(), last_seen_at: null },
    live.handle,
  );
}

describe('refresh rotation across families', () => {
  it('revoking one device family leaves another family live', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const iPhone = await issueRefreshToken(userId, 'iPhone');
    const iPad = await issueRefreshToken(userId, 'iPad');

    await revokeFamilyByToken(iPhone.raw); // log out the iPhone only
    await expect(rotateRefreshToken(iPhone.raw)).rejects.toThrow();
    expect((await rotateRefreshToken(iPad.raw)).raw).toBeDefined();
  });

  it('revokeChain signs every one of a user’s devices out', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const iPhone = await issueRefreshToken(userId, 'iPhone');
    const iPad = await issueRefreshToken(userId, 'iPad');

    await revokeChain(userId);
    await expect(rotateRefreshToken(iPhone.raw)).rejects.toThrow();
    await expect(rotateRefreshToken(iPad.raw)).rejects.toThrow();
  });

  it('revokeChain does not reach another account', async () => {
    using live = await createLiveTestDatabase();
    const mine = await seedUser(live, 'a@maple.test');
    const theirs = await seedUser(live, 'b@maple.test');
    const ours = await issueRefreshToken(mine, 'iPhone');
    const others = await issueRefreshToken(theirs, 'iPhone');

    await revokeChain(mine);
    await expect(rotateRefreshToken(ours.raw)).rejects.toThrow();
    expect((await rotateRefreshToken(others.raw)).raw).toBeDefined();
  });

  it('two concurrent rotations of the same token never nuke the family', async () => {
    using live = await createLiveTestDatabase();
    const userId = await seedUser(live);
    const first = await issueRefreshToken(userId, 'iPhone');

    const results = await Promise.allSettled([
      rotateRefreshToken(first.raw),
      rotateRefreshToken(first.raw),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    // A live token survives — the race was not read as reuse.
    const live_rows = live.db
      .query(`SELECT id FROM refresh_tokens WHERE revoked_at IS NULL`)
      .all() as Array<{ id: string }>;
    expect(live_rows.length).toBeGreaterThan(0);
  });
});
