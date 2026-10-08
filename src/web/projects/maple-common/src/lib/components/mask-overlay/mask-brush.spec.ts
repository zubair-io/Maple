// mask-brush.spec.ts — the brush rasterizer, stroke capture and digest (#360).
//
// The rasterizer vectors mirror `raw-core/src/types/local_adjustment/brush.rs`
// one-for-one (same dabs, same grids, same expected bytes): the TypeScript
// port and the Rust reference must stamp identically, since the overlay tint
// (this file) previews what the render (that file) applies.

import { describe, it, expect } from 'vitest';

import type { BrushDab } from '../../models/local-adjustment';
import {
  StrokeSmoother,
  appendedBrushDigest,
  applyPressure,
  brushDigest,
  brushRasterDims,
  defaultBrushMask,
  flattenBrushDabs,
  interpolateDabs,
  rasterizeBrushDabs,
} from './mask-brush';

const dab = (
  x: number,
  y: number,
  radius: number,
  feather: number,
  weight: number,
  erase: boolean,
): BrushDab => ({ center: { x, y }, radius, feather, weight, erase });

const at = (bytes: Uint8ClampedArray, w: number, x: number, y: number): number => bytes[y * w + x];

describe('rasterizeBrushDabs', () => {
  it('peaks at the dab weight on its centre texel', () => {
    const bytes = rasterizeBrushDabs([dab(0.5, 0.5, 0.2, 0.5, 0.6, false)], 101, 101);
    expect(at(bytes, 101, 50, 50)).toBe(Math.round(0.6 * 255));
  });

  it('stamps a hard disc with no falloff', () => {
    const bytes = rasterizeBrushDabs([dab(0.5, 0.5, 0.1, 0, 1, false)], 101, 101);
    expect(at(bytes, 101, 40, 50)).toBe(255);
    expect(at(bytes, 101, 60, 50)).toBe(255);
    expect(at(bytes, 101, 39, 50)).toBe(0);
    expect(at(bytes, 101, 61, 50)).toBe(0);
  });

  it('rolls feather off monotonically to the edge', () => {
    const bytes = rasterizeBrushDabs([dab(0.5, 0.5, 0.2, 1, 1, false)], 101, 101);
    const row = Array.from({ length: 22 }, (_, i) => at(bytes, 101, 50 + i, 50));
    expect(row[0]).toBe(255);
    expect(row[row.length - 1]).toBe(0);
    expect(row.every((v, i) => i === 0 || row[i - 1] >= v)).toBe(true);
  });

  it('accumulates overlapping paint dabs like flow', () => {
    const one = dab(0.5, 0.5, 0.2, 0, 0.5, false);
    const bytes = rasterizeBrushDabs([one, one], 101, 101);
    expect(at(bytes, 101, 50, 50)).toBe(Math.round(0.75 * 255));
  });

  it('erases what paint laid down', () => {
    const bytes = rasterizeBrushDabs(
      [dab(0.5, 0.5, 0.2, 0, 1, false), dab(0.5, 0.5, 0.2, 0, 1, true)],
      101,
      101,
    );
    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
  });

  it('scales accumulation on a partial erase', () => {
    const bytes = rasterizeBrushDabs(
      [dab(0.5, 0.5, 0.2, 0, 1, false), dab(0.5, 0.5, 0.2, 0, 0.5, true)],
      101,
      101,
    );
    expect(at(bytes, 101, 50, 50)).toBe(Math.round(0.5 * 255));
  });

  it('stays zero for an empty series or an empty grid', () => {
    expect(Array.from(rasterizeBrushDabs([], 64, 64)).every((b) => b === 0)).toBe(true);
    expect(rasterizeBrushDabs([dab(0.5, 0.5, 0.2, 0.5, 1, false)], 0, 64).length).toBe(0);
  });

  it('clips off-image dabs', () => {
    const bytes = rasterizeBrushDabs([dab(-0.5, -0.5, 0.8, 0.5, 1, false)], 51, 51);
    expect(at(bytes, 51, 0, 0)).toBeGreaterThan(0);
    const far = rasterizeBrushDabs([dab(9, 9, 0.1, 0, 1, false)], 51, 51);
    expect(Array.from(far).every((b) => b === 0)).toBe(true);
  });

  it('treats radius as a fraction of the grid width', () => {
    const wide = rasterizeBrushDabs([dab(0.5, 0.5, 0.05, 0, 1, false)], 200, 100);
    const narrow = rasterizeBrushDabs([dab(0.5, 0.5, 0.05, 0, 1, false)], 100, 100);
    expect(at(wide, 200, 110, 50)).toBe(0);
    expect(at(wide, 200, 109, 50)).toBe(255);
    expect(at(narrow, 100, 55, 50)).toBe(0);
    expect(at(narrow, 100, 54, 50)).toBe(255);
  });

  it('skips degenerate dabs', () => {
    const bytes = rasterizeBrushDabs(
      [
        dab(0.5, 0.5, 0, 0.5, 1, false),
        dab(0.5, 0.5, 0.2, 0.5, 0, false),
        dab(NaN, 0.5, 0.2, 0.5, 1, false),
        dab(0.5, 0.5, Infinity, 0.5, 1, false),
      ],
      51,
      51,
    );
    expect(Array.from(bytes).every((b) => b === 0)).toBe(true);
  });
});

describe('stroke capture', () => {
  it('stamps one dab for a tap', () => {
    const dabs = interpolateDabs({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 1.5, {
      radius: 0.05,
      feather: 0.5,
      weight: 0.8,
      erase: false,
    });
    expect(dabs).toHaveLength(1);
    expect(dabs[0].center).toEqual({ x: 0.5, y: 0.5 });
  });

  it('spaces dabs along a drag without re-stamping the anchor', () => {
    const dabs = interpolateDabs({ x: 0.1, y: 0.5 }, { x: 0.2, y: 0.5 }, 1, {
      radius: 0.05,
      feather: 0.5,
      weight: 0.8,
      erase: false,
    });
    // 0.1 wide in width-fractions at 0.0125 spacing → 8 dabs, ending on `to`.
    expect(dabs).toHaveLength(8);
    expect(dabs[0].center.x).toBeCloseTo(0.1125, 9);
    expect(dabs[7].center).toEqual({ x: 0.2, y: 0.5 });
  });

  it('measures segment length in width-fractions, not normalized units', () => {
    const wide = interpolateDabs({ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.2 }, 2, {
      radius: 0.05,
      feather: 0.5,
      weight: 0.8,
      erase: false,
    });
    // 0.1 of height at aspect 2 is 0.05 of width → 4 dabs, not 8.
    expect(wide).toHaveLength(4);
  });

  it('smooths jitter but converges on a held point', () => {
    const smoother = new StrokeSmoother();
    smoother.reset({ x: 0, y: 0 });
    const first = smoother.next({ x: 1, y: 0 });
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(1);
    let held = first;
    for (let i = 0; i < 50; i++) held = smoother.next({ x: 1, y: 0 });
    expect(held.x).toBeCloseTo(1, 6);
  });

  it('maps pressure onto radius and weight, with 0 reading as full', () => {
    expect(applyPressure(0.1, 0.8, 1)).toEqual({ radius: 0.1, weight: 0.8 });
    expect(applyPressure(0.1, 0.8, 0)).toEqual({ radius: 0.1, weight: 0.8 });
    const light = applyPressure(0.1, 0.8, 0.2);
    expect(light.radius).toBeCloseTo(0.06, 9);
    expect(light.weight).toBeCloseTo(0.32, 9);
  });
});

describe('brush registration helpers', () => {
  it('builds an empty unresolved brush mask', () => {
    expect(defaultBrushMask()).toEqual({ kind: 'brush', dabs: [], digest: '', rasterId: 0 });
  });

  it('sizes rasters at the 1024 long edge', () => {
    expect(brushRasterDims(6000, 4000)).toEqual([1024, 682]);
    expect(brushRasterDims(4000, 6000)).toEqual([682, 1024]);
    expect(brushRasterDims(0, 0)).toEqual([1024, 1024]);
  });

  it('mints a stable 16-hex digest per dab content', () => {
    const dabs = [dab(0.5, 0.5, 0.05, 0.5, 1, false)];
    const digest = brushDigest(dabs);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(brushDigest(dabs)).toBe(digest);
    expect(brushDigest([dab(0.51, 0.5, 0.05, 0.5, 1, false)])).not.toBe(digest);
  });

  it('extends a digest incrementally to the whole-series digest', () => {
    const first = [dab(0.5, 0.5, 0.05, 0.5, 1, false), dab(0.52, 0.5, 0.05, 0.5, 1, false)];
    const added = [dab(0.54, 0.5, 0.05, 0.5, 1, true)];
    const mask = { kind: 'brush' as const, dabs: first, digest: brushDigest(first), rasterId: 0 };
    expect(appendedBrushDigest(mask, added)).toBe(brushDigest([...first, ...added]));
    const empty = { kind: 'brush' as const, dabs: [], digest: '', rasterId: 0 };
    expect(appendedBrushDigest(empty, added)).toBe(brushDigest(added));
    const foreign = { ...mask, digest: '0123456789abcdef' };
    expect(appendedBrushDigest(foreign, added)).toMatch(/^[0-9a-f]{16}$/);
    expect(appendedBrushDigest(foreign, added)).not.toBe(foreign.digest);
  });

  it('flattens dabs onto the six-float wire in field order', () => {
    const wire = flattenBrushDabs([
      dab(0.5, 0.25, 0.05, 0.5, 0.75, false),
      dab(0.1, 0.9, 0.02, 0, 1, true),
    ]);
    expect(wire).toEqual(
      new Float32Array([0.5, 0.25, 0.05, 0.5, 0.75, 0, 0.1, 0.9, 0.02, 0, 1, 1]),
    );
  });

  it('drops unpaintable dabs instead of poisoning the upload', () => {
    const wire = flattenBrushDabs([
      dab(Number.NaN, 0.5, 0.05, 0.5, 1, false),
      dab(0.5, 0.5, 0, 0.5, 1, false),
      dab(0.5, 0.5, 0.05, Number.NaN, 0.8, false),
      dab(0.5, 0.5, 0.05, 0.5, Number.POSITIVE_INFINITY, false),
      dab(0.5, 0.5, 0.05, 0.5, 1, false),
    ]);
    expect(wire).toHaveLength(6);
    expect(wire[0]).toBeCloseTo(0.5, 5);
  });
});
