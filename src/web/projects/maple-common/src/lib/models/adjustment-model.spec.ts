// Point-curve model surface (#366) — the hand-written `ToneCurve` type and
// its interaction with the generated defaults + `isDefaultAdjustment`.
//
// The load-bearing invariant: a fresh model carries four IDENTITY curves,
// and identity curves must not read as "edited" — `isDefaultAdjustment`
// gates preview generation and the sidecar write path, so an object-valued
// field compared by reference would mark every asset edited.

import { describe, expect, it } from 'vitest';

import {
  defaultAdjustmentModel,
  defaultToneCurve,
  isDefaultAdjustment,
  isIdentityToneCurve,
  type ToneCurve,
} from './adjustment-model';

const CURVE_KEYS = ['toneCurveLuma', 'toneCurveRed', 'toneCurveGreen', 'toneCurveBlue'] as const;

describe('ToneCurve', () => {
  it('defaults to the identity (empty) curve', () => {
    expect(defaultToneCurve()).toEqual({ points: [] });
    expect(isIdentityToneCurve(defaultToneCurve())).toBe(true);
  });

  it('treats any authored control point as non-identity', () => {
    const curve: ToneCurve = { points: [[0.5, 0.7]] };
    expect(isIdentityToneCurve(curve)).toBe(false);
  });
});

describe('defaultAdjustmentModel tone curves', () => {
  it('carries an identity curve for every channel', () => {
    const m = defaultAdjustmentModel();
    for (const key of CURVE_KEYS) {
      expect(isIdentityToneCurve(m[key])).toBe(true);
    }
  });

  it('hands each caller its own curve objects', () => {
    const a = defaultAdjustmentModel();
    const b = defaultAdjustmentModel();
    for (const key of CURVE_KEYS) {
      expect(a[key]).not.toBe(b[key]);
    }
    a.toneCurveLuma.points.push([0.25, 0.4]);
    expect(b.toneCurveLuma.points).toEqual([]);
  });
});

describe('isDefaultAdjustment with point curves', () => {
  it('is true for a fresh model', () => {
    expect(isDefaultAdjustment(defaultAdjustmentModel())).toBe(true);
  });

  it('stays true when the curves are distinct-but-identity objects', () => {
    const m = { ...defaultAdjustmentModel(), toneCurveRed: { points: [] } };
    expect(isDefaultAdjustment(m)).toBe(true);
  });

  it('is false once any channel curve carries a control point', () => {
    for (const key of CURVE_KEYS) {
      const m = { ...defaultAdjustmentModel(), [key]: { points: [[0.2, 0.3]] } };
      expect(isDefaultAdjustment(m)).toBe(false);
    }
  });
});
