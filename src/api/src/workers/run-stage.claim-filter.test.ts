// Claim-query stage filter (`StageConfig.claimFilter`).
//
// Split from `run-stage.test.ts` — that file is at the 600-line hard budget, so
// the new cases live here rather than push it over.

import { describe, expect, it } from 'bun:test';
import type { ObjectId } from 'mongodb';
import { buildClaimQuery } from './run-stage.ts';

describe('buildClaimQuery — claimFilter', () => {
  const noneInFlight = new Set<ObjectId>();

  it('returns the base query unchanged when no claimFilter is given', () => {
    const q = buildClaimQuery('hash', 1, [], noneInFlight) as Record<string, unknown>;
    expect(q['$and']).toBeUndefined();
    expect(q['$or']).toBeDefined();
  });

  it('AND-s a stage claimFilter onto the base query', () => {
    // A stage-scoped predicate (e.g. transcribe's media filename regex) must be
    // merged via $and so it can't clobber the base query's own `fileinfo`/`$or`.
    const claimFilter = { fileinfo: { $elemMatch: { filename: { $regex: /\.mp4$/i } } } };
    const q = buildClaimQuery('transcribe', 1, [], noneInFlight, claimFilter) as Record<
      string,
      unknown
    >;
    const and = q['$and'] as Record<string, unknown>[];
    expect(and).toHaveLength(2);
    // First element is the base query; second is the verbatim claimFilter.
    expect(and[0]!['$or']).toBeDefined();
    expect(and[1]).toBe(claimFilter);
  });
});
