// wb-pad.spec.ts — unit tests for WB pad math (#1540).

import { describe, it, expect } from 'vitest';
import { xToTemp, tempToX, yToTint, tintToY } from './wb-pad-math';

describe('xToTemp / tempToX', () => {
  it('x=0 → 2000 K', () => {
    expect(xToTemp(0)).toBe(2000);
  });

  it('x=1 → 12000 K', () => {
    expect(xToTemp(1)).toBe(12000);
  });

  it('x=0.5 → 7000 K (midpoint)', () => {
    expect(xToTemp(0.5)).toBe(7000);
  });

  it('tempToX is the inverse of xToTemp', () => {
    const t = 5600;
    expect(xToTemp(tempToX(t))).toBe(t);
  });

  it('tempToX(2000) = 0', () => {
    expect(tempToX(2000)).toBeCloseTo(0);
  });

  it('tempToX(12000) = 1', () => {
    expect(tempToX(12000)).toBeCloseTo(1);
  });
});

describe('yToTint / tintToY', () => {
  it('y=0 → -150 (green)', () => {
    expect(yToTint(0)).toBe(-150);
  });

  it('y=1 → +150 (magenta)', () => {
    expect(yToTint(1)).toBe(150);
  });

  it('y=0.5 → 0 (neutral)', () => {
    expect(yToTint(0.5)).toBe(0);
  });

  it('tintToY is the inverse of yToTint', () => {
    const tint = 35;
    expect(yToTint(tintToY(tint))).toBe(tint);
  });
});
