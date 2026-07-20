import { describe, it, expect } from 'bun:test';
import {
  computeMergeSuggestions,
  sortedPairKey,
  type SuggestionCandidate,
} from './people-merge-suggestions.ts';

function unit(personIdHex: string, direction: number[], hidden = false): SuggestionCandidate {
  const norm = Math.sqrt(direction.reduce((s, v) => s + v * v, 0));
  return {
    personIdHex,
    centroid: Float32Array.from(direction.map((v) => v / norm)),
    hidden,
  };
}

describe('sortedPairKey', () => {
  it('is direction-independent and lexicographically ordered', () => {
    expect(sortedPairKey('aaa', 'bbb')).toBe('aaa:bbb');
    expect(sortedPairKey('bbb', 'aaa')).toBe('aaa:bbb');
  });
});

describe('computeMergeSuggestions', () => {
  it('suggests a mutual match for two identical centroids above threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [1, 0]);
    const result = computeMergeSuggestions([a, b], new Set());
    expect(result).toEqual([
      { personIdHex: 'a', candidates: [{ suggestedPersonIdHex: 'b', score: 1 }] },
      { personIdHex: 'b', candidates: [{ suggestedPersonIdHex: 'a', score: 1 }] },
    ]);
  });

  it('omits a person whose best score is below the default threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [0, 1]); // orthogonal, cosine similarity 0
    expect(computeMergeSuggestions([a, b], new Set())).toEqual([]);
  });

  it('ranks every qualifying candidate best-first, not just the closest', () => {
    const subject = unit('subject', [1, 0]);
    const far = unit('far', [0.8, 0.6]); // cos(subject, far) = 0.8
    const near = unit('near', [0.99, Math.sqrt(1 - 0.99 * 0.99)]); // cos ~ 0.99
    const result = computeMergeSuggestions([subject, far, near], new Set());
    const forSubject = result.find((r) => r.personIdHex === 'subject');
    // Both clear the threshold, so both are kept — the runner-up is what the
    // banner advances to once the best one is dismissed or merged.
    expect(forSubject?.candidates.map((c) => c.suggestedPersonIdHex)).toEqual(['near', 'far']);
  });

  it('caps the ranked list at `limit`, keeping the highest scorers', () => {
    const subject = unit('subject', [1, 0]);
    // Four qualifying candidates, descending similarity.
    const others = [0.99, 0.95, 0.9, 0.85].map((cos, i) =>
      unit(`o${i}`, [cos, Math.sqrt(1 - cos * cos)]),
    );
    const result = computeMergeSuggestions([subject, ...others], new Set(), 0.65, 2);
    const forSubject = result.find((r) => r.personIdHex === 'subject');
    expect(forSubject?.candidates.map((c) => c.suggestedPersonIdHex)).toEqual(['o0', 'o1']);
  });

  it('excludes hidden people as both subject and candidate', () => {
    const a = unit('a', [1, 0]);
    const hiddenB = unit('hidden', [1, 0], true);
    expect(computeMergeSuggestions([a, hiddenB], new Set())).toEqual([]);
  });

  it('excludes a dismissed pair even when it scores above threshold', () => {
    const a = unit('a', [1, 0]);
    const b = unit('b', [1, 0]);
    const dismissed = new Set([sortedPairKey('a', 'b')]);
    expect(computeMergeSuggestions([a, b], dismissed)).toEqual([]);
  });

  it('drops only the dismissed candidate, keeping the rest of the ranking', () => {
    const subject = unit('subject', [1, 0]);
    const near = unit('near', [0.99, Math.sqrt(1 - 0.99 * 0.99)]);
    const far = unit('far', [0.8, 0.6]);
    const dismissed = new Set([sortedPairKey('subject', 'near')]);
    const result = computeMergeSuggestions([subject, near, far], dismissed);
    const forSubject = result.find((r) => r.personIdHex === 'subject');
    expect(forSubject?.candidates.map((c) => c.suggestedPersonIdHex)).toEqual(['far']);
  });

  it('returns no suggestions for a single person or an empty list', () => {
    expect(computeMergeSuggestions([], new Set())).toEqual([]);
    expect(computeMergeSuggestions([unit('solo', [1, 0])], new Set())).toEqual([]);
  });

  it('respects a custom threshold override', () => {
    const a = unit('a', [1, 0]);
    const c = unit('c', [0.6, 0.8]); // cos(a, c) = 0.6 — below default 0.65
    expect(computeMergeSuggestions([a, c], new Set())).toEqual([]);
    const result = computeMergeSuggestions([a, c], new Set(), 0.5);
    expect(result).toHaveLength(2);
    expect(result[0].candidates[0].suggestedPersonIdHex).toBe('c');
    expect(result[0].candidates[0].score).toBeCloseTo(0.6, 5);
  });
});
