import { describe, it, expect } from 'vitest';
import { COLOR_CURVE_EDITOR } from '../../generated/adjustment-model.generated';
import type { ToneCurvePoint } from '../../models/adjustment-model';
import {
  COLOR_CURVES,
  clampColorCurveX,
  clampColorCurveY,
  evaluateColorCurve,
  insertColorCurveAnchor,
  lockSkinToneCurve,
  sampleXForCurve,
} from './color-curves-math';

describe('color-curves-math (#5077)', () => {
  it('caps skin guards while updating existing knots on a full curve', () => {
    for (const count of [14, 15, 16]) {
      const points: ToneCurvePoint[] = Array.from({ length: count }, (_, i) => [
        0.3 + i * 0.04,
        0.6,
      ]);
      const result = lockSkinToneCurve(COLOR_CURVES[1], { points });
      expect(result.points).toHaveLength(COLOR_CURVE_EDITOR.maxKnots);
      for (const point of points) expect(result.points).toContainEqual(point);
    }
    const points: ToneCurvePoint[] = Array.from({ length: 16 }, (_, i) => [0.3 + i * 0.04, 0.6]);
    points[0] = [55 / 360, 0.8];
    const result = lockSkinToneCurve(COLOR_CURVES[1], { points });
    expect(result.points).toHaveLength(16);
    expect(result.points).toContainEqual([55 / 360, 0.5]);
  });

  it('keeps a first sampled correction local, including across the hue seam', () => {
    for (const desc of COLOR_CURVES) {
      const center = desc.isPeriodic ? 0.98 : 0.5;
      const curve = insertColorCurveAnchor({ points: [] }, center, 0.7, desc.isPeriodic);
      expect(curve.points).toHaveLength(3);
      expect(evaluateColorCurve(desc, center, curve.points)).toBeCloseTo(0.7);
      expect(evaluateColorCurve(desc, 0.25, curve.points)).toBeCloseTo(0.5);
      expect(evaluateColorCurve(desc, 0.7, curve.points)).toBeCloseTo(0.5);
    }
  });

  it('keeps periodic endpoint handles separated around the hue seam', () => {
    const hue = COLOR_CURVES[1];
    const left: ToneCurvePoint[] = [
      [0, 0.5],
      [0.7, 0.7],
    ];
    expect(clampColorCurveX(hue, 1, left, 1)).toBeCloseTo(0.985);
    const right: ToneCurvePoint[] = [
      [0.3, 0.5],
      [1, 0.7],
    ];
    expect(clampColorCurveX(hue, 0, right, 0)).toBeCloseTo(0.015);
    const anchored = insertColorCurveAnchor({ points: left }, 1, 0.6, true);
    expect(anchored.points.filter(([x]) => x === 0 || x === 1)).toEqual([[0, 0.6]]);
  });
  it('Lock Skin Tone places neutral guard knots at 38, 55, and 72 degrees on Hue curves', () => {
    const hvh = COLOR_CURVES.find((c) => c.id === 'hueVsHue')!;
    const locked = lockSkinToneCurve(hvh, { points: [] });
    expect(locked.points).toHaveLength(3);
    expect(locked.points[0][0]).toBeCloseTo(38 / 360, 5);
    expect(locked.points[1][0]).toBeCloseTo(55 / 360, 5);
    expect(locked.points[2][0]).toBeCloseTo(72 / 360, 5);
    for (const p of locked.points) {
      expect(p[1]).toBeCloseTo(0.5, 5);
    }

    const lvs = COLOR_CURVES.find((c) => c.id === 'lumaVsSat')!;
    expect(lockSkinToneCurve(lvs, { points: [] }).points).toHaveLength(0);
  });

  it('Hue vs Hue non-folding drag clamp limits slope between adjacent knots', () => {
    const hvh = COLOR_CURVES.find((c) => c.id === 'hueVsHue')!;
    const pts: ToneCurvePoint[] = [
      [0.5, 0.5],
      [0.54, 0.5],
    ];
    expect(clampColorCurveY(hvh, 0.54, 0.95, pts, 1)).toBeCloseTo(0.6, 5);
    expect(clampColorCurveY(hvh, 0.54, 0.05, pts, 1)).toBeCloseTo(0.4, 5);

    const hvs = COLOR_CURVES.find((c) => c.id === 'hueVsSat')!;
    expect(clampColorCurveY(hvs, 0.54, 0.95, pts, 1)).toBeCloseTo(0.95, 5);
  });

  it('evaluates periodic Hue spline seamlessly across x = 0 / 1 and maps stage-input samples', () => {
    const hvh = COLOR_CURVES.find((c) => c.id === 'hueVsHue')!;
    const pts: ToneCurvePoint[] = [
      [180 / 360, 0.5],
      [350 / 360, 0.85],
    ];
    const left = evaluateColorCurve(hvh, 359.5 / 360, pts);
    const right = evaluateColorCurve(hvh, 0.5 / 360, pts);
    expect(Math.abs(left - right)).toBeLessThan(0.015);

    const sample = { uH: 0.7, uC: 0.4, uL: 0.6, l: 0.65, c: 0.128, hueDeg: 252 };
    expect(sampleXForCurve(hvh, sample)).toBeCloseTo(0.7, 5);
    const lvs = COLOR_CURVES.find((c) => c.id === 'lumaVsSat')!;
    expect(sampleXForCurve(lvs, sample)).toBeCloseTo(0.6, 5);
    const svs = COLOR_CURVES.find((c) => c.id === 'satVsSat')!;
    expect(sampleXForCurve(svs, sample)).toBeCloseTo(0.4, 5);

    const anchored = insertColorCurveAnchor({ points: [] }, sample.uH, 0.5);
    expect(anchored.points).toHaveLength(3);
    expect(anchored.points).toContainEqual([0.7, 0.5]);
  });
});
