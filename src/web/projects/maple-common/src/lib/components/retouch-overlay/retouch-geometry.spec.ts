// retouch-geometry.spec.ts — the heal overlay's pure geometry (#3409).

import { describe, expect, it } from 'vitest';
import { makeMaskCanvasMap } from '../mask-overlay/mask-geometry';
import type { RetouchSpot } from '../../models/retouch-spot';
import {
  defaultRetouchSource,
  dragRetouchHandle,
  hitTestRetouchHandle,
  retouchHandles,
  retouchPointToScreen,
  retouchRadiusPx,
} from './retouch-geometry';

const footprint = { left: 100, top: 50, width: 600, height: 400 };
const identityCrop = { top: 0, left: 0, bottom: 1, right: 1, angle: 0 };
const map = makeMaskCanvasMap(footprint, identityCrop, 3000, 2000);

const spot: RetouchSpot = {
  kind: 'heal',
  center: { x: 0.25, y: 0.5 },
  source: { x: 0.75, y: 0.5 },
  radius: 0.05,
  feather: 0.5,
  opacity: 1,
};

describe('retouchHandles', () => {
  it('lists the destination first, then the source', () => {
    expect(retouchHandles(spot).map((h) => h.handle)).toEqual(['destination', 'source']);
    expect(retouchHandles(spot)[0].point).toEqual(spot.center);
    expect(retouchHandles(spot)[1].point).toEqual(spot.source);
  });
});

describe('retouchPointToScreen / retouchRadiusPx', () => {
  it('places a point at its fraction of the footprint', () => {
    const s = retouchPointToScreen(map, spot.center);
    expect(s.x).toBeCloseTo(footprint.left + 0.25 * footprint.width, 6);
    expect(s.y).toBeCloseTo(footprint.top + 0.5 * footprint.height, 6);
  });

  it('measures the radius along x, so the disc is a circle in pixels', () => {
    // radius is a fraction of the image WIDTH, and the footprint is the
    // whole frame here, so 0.05 → 5 % of 600 px.
    expect(retouchRadiusPx(map, spot)).toBeCloseTo(0.05 * footprint.width, 6);
  });
});

describe('hitTestRetouchHandle', () => {
  it('grabs the destination inside its disc', () => {
    const s = retouchPointToScreen(map, spot.center);
    expect(hitTestRetouchHandle(s.x + 4, s.y, spot, map, 14)).toBe('destination');
  });

  it('grabs the source inside its disc', () => {
    const s = retouchPointToScreen(map, spot.source);
    expect(hitTestRetouchHandle(s.x, s.y + 4, spot, map, 14)).toBe('source');
  });

  it('misses well outside both discs', () => {
    expect(hitTestRetouchHandle(footprint.left, footprint.top, spot, map, 14)).toBeNull();
  });

  it('never grabs less than the tolerance, even for a tiny spot', () => {
    const tiny: RetouchSpot = { ...spot, radius: 0.0005 };
    const s = retouchPointToScreen(map, tiny.center);
    expect(hitTestRetouchHandle(s.x + 10, s.y, tiny, map, 14)).toBe('destination');
  });
});

describe('dragRetouchHandle', () => {
  it('dragging the destination carries the source, preserving the sampled offset', () => {
    const moved = dragRetouchHandle(spot, 'destination', { x: 0.35, y: 0.6 }, { x: 0.25, y: 0.5 });
    expect(moved.center).toEqual({ x: 0.35, y: 0.6 });
    expect(moved.source.x).toBeCloseTo(0.85, 6);
    expect(moved.source.y).toBeCloseTo(0.6, 6);
  });

  it('dragging the source moves it alone', () => {
    const moved = dragRetouchHandle(spot, 'source', { x: 0.65, y: 0.4 }, { x: 0.75, y: 0.5 });
    expect(moved.center).toEqual(spot.center);
    expect(moved.source.x).toBeCloseTo(0.65, 6);
    expect(moved.source.y).toBeCloseTo(0.4, 6);
  });

  it('clamps a drag that would leave the frame', () => {
    const moved = dragRetouchHandle(spot, 'source', { x: 1.4, y: -0.3 }, { x: 0.75, y: 0.5 });
    expect(moved.source).toEqual({ x: 1, y: 0 });
  });
});

describe('defaultRetouchSource', () => {
  it('samples to the right of the destination', () => {
    expect(defaultRetouchSource({ x: 0.2, y: 0.5 }, 0.05)).toEqual({ x: 0.275, y: 0.5 });
  });

  it('mirrors to the left when the right would leave the frame', () => {
    expect(defaultRetouchSource({ x: 0.98, y: 0.5 }, 0.05).x).toBeCloseTo(0.905, 6);
  });
});
