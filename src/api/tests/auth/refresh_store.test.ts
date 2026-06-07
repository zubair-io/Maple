import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeFamily,
  revokeFamilyByToken,
  revokeChain,
  REFRESH_GRACE_MS,
} from '../../src/auth/refresh_store.ts';
import { refreshTokensCollection } from '../../src/db/client.ts';

const userId = new ObjectId();

beforeEach(async () => {
  const c = await refreshTokensCollection();
  await c.deleteMany({});
});

/** Push every revoked token's `revoked_at` outside the grace window. */
async function ageOutGrace() {
  const c = await refreshTokensCollection();
  await c.updateMany(
    { revoked_at: { $ne: null } },
    { $set: { revoked_at: new Date(Date.now() - REFRESH_GRACE_MS - 5_000).toISOString() } },
  );
}

describe('refresh rotation (#858)', () => {
  it('rotates a live token (atomic CAS) into a new token in the same family', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const t2 = await rotateRefreshToken(t1.raw);
    expect(t2.raw).not.toBe(t1.raw);
    const rows = await (await refreshTokensCollection()).find({ user_id: userId }).toArray();
    expect(new Set(rows.map((r) => String(r.family_id))).size).toBe(1);
  });

  it('re-mints within grace when the family is live (lost-response / concurrent retry, NOT a logout)', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const t2 = await rotateRefreshToken(t1.raw); // t1 revoked, t2 live
    // Replay the just-rotated t1 (a lost-response retry): re-mints, does not throw.
    const t1b = await rotateRefreshToken(t1.raw);
    expect(t1b.raw).not.toBe(t1.raw);
    expect(t1b.raw).not.toBe(t2.raw);
    // t2 is still usable.
    expect((await rotateRefreshToken(t2.raw)).raw).toBeDefined();
  });

  it('rapid rotation then replay of an older token within grace re-mints (no false reuse)', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const t2 = await rotateRefreshToken(t1.raw);
    await rotateRefreshToken(t2.raw); // family head is now two steps ahead of t1
    // t1 is two rotations behind, but the family still has a live head → re-mint.
    expect((await rotateRefreshToken(t1.raw)).raw).toBeDefined();
  });

  it('REJECTS a within-grace replay after the family is revoked (logout actually logs out)', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const t2 = await rotateRefreshToken(t1.raw); // t1 revoked, t2 live
    await revokeFamilyByToken(t2.raw); // logout — kills the whole family
    await expect(rotateRefreshToken(t1.raw)).rejects.toThrow();
    await expect(rotateRefreshToken(t2.raw)).rejects.toThrow();
  });

  it('revokes the family on reuse OUTSIDE the grace window', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const t2 = await rotateRefreshToken(t1.raw);
    const t3 = await rotateRefreshToken(t2.raw); // t3 live
    await ageOutGrace();
    await expect(rotateRefreshToken(t1.raw)).rejects.toThrow(/reuse/i);
    // The family is now dead — even the previously-live head no longer rotates.
    await expect(rotateRefreshToken(t3.raw)).rejects.toThrow();
  });

  it('family-scoped: revoking one device family leaves another family live', async () => {
    const a1 = await issueRefreshToken(userId, 'iPhone'); // family A
    const b1 = await issueRefreshToken(userId, 'iPad'); // family B
    await revokeFamilyByToken(a1.raw); // log out iPhone only
    await expect(rotateRefreshToken(a1.raw)).rejects.toThrow();
    expect((await rotateRefreshToken(b1.raw)).raw).toBeDefined(); // iPad still works
  });

  it('two concurrent rotations of the same token never nuke the family', async () => {
    const t1 = await issueRefreshToken(userId, 'iPhone');
    const results = await Promise.allSettled([
      rotateRefreshToken(t1.raw),
      rotateRefreshToken(t1.raw),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    // A live token survives — the family was not reuse-revoked by the race.
    const live = await (
      await refreshTokensCollection()
    ).findOne({ user_id: userId, revoked_at: null });
    expect(live).not.toBeNull();
  });

  it('rejects an expired token', async () => {
    const t = await issueRefreshToken(userId, 'iPhone');
    await (
      await refreshTokensCollection()
    ).updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    await expect(rotateRefreshToken(t.raw)).rejects.toThrow(/expired/i);
  });

  it('rejects an unknown token', async () => {
    await expect(rotateRefreshToken('no-such-token')).rejects.toThrow(/unknown/i);
  });

  it('revokeChain revokes all of a user’s families (log out everywhere)', async () => {
    const a1 = await issueRefreshToken(userId, 'iPhone');
    const b1 = await issueRefreshToken(userId, 'iPad');
    await revokeChain(userId);
    await expect(rotateRefreshToken(a1.raw)).rejects.toThrow();
    await expect(rotateRefreshToken(b1.raw)).rejects.toThrow();
  });

  it('revokeFamily revokes only the matching family', async () => {
    const a1 = await issueRefreshToken(userId, 'iPhone');
    const c = await refreshTokensCollection();
    const a = await c.findOne({ token_hash: { $exists: true } });
    await revokeFamily(a!.family_id);
    await expect(rotateRefreshToken(a1.raw)).rejects.toThrow();
  });
});
