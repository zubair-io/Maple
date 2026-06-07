/**
 * Atomic server-ownership claim (#865).
 *
 * The first registration claims the single owner slot. This proves the claim is
 * atomic under concurrency — the TOCTOU that let two simultaneous first
 * registrations both become owner is closed.
 */
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  tryClaimOwnership,
  releaseOwnershipClaim,
  OWNER_CLAIM_ID,
} from '../../src/auth/server_claim.ts';
import { serverStateCollection } from '../../src/db/client.ts';

beforeEach(async () => {
  await (await serverStateCollection()).deleteOne({ _id: OWNER_CLAIM_ID });
});

describe('server ownership claim (#865)', () => {
  it('lets exactly one of many concurrent claimers win', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => tryClaimOwnership()));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a second claim fails until the first is released', async () => {
    expect(await tryClaimOwnership()).toBe(true);
    expect(await tryClaimOwnership()).toBe(false);
    await releaseOwnershipClaim();
    expect(await tryClaimOwnership()).toBe(true);
  });
});
