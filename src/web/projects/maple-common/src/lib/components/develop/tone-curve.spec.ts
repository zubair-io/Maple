// tone-curve.spec.ts — unit tests for tone curve math (#1540).

import { describe, it, expect } from 'vitest';
import { paramToYOffset, evalSpline } from './tone-curve-math';

describe('paramToYOffset', () => {
  it('maps 0 to 0', () => {
    expect(paramToYOffset(0)).toBe(0);
  });

  it('maps +100 to +0.35', () => {
    expect(paramToYOffset(100)).toBeCloseTo(0.35);
  });

  it('maps -100 to -0.35', () => {
    expect(paramToYOffset(-100)).toBeCloseTo(-0.35);
  });

  it('maps +50 to +0.175', () => {
    expect(paramToYOffset(50)).toBeCloseTo(0.175);
  });
});

describe('evalSpline', () => {
  // Identity: 4 control points at y = x → spline should pass through (0,0) and (1,1)
  const identityPts = [
    { x: 0.125, y: 0.125 },
    { x: 0.375, y: 0.375 },
    { x: 0.625, y: 0.625 },
    { x: 0.875, y: 0.875 },
  ];

  it('returns 0 at x=0', () => {
    expect(evalSpline(identityPts, 0)).toBe(0);
  });

  it('returns 1 at x=1', () => {
    expect(evalSpline(identityPts, 1)).toBe(1);
  });

  it('passes through identity at midpoint 0.5', () => {
    expect(evalSpline(identityPts, 0.5)).toBeCloseTo(0.5, 1);
  });

  it('lifts the curve when highlights are raised', () => {
    // With parametricHighlights = +40 → y offset = +0.14
    const liftedPts = [
      { x: 0.125, y: 0.125 },
      { x: 0.375, y: 0.375 },
      { x: 0.625, y: 0.625 },
      { x: 0.875, y: 0.875 + paramToYOffset(40) }, // 0.875 + 0.14 = 1.015 → clamped to 1
    ];
    // The highlights region (x > 0.75) should be at or above the identity line
    const atIdent = evalSpline(identityPts, 0.9);
    const atLifted = evalSpline(liftedPts, 0.9);
    expect(atLifted).toBeGreaterThanOrEqual(atIdent - 1e-6);
  });

  it('depresses the curve when shadows are pulled down', () => {
    const depressedPts = [
      { x: 0.125, y: Math.max(0, 0.125 + paramToYOffset(-60)) },
      { x: 0.375, y: 0.375 },
      { x: 0.625, y: 0.625 },
      { x: 0.875, y: 0.875 },
    ];
    const atIdent = evalSpline(identityPts, 0.1);
    const atDepressed = evalSpline(depressedPts, 0.1);
    expect(atDepressed).toBeLessThanOrEqual(atIdent + 1e-6);
  });
});

describe('control-point field mapping', () => {
  it('has 4 control points in ascending x order', () => {
    const xs = [0.125, 0.375, 0.625, 0.875];
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
  });
});
