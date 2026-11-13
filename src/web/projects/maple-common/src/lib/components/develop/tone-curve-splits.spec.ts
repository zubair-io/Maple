import { describe, expect, it } from 'vitest';

import {
  activeRegionWindowPath,
  axisToAuthoringX,
  authoringXToAxis,
  clampParametricSplit,
  defaultSplitValue,
  orderedSplits,
  regionCentres,
  regionForSplitHandle,
  regionIndex,
  regionWindows,
} from './tone-curve-splits';

describe('tone-curve-splits (#5039)', () => {
  it('round-trips split values through the logarithmic plot geometry', () => {
    expect(axisToAuthoringX(50)).toBeCloseTo(0.045);
    for (const axis of [10, 25, 50, 75, 90])
      expect(authoringXToAxis(axisToAuthoringX(axis))).toBeCloseTo(axis);
  });

  it('plots region weights on the scene-linear authoring axis', () => {
    const path = activeRegionWindowPath('parametricShadows', 25, 50, 75, 1000, 1000);
    const x = 15 / 1000;
    const p = 50 + 12.5 * Math.log2((x * 4) / 0.18);
    const y = (1000 - regionWindows(p, 25, 50, 75)[0] * 350).toFixed(2);
    expect(path).toContain(`L 15.00 ${y}`);
    expect(path).toContain('L 500.00 1000.00');
  });

  it('keeps interactive values in bounds even when imported neighbors exceed the UI domain', () => {
    expect(clampParametricSplit('highlight', 50, 97, 98, 99)).toBe(90);
    expect(clampParametricSplit('midtone', 50, 97, 98, 99)).toBe(80);
    expect(clampParametricSplit('shadow', 50, 97, 98, 99)).toBe(50);
  });
  it('clamps each handle to its authoring bounds and neighbour margins', () => {
    expect(clampParametricSplit('shadow', 2, 25, 50, 75)).toBe(10);
    expect(clampParametricSplit('shadow', 60, 25, 50, 75)).toBe(45);
    expect(clampParametricSplit('midtone', 20, 25, 50, 75)).toBe(30);
    expect(clampParametricSplit('midtone', 80, 25, 50, 75)).toBe(70);
    expect(clampParametricSplit('highlight', 40, 25, 50, 75)).toBe(55);
    expect(clampParametricSplit('highlight', 98, 25, 50, 75)).toBe(90);
  });

  it('falls back to the default for a non-finite proposal and rounds to whole units', () => {
    expect(clampParametricSplit('shadow', Number.NaN, 25, 50, 75)).toBe(
      defaultSplitValue('shadow'),
    );
    expect(clampParametricSplit('midtone', 41.4, 25, 50, 75)).toBe(41);
    expect(clampParametricSplit('midtone', 41.6, 25, 50, 75)).toBe(42);
  });

  it('never lets handles cross or collapse, whatever the neighbours', () => {
    for (let proposed = -10; proposed <= 110; proposed += 3) {
      const shadow = clampParametricSplit('shadow', proposed, 25, 50, 75);
      const midtone = clampParametricSplit('midtone', proposed, shadow, 50, 75);
      const highlight = clampParametricSplit('highlight', proposed, shadow, midtone, 75);
      expect(midtone - shadow).toBeGreaterThanOrEqual(5);
      expect(highlight - midtone).toBeGreaterThanOrEqual(5);
    }
  });

  it('repairs a hand-edited triplet into strictly ordered coordinates', () => {
    const [s, m, h] = orderedSplits(80, 20, 10);
    expect(s).toBeLessThan(m);
    expect(m).toBeLessThan(h);
    expect(orderedSplits(25, 50, 75)).toEqual([25, 50, 75]);
  });

  it('places the four region centres at the documented positions', () => {
    expect(regionCentres(25, 50, 75)).toEqual([12.5, 37.5, 62.5, 87.5]);
  });

  it('forms a non-negative partition of unity up to the highlights centre', () => {
    const centres = regionCentres(25, 50, 75);
    for (let p = 0; p <= 100; p++) {
      const weights = regionWindows(p, 25, 50, 75);
      weights.forEach((w) => expect(w).toBeGreaterThanOrEqual(-1e-9));
      if (p <= centres[3]) {
        expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      }
    }
  });

  it('shifts the shadows window when the shadow split moves', () => {
    const at30 = (shadow: number) => regionWindows(30, shadow, 50, 75)[0];
    expect(at30(40)).toBeGreaterThan(at30(25) + 0.1);
  });

  it('maps handles and regions to their indices', () => {
    expect(regionIndex(regionForSplitHandle('shadow'))).toBe(0);
    expect(regionIndex(regionForSplitHandle('midtone'))).toBe(1);
    expect(regionIndex(regionForSplitHandle('highlight'))).toBe(3);
  });
});
