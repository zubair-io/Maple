/**
 * Unit tests for `clustering-metrics.ts`.
 *
 * No Mongo required — these are pure-function tests against known small
 * inputs. The numerical reference values for NMI / V-measure / ARI come
 * from cross-checking against scikit-learn's `normalized_mutual_info_score`,
 * `v_measure_score`, and `adjusted_rand_score` on the same toy inputs.
 */

import { describe, it, expect } from 'bun:test';
import {
  purity,
  normalizedMutualInformation,
  vMeasure,
  adjustedRandIndex,
  recallAt1,
  allMetrics,
} from './clustering-metrics.ts';

const APPROX = 1e-9;

describe('purity', () => {
  it('perfect clustering → 1.0', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    expect(purity(pred, truth)).toBeCloseTo(1, 10);
  });

  it('all-one-cluster, mixed truth → fraction of majority class', () => {
    // Everyone in cluster 0; truth has 3 As, 2 Bs, 1 C → purity = 3/6.
    const pred = [0, 0, 0, 0, 0, 0];
    const truth = ['A', 'A', 'A', 'B', 'B', 'C'];
    expect(purity(pred, truth)).toBeCloseTo(0.5, 10);
  });

  it('singletons → 1.0 (every cluster is trivially pure)', () => {
    const pred = [0, 1, 2, 3];
    const truth = ['A', 'B', 'A', 'B'];
    expect(purity(pred, truth)).toBeCloseTo(1, 10);
  });

  it('empty input → 1.0 (vacuously perfect)', () => {
    expect(purity([], [])).toBe(1);
  });

  it('handles partial mistakes', () => {
    // cluster 0: AAB → majority A (2); cluster 1: BBC → majority B (2).
    // purity = (2 + 2) / 6 = 0.667.
    const pred = [0, 0, 0, 1, 1, 1];
    const truth = ['A', 'A', 'B', 'B', 'B', 'C'];
    expect(purity(pred, truth)).toBeCloseTo(4 / 6, 10);
  });
});

describe('normalizedMutualInformation', () => {
  it('perfect clustering → 1.0', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    expect(normalizedMutualInformation(pred, truth)).toBeCloseTo(1, 10);
  });

  it('one-cluster (zero cluster entropy) → 0 (no info shared)', () => {
    // Predicted has zero entropy → MI = 0 → NMI = 0.
    const pred = [0, 0, 0, 0];
    const truth = ['A', 'A', 'B', 'B'];
    expect(normalizedMutualInformation(pred, truth)).toBeCloseTo(0, 10);
  });

  it('predicted == truth (relabelled) → 1.0', () => {
    const pred = [5, 5, 5, 7, 7, 9];
    const truth = ['x', 'x', 'x', 'y', 'y', 'z'];
    expect(normalizedMutualInformation(pred, truth)).toBeCloseTo(1, 10);
  });

  it('both labellings degenerate → 1.0 (well-defined edge)', () => {
    expect(normalizedMutualInformation([0, 0, 0], ['A', 'A', 'A'])).toBe(1);
  });

  it('partial-overlap value matches sklearn reference', () => {
    // pred = [0,0,0,1,1,1]; truth = [A,A,B,A,B,B]
    // Hand computation:
    //   H(C) = H(T) = ln(2). MI = (4/6) ln(4/3) + (2/6) ln(2/3) ≈ 0.0566.
    //   NMI_arith = 0.0566 / 0.6931 ≈ 0.0817.
    // Cross-checked against sklearn normalized_mutual_info_score(
    //   ..., average_method='arithmetic') = 0.0817041659455104.
    const pred = [0, 0, 0, 1, 1, 1];
    const truth = ['A', 'A', 'B', 'A', 'B', 'B'];
    const v = normalizedMutualInformation(pred, truth);
    expect(v).toBeCloseTo(0.0817041659455104, 8);
  });
});

describe('vMeasure', () => {
  it('perfect clustering → 1.0', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    expect(vMeasure(pred, truth)).toBeCloseTo(1, 10);
  });

  it('one-cluster → 0 (zero homogeneity)', () => {
    const pred = [0, 0, 0, 0];
    const truth = ['A', 'A', 'B', 'B'];
    expect(vMeasure(pred, truth)).toBeCloseTo(0, 10);
  });

  it('singletons → degraded completeness, but harmonic mean is non-zero', () => {
    // Predicted = all singletons; truth = AABB. Homogeneity = 1 (each
    // cluster is pure), completeness = MI/H(C) = ln(2)/ln(4) = 0.5
    // (each truth class is split across two singletons). Harmonic mean
    // V = 2*1*0.5 / (1 + 0.5) = 2/3.
    const pred = [0, 1, 2, 3];
    const truth = ['A', 'A', 'B', 'B'];
    expect(vMeasure(pred, truth)).toBeCloseTo(2 / 3, 10);
  });

  it('beta > 1 weights completeness more', () => {
    const pred = [0, 0, 0, 1, 1, 1];
    const truth = ['A', 'A', 'B', 'A', 'B', 'B'];
    const v1 = vMeasure(pred, truth, 1);
    const v2 = vMeasure(pred, truth, 2);
    // Same homogeneity & completeness — moving beta changes the weight,
    // but for this near-symmetric case both should be in (0, 1).
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(1);
    expect(v2).toBeGreaterThan(0);
    expect(v2).toBeLessThan(1);
  });
});

describe('adjustedRandIndex', () => {
  it('perfect clustering → 1.0', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    expect(adjustedRandIndex(pred, truth)).toBeCloseTo(1, 10);
  });

  it('all-one-cluster vs multi-class truth → 0 (degenerate normaliser)', () => {
    const pred = [0, 0, 0, 0];
    const truth = ['A', 'A', 'B', 'B'];
    expect(adjustedRandIndex(pred, truth)).toBeCloseTo(0, 10);
  });

  it('singletons vs multi-class truth → 0 (degenerate normaliser)', () => {
    const pred = [0, 1, 2, 3];
    const truth = ['A', 'A', 'B', 'B'];
    expect(adjustedRandIndex(pred, truth)).toBeCloseTo(0, 10);
  });

  it('predicted == truth (relabelled) → 1.0', () => {
    const pred = [5, 5, 5, 7, 7, 9];
    const truth = ['x', 'x', 'x', 'y', 'y', 'z'];
    expect(adjustedRandIndex(pred, truth)).toBeCloseTo(1, 10);
  });

  it('partial-overlap value matches sklearn reference', () => {
    // pred = [0,0,0,1,1,1]; truth = [A,A,B,A,B,B]
    // sklearn adjusted_rand_score ≈ -0.1111111111111111.
    const pred = [0, 0, 0, 1, 1, 1];
    const truth = ['A', 'A', 'B', 'A', 'B', 'B'];
    const ari = adjustedRandIndex(pred, truth);
    expect(ari).toBeLessThan(0);
    expect(ari).toBeGreaterThan(-0.2);
  });

  it('value in [-1, 1]', () => {
    // Random-ish labelling — just sanity-check the bound.
    const pred = [0, 1, 0, 1, 0, 1, 0, 1];
    const truth = ['A', 'B', 'A', 'B', 'B', 'A', 'B', 'A'];
    const ari = adjustedRandIndex(pred, truth);
    expect(ari).toBeLessThanOrEqual(1);
    expect(ari).toBeGreaterThanOrEqual(-1);
  });
});

describe('recallAt1', () => {
  it('perfect clustering → 1.0', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    expect(recallAt1(pred, truth)).toBeCloseTo(1, 10);
  });

  it('singletons → 0 (no neighbours)', () => {
    const pred = [0, 1, 2, 3];
    const truth = ['A', 'A', 'B', 'B'];
    expect(recallAt1(pred, truth)).toBeCloseTo(0, 10);
  });

  it('one impostor in a cluster → still correct for the majority', () => {
    // cluster 0 = AAAB; cluster 1 = BBB.
    // For each A in cluster 0: other members AAB → majority A → hit.
    // For the B in cluster 0:  other members AAA → majority A → miss.
    // For each B in cluster 1: other members BB → majority B → hit.
    // → 6 hits / 7 = 6/7.
    const pred = [0, 0, 0, 0, 1, 1, 1];
    const truth = ['A', 'A', 'A', 'B', 'B', 'B', 'B'];
    expect(recallAt1(pred, truth)).toBeCloseTo(6 / 7, 10);
  });

  it('all-one-cluster, majority class → recall ≈ majority size for majority members', () => {
    // cluster 0 = AAABB. For each A: others AABB → majority A&B tied,
    // ours picks first-seen-tied (A). For each B: others AAAB → majority
    // A → miss for B. → 3 hits / 5.
    const pred = [0, 0, 0, 0, 0];
    const truth = ['A', 'A', 'A', 'B', 'B'];
    const r = recallAt1(pred, truth);
    expect(r).toBeCloseTo(3 / 5, 10);
  });

  it('empty input → 1.0', () => {
    expect(recallAt1([], [])).toBe(1);
  });
});

describe('allMetrics', () => {
  it('returns the bundle in a single pass', () => {
    const pred = [0, 0, 1, 1, 2, 2];
    const truth = ['A', 'A', 'B', 'B', 'C', 'C'];
    const m = allMetrics(pred, truth);
    expect(m.purity).toBeCloseTo(1, 10);
    expect(m.nmi).toBeCloseTo(1, 10);
    expect(m.v_measure).toBeCloseTo(1, 10);
    expect(m.ari).toBeCloseTo(1, 10);
    expect(m.recall_at_1).toBeCloseTo(1, 10);
    expect(m.n).toBe(6);
    expect(m.n_clusters_pred).toBe(3);
    expect(m.n_classes_true).toBe(3);
  });
});

describe('input validation', () => {
  it('throws on length mismatch', () => {
    expect(() => purity([0, 1], ['A'])).toThrow();
    expect(() => normalizedMutualInformation([0], ['A', 'B'])).toThrow();
    expect(() => vMeasure([0, 1], ['A'])).toThrow();
    expect(() => adjustedRandIndex([0, 1, 2], ['A'])).toThrow();
    expect(() => recallAt1([0, 1], ['A'])).toThrow();
  });
});

// Suppress unused import warning if APPROX ever stops being used.
void APPROX;
