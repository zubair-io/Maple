/**
 * The ranking that decides who keeps a contested file path (#3790).
 *
 * Pure, so every shape is one literal pair and no database is involved. The
 * end-to-end proof — that the winner is the row the import actually writes, and
 * that the loser's asset survives without it — is in
 * `import-contested-locations.test.ts`.
 *
 * The property under test throughout is that the answer comes from the
 * documents rather than from the order they are read in, so every case is also
 * asserted with the arguments the other way round.
 */

import { describe, expect, it } from 'bun:test';
import {
  compareClaims,
  resolveContest,
  type ContestRule,
  type LocationClaim,
} from './contested-locations.ts';

const BASE: LocationClaim = {
  assetId: 'a'.repeat(24),
  ordinal: 0,
  deletedAt: null,
  missingSince: null,
  assetDeletedAt: null,
  indexedAt: '2026-01-01T00:00:00.000Z',
};

function claim(overrides: Partial<LocationClaim>): LocationClaim {
  return { ...BASE, ...overrides };
}

/** The id that sorts first, which is also the one inserted first. */
const LOWER_ID = '6a0000010000000000000001';
const HIGHER_ID = '6a0000020000000000000002';

/** Asserts who keeps the address, and that the answer is not argument order. */
function winner(first: LocationClaim, second: LocationClaim): { id: string; rule: ContestRule } {
  const forwards = compareClaims(first, second);
  const backwards = compareClaims(second, first);
  expect(forwards.order).toBe(-backwards.order);
  expect(forwards.rule).toBe(backwards.rule);
  return {
    id: forwards.order < 0 ? first.assetId : second.assetId,
    rule: forwards.rule,
  };
}

describe('which claim keeps a contested address', () => {
  /**
   * The case the production library is made of: the tombstone was created
   * first, so it is inserted first and used to win by default, taking the live
   * photo's whole asset with it.
   */
  it('gives it to the live entry even when the tombstone has the lower id', () => {
    const tombstone = claim({ assetId: LOWER_ID, deletedAt: '2026-05-23T00:00:00.000Z' });
    const live = claim({ assetId: HIGHER_ID });
    expect(winner(tombstone, live)).toEqual({ id: HIGHER_ID, rule: 'entry-liveness' });
  });

  it('prefers the entry still on disk to one tagged missing', () => {
    const missing = claim({ assetId: LOWER_ID, missingSince: '2026-05-23T00:00:00.000Z' });
    const present = claim({ assetId: HIGHER_ID });
    expect(winner(missing, present)).toEqual({ id: HIGHER_ID, rule: 'entry-presence' });
  });

  /** A tagged entry still beats a tombstone: it has no `deleted_at`. */
  it('prefers a missing entry to a tombstone', () => {
    const missing = claim({ assetId: HIGHER_ID, missingSince: '2026-05-23T00:00:00.000Z' });
    const tombstone = claim({ assetId: LOWER_ID, deletedAt: '2026-05-23T00:00:00.000Z' });
    expect(winner(missing, tombstone)).toEqual({ id: HIGHER_ID, rule: 'entry-liveness' });
  });

  it('prefers an entry on a live asset to one on a soft-deleted asset', () => {
    // The trashed asset was indexed later, so recency alone would pick it.
    const trashed = claim({
      assetId: LOWER_ID,
      assetDeletedAt: '2026-08-23T00:00:00.000Z',
      indexedAt: '2026-08-01T00:00:00.000Z',
    });
    const kept = claim({ assetId: HIGHER_ID, indexedAt: '2026-02-01T00:00:00.000Z' });
    expect(winner(trashed, kept)).toEqual({ id: HIGHER_ID, rule: 'asset-liveness' });
  });

  /**
   * Two live entries on two live assets is a genuine ambiguity — the same bytes
   * indexed twice, usually — and the production library has 196 of them. The
   * later scan is the one that last saw a file at that path, so it keeps it.
   */
  it('gives a live-against-live contest to the more recently indexed asset', () => {
    const stale = claim({ assetId: LOWER_ID, indexedAt: '2026-01-01T00:00:00.000Z' });
    const fresh = claim({ assetId: HIGHER_ID, indexedAt: '2026-09-01T00:00:00.000Z' });
    expect(winner(stale, fresh)).toEqual({ id: HIGHER_ID, rule: 'index-recency' });
  });

  /** Two tombstones need a rule too. They get the same one, not a special case. */
  it('decides tombstone against tombstone on the same ladder', () => {
    const older = claim({
      assetId: HIGHER_ID,
      deletedAt: '2026-03-01T00:00:00.000Z',
      indexedAt: '2026-02-01T00:00:00.000Z',
    });
    const newer = claim({
      assetId: LOWER_ID,
      deletedAt: '2026-04-01T00:00:00.000Z',
      indexedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(winner(older, newer)).toEqual({ id: LOWER_ID, rule: 'index-recency' });
  });

  it('gives one asset claiming a path twice to its canonical entry', () => {
    const second = claim({ assetId: LOWER_ID, ordinal: 1 });
    const canonical = claim({ assetId: LOWER_ID, ordinal: 0 });
    expect(winner(second, canonical)).toEqual({ id: LOWER_ID, rule: 'canonical-ordinal' });
    expect(compareClaims(canonical, second).order).toBeLessThan(0);
  });

  /** Indistinguishable on every meaningful axis, and something must still decide. */
  it('falls back to the identifier only when nothing else separates them', () => {
    expect(winner(claim({ assetId: HIGHER_ID }), claim({ assetId: LOWER_ID }))).toEqual({
      id: LOWER_ID,
      rule: 'identifier',
    });
  });
});

describe('resolving a whole contest', () => {
  const tombstone = claim({ assetId: LOWER_ID, deletedAt: '2026-05-23T00:00:00.000Z' });
  const stale = claim({ assetId: HIGHER_ID, indexedAt: '2026-01-01T00:00:00.000Z' });
  const fresh = claim({ assetId: 'c'.repeat(24), indexedAt: '2026-09-01T00:00:00.000Z' });

  it('names one winner and why each other claim lost to it', () => {
    const resolved = resolveContest([tombstone, stale, fresh]);
    expect(resolved.winner.assetId).toBe(fresh.assetId);
    expect(resolved.losers.map((loser) => [loser.claim.assetId, loser.rule])).toEqual([
      [tombstone.assetId, 'entry-liveness'],
      [stale.assetId, 'index-recency'],
    ]);
  });

  it('reaches the same winner whatever order the claims arrive in', () => {
    const orders = [
      [tombstone, stale, fresh],
      [fresh, tombstone, stale],
      [stale, fresh, tombstone],
    ];
    const winners = orders.map((claims) => resolveContest(claims).winner.assetId);
    expect(winners).toEqual([fresh.assetId, fresh.assetId, fresh.assetId]);
  });
});
