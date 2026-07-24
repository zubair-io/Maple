// wb-pad.spec.ts — unit tests for WB pad math (#1540).

import { describe, it, expect } from 'vitest';
import { xToTemp, tempToX, yToTint, tintToY, rgbToWb } from './wb-pad-math';

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

describe('rgbToWb', () => {
  it('neutral grey (128,128,128) → tint near 0', () => {
    const { temperature, tint } = rgbToWb(128, 128, 128);
    expect(temperature).toBeGreaterThanOrEqual(2000);
    expect(temperature).toBeLessThanOrEqual(12000);
    // Math.log(128/128) = 0, so tint = -0 or 0 — both indicate neutral
    expect(Math.abs(tint)).toBeLessThanOrEqual(1);
  });

  it('red-dominant sample → LOWER corrective temperature (#1568)', () => {
    // Derivation: Maple's temp slider warms the render as its value goes UP
    // (Lightroom semantics), pinned by the closed-form grey predictors
    // `temp_warmer_makes_r_gt_b` / `temp_cooler_makes_b_gt_r` in
    // src/raw-pipeline/raw-core/tests/grey_adjustments.rs:306-346. A
    // red-dominant sample (R>G) is a pixel the CURRENT WB is rendering too
    // warm, so the eyedropper's corrective temperature must be LOWER than a
    // blue-dominant sample's, to cool the render back to neutral — the
    // opposite of what a naive "redder = higher CCT" reading would produce.
    const { temperature: redSampleTemp } = rgbToWb(180, 128, 80);
    const { temperature: blueSampleTemp } = rgbToWb(80, 128, 180);
    expect(redSampleTemp).toBeLessThan(blueSampleTemp);
  });

  it('clamps output within valid ranges', () => {
    const { temperature, tint } = rgbToWb(255, 1, 1);
    expect(temperature).toBeLessThanOrEqual(12000);
    expect(temperature).toBeGreaterThanOrEqual(2000);
    expect(tint).toBeLessThanOrEqual(150);
    expect(tint).toBeGreaterThanOrEqual(-150);
  });
});
