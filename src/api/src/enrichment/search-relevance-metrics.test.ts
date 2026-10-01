import { describe, expect, it } from 'bun:test';
import {
  meanReciprocalRank,
  recallAtK,
  reciprocalRank,
  scoreRankings,
} from './search-relevance-metrics.ts';

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
    expect(recallAtK(['a'], [], 10)).toBe(1);
  });

  it('handles an empty result list', () => {
    expect(recallAtK([], ['a'], 10)).toBe(0);
  });
});

describe('scoreRankings', () => {
  const labelled = [
    { ranked: ['a'], relevant: ['a', 'b'] },
    { ranked: ['x', 'c'], relevant: ['c'] },
  ];

  it('does not count report-only observations as misses or successful recall', () => {
    expect(
      scoreRankings([
        ...labelled,
        { ranked: ['unjudged'], relevant: [] },
        { ranked: [], relevant: [] },
      ]),
    ).toEqual({ recallAt10: 0.75, mrr: 0.75, evaluatedQueries: 2 });
  });

  it('still counts a labelled query with no relevant hit as a miss', () => {
    expect(scoreRankings([...labelled, { ranked: ['x'], relevant: ['missing'] }])).toEqual({
      recallAt10: 0.5,
      mrr: 0.5,
      evaluatedQueries: 3,
    });
  });

  it('rejects a corpus with no judged queries', () => {
    expect(() => scoreRankings([{ ranked: ['unjudged'], relevant: [] }])).toThrow(
      'No labelled queries to evaluate',
    );
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
