import { describe, it, expect } from 'vitest';
import type { ToneCurvePoint } from '../../models/adjustment-model';
import {
  COLOR_CURVES,
  clampColorCurveY,
  evaluateColorCurve,
  insertColorCurveAnchor,
  lockSkinToneCurve,
  sampleXForCurve,
} from './color-curves-math';

describe('color-curves-math (#5077)', () => {
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
    expect(anchored.points).toEqual([[0.7, 0.5]]);
  });
});
