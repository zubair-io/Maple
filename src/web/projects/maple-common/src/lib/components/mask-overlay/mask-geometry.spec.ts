// mask-geometry.spec.ts — the overlay's pure geometry (#1541), pinned at the
// same analytic points the Apple `MaskWeightTests` / `MaskRemapTests` /
// `MaskGeometryTests` check so the two platforms can't drift.

import { describe, expect, it } from 'vitest';
import type { LocalMask } from '../../models/local-adjustment';
import {
  applyAffine,
  cropToFullFrameAffine,
  defaultRadialMask,
  dragMaskHandle,
  ellipseOutline,
  evaluateMaskWeight,
  hitTestMaskHandle,
  invertAffine,
  makeMaskCanvasMap,
  maskFromScreen,
  maskHandles,
  maskToScreen,
  MIN_RADIUS,
  ROTATE_HANDLE_FACTOR,
} from './mask-geometry';

const footprint = { left: 100, top: 50, width: 600, height: 400 };
const identityCrop = { top: 0, left: 0, bottom: 1, right: 1, angle: 0 };

describe('evaluateMaskWeight', () => {
  const hardLinear: LocalMask = {
    kind: 'linear',
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
    feather: 0,
  };
  const softLinear: LocalMask = { ...hardLinear, feather: 1 };

  it('hard linear is a step at the midpoint', () => {
    expect(evaluateMaskWeight(hardLinear, 0.25, 0.5)).toBe(0);
    expect(evaluateMaskWeight(hardLinear, 0.75, 0.5)).toBe(1);
  });

  it('full-feather linear is a smoothstep across the whole length', () => {
    expect(evaluateMaskWeight(softLinear, 0, 0.5)).toBe(0);
    expect(evaluateMaskWeight(softLinear, 1, 0.5)).toBe(1);
    expect(evaluateMaskWeight(softLinear, 0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(evaluateMaskWeight(softLinear, 0.25, 0.5)).toBeCloseTo(0.15625, 12);
  });

  it('degenerate linear weighs zero everywhere', () => {
    const mask: LocalMask = { ...hardLinear, start: { x: 0.5, y: 0.5 }, end: { x: 0.5, y: 0.5 } };
    expect(evaluateMaskWeight(mask, 0.9, 0.9)).toBe(0);
  });

  it('radial feather falls off from the inner radius to the boundary, invert flips it', () => {
    const mask: LocalMask = {
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.4, y: 0.4 },
      angle: 0,
      feather: 0.5,
      invert: false,
    };
    expect(evaluateMaskWeight(mask, 0.7, 0.5)).toBeCloseTo(1, 12);
    expect(evaluateMaskWeight(mask, 0.8, 0.5)).toBeCloseTo(0.5, 12);
    expect(evaluateMaskWeight(mask, 0.9, 0.5)).toBeCloseTo(0, 12);
    expect(evaluateMaskWeight({ ...mask, invert: true }, 0.7, 0.5)).toBeCloseTo(0, 12);
  });

  it('radial rotation turns the ellipse in normalized space', () => {
    const mask: LocalMask = {
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.4, y: 0.1 },
      angle: Math.PI / 2,
      feather: 0,
      invert: false,
    };
    expect(evaluateMaskWeight(mask, 0.5, 0.85)).toBe(1);
    expect(evaluateMaskWeight(mask, 0.85, 0.5)).toBe(0);
  });
});

describe('crop affine map', () => {
  it('is identity for the identity crop', () => {
    expect(cropToFullFrameAffine(identityCrop, 6000, 4000)).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 0,
      ty: 0,
    });
  });

  it('maps the crop corners onto the crop rect', () => {
    const m = cropToFullFrameAffine(
      { top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 0 },
      6000,
      4000,
    );
    const origin = applyAffine(m, { x: 0, y: 0 });
    const far = applyAffine(m, { x: 1, y: 1 });
    expect(origin.x).toBeCloseTo(0.2, 12);
    expect(origin.y).toBeCloseTo(0.1, 12);
    expect(far.x).toBeCloseTo(0.9, 12);
    expect(far.y).toBeCloseTo(0.7, 12);
  });

  it('inverts exactly, straighten angle included', () => {
    const m = cropToFullFrameAffine(
      { top: 0.1, left: 0.2, bottom: 0.7, right: 0.9, angle: 7 },
      6000,
      4000,
    );
    const inv = invertAffine(m)!;
    const p = { x: 0.37, y: 0.81 };
    const back = applyAffine(inv, applyAffine(m, p));
    expect(back.x).toBeCloseTo(p.x, 12);
    expect(back.y).toBeCloseTo(p.y, 12);
  });
});

describe('canvas map', () => {
  it('round-trips a point at fit', () => {
    const map = makeMaskCanvasMap(footprint, identityCrop, 6000, 4000);
    const px = maskToScreen(map, { x: 0.25, y: 0.75 });
    expect(px).toEqual({ x: 250, y: 350 });
    const back = maskFromScreen(map, px.x, px.y);
    expect(back.x).toBeCloseTo(0.25, 12);
    expect(back.y).toBeCloseTo(0.75, 12);
  });

  it('clamps screen points to the frame', () => {
    const map = makeMaskCanvasMap(footprint, identityCrop, 6000, 4000);
    expect(maskFromScreen(map, -500, 9000)).toEqual({ x: 0, y: 1 });
  });

  it('places a full-frame point relative to an applied crop', () => {
    const map = makeMaskCanvasMap(
      footprint,
      { top: 0.25, left: 0.5, bottom: 0.75, right: 1, angle: 0 },
      6000,
      4000,
    );
    const px = maskToScreen(map, { x: 0.5, y: 0.25 });
    expect(px.x).toBeCloseTo(100, 9);
    expect(px.y).toBeCloseTo(50, 9);
    const back = maskFromScreen(map, 700, 450);
    expect(back.x).toBeCloseTo(1, 9);
    expect(back.y).toBeCloseTo(0.75, 9);
  });
});

describe('handles', () => {
  const linear: LocalMask = {
    kind: 'linear',
    start: { x: 0.2, y: 0.2 },
    end: { x: 0.6, y: 0.8 },
    feather: 0.5,
  };

  it('linear handles are the endpoints and the midpoint', () => {
    const handles = maskHandles(linear);
    expect(handles.map((h) => h.handle)).toEqual(['linearStart', 'linearEnd', 'linearBody']);
    expect(handles[2].point).toEqual({ x: 0.4, y: 0.5 });
  });

  it('radial handles follow the rotation', () => {
    const mask: LocalMask = {
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.2, y: 0.1 },
      angle: Math.PI / 2,
      feather: 0.5,
      invert: false,
    };
    const h = Object.fromEntries(maskHandles(mask).map((e) => [e.handle, e.point]));
    expect(h['radialRadiusX'].x).toBeCloseTo(0.5, 12);
    expect(h['radialRadiusX'].y).toBeCloseTo(0.7, 12);
    expect(h['radialRadiusY'].x).toBeCloseTo(0.4, 12);
    expect(h['radialRotate'].y).toBeCloseTo(0.5 + 0.2 * ROTATE_HANDLE_FACTOR, 12);
  });

  it('hit-test prefers endpoints over the body and misses empty space', () => {
    const map = makeMaskCanvasMap(footprint, identityCrop, 6000, 4000);
    const tiny: LocalMask = { ...linear, start: { x: 0.5, y: 0.5 }, end: { x: 0.52, y: 0.5 } };
    const s = maskToScreen(map, { x: 0.5, y: 0.5 });
    expect(hitTestMaskHandle(s.x, s.y, tiny, map, 14)).toBe('linearStart');
    expect(hitTestMaskHandle(0, 0, tiny, map, 14)).toBeNull();
  });

  it('dragging the body translates both endpoints', () => {
    const moved = dragMaskHandle(linear, 'linearBody', { x: 0.5, y: 0.4 }, { x: 0.4, y: 0.5 });
    if (moved.kind !== 'linear') throw new Error('shape changed');
    expect(moved.start.x).toBeCloseTo(0.3, 12);
    expect(moved.start.y).toBeCloseTo(0.1, 12);
    expect(moved.end.x).toBeCloseTo(0.7, 12);
    expect(moved.end.y).toBeCloseTo(0.7, 12);
    expect(moved.feather).toBe(0.5);
  });

  it('dragging the body stops at the frame edge instead of leaving [0, 1]', () => {
    const moved = dragMaskHandle(linear, 'linearBody', { x: 0.95, y: 0.05 }, { x: 0.4, y: 0.5 });
    if (moved.kind !== 'linear') throw new Error('shape changed');
    // +0.55 in x is capped at +0.4 (end.x reaches 1); −0.45 in y at −0.2 (start.y reaches 0).
    expect(moved.end.x).toBeCloseTo(1, 12);
    expect(moved.start.x).toBeCloseTo(0.6, 12);
    expect(moved.start.y).toBeCloseTo(0, 12);
    expect(moved.end.y).toBeCloseTo(0.6, 12);
  });

  it('a radius handle projects onto the local axis with a floor; rotation sets the angle', () => {
    const mask: LocalMask = {
      kind: 'radial',
      center: { x: 0.5, y: 0.5 },
      radii: { x: 0.2, y: 0.1 },
      angle: 0,
      feather: 0.5,
      invert: true,
    };
    const wider = dragMaskHandle(mask, 'radialRadiusX', { x: 0.9, y: 0.7 }, { x: 0.7, y: 0.5 });
    expect(wider.kind === 'radial' && wider.radii.x).toBeCloseTo(0.4, 12);
    const collapsed = dragMaskHandle(mask, 'radialRadiusY', { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 });
    expect(collapsed.kind === 'radial' && collapsed.radii.y).toBe(MIN_RADIUS);
    const rotated = dragMaskHandle(mask, 'radialRotate', { x: 0.5, y: 0.9 }, { x: 0.76, y: 0.5 });
    expect(rotated.kind === 'radial' && rotated.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(rotated.kind === 'radial' && rotated.invert).toBe(true);
  });

  it('default radial is a circle on screen; the outline stays on the ellipse', () => {
    const mask = defaultRadialMask(1.5);
    expect(mask.kind === 'radial' && mask.radii.y / mask.radii.x).toBeCloseTo(1.5, 12);
    const center = { x: 0.5, y: 0.5 };
    const radii = { x: 0.3, y: 0.1 };
    for (const p of ellipseOutline(center, radii, 0.4, 24)) {
      const inside: LocalMask = {
        kind: 'radial',
        center,
        radii: { x: radii.x * 1.01, y: radii.y * 1.01 },
        angle: 0.4,
        feather: 0,
        invert: false,
      };
      const outside: LocalMask = { ...inside, radii: { x: radii.x * 0.99, y: radii.y * 0.99 } };
      expect(evaluateMaskWeight(inside, p.x, p.y)).toBe(1);
      expect(evaluateMaskWeight(outside, p.x, p.y)).toBe(0);
    }
  });
});
