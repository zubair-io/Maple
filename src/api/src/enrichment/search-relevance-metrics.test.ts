import { describe, expect, it } from 'bun:test';
import { meanReciprocalRank, recallAtK, reciprocalRank } from './search-relevance-metrics.ts';

describe('recallAtK', () => {
  it('is the fraction of relevant docs found in the top k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1);
    expect(recallAtK(['a', 'x', 'y'], ['a', 'c'], 3)).toBe(0.5);
    expect(recallAtK(['x', 'y', 'a'], ['a'], 2)).toBe(0);
  });

  it('only counts hits inside the cutoff', () => {
    expect(recallAtK(['x', 'x', 'x', 'a'], ['a'], 3)).toBe(0);
    expect(recallAtK(['x', 'x', 'x', 'a'], ['a'], 4)).toBe(1);
  });

  it('is 1 when nothing is labelled relevant (vacuously satisfied)', () => {
    // Unlabelled corpus entries — e.g. the `Rose` observation owned by
    // #2386 — must not drag the aggregate down.
    expect(recallAtK(['a'], [], 10)).toBe(1);
  });

  it('handles an empty result list', () => {
    expect(recallAtK([], ['a'], 10)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('is 1/rank of the first relevant hit', () => {
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
    expect(reciprocalRank(['x', 'b'], ['b'])).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'c'], ['c'])).toBeCloseTo(1 / 3, 10);
  });

  it('is 0 when no relevant document appears', () => {
    expect(reciprocalRank(['x'], ['a'])).toBe(0);
    expect(reciprocalRank([], ['a'])).toBe(0);
  });
});

describe('meanReciprocalRank', () => {
  it('averages 1/rank of the first relevant hit', () => {
    expect(
      meanReciprocalRank([
        { ranked: ['a', 'b'], relevant: ['a'] },
        { ranked: ['x', 'b'], relevant: ['b'] },
      ]),
    ).toBeCloseTo(0.75, 10);
  });

  it('scores a query with no relevant hit as 0', () => {
    expect(meanReciprocalRank([{ ranked: ['x'], relevant: ['a'] }])).toBe(0);
  });

  it('is 0 for an empty evaluation set', () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});
