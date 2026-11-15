import { describe, expect, it } from 'vitest';
import { seamDragRect, seamPoint, validSeamCanvas, validSeamRect } from './pano-seam-geometry';

const canvas = { width: 1000, height: 400 };

describe('panorama seam geometry', () => {
  it('maps actual image bounds, not letterboxed container bounds, and clamps captured drags', () => {
    const bounds = { left: 20, top: 30, width: 500, height: 200 };
    expect(seamPoint({ x: 70, y: 80 }, bounds, canvas)).toEqual({ x: 100, y: 100 });
    expect(seamPoint({ x: -10, y: 900 }, bounds, canvas)).toEqual({ x: 0, y: 400 });
    expect(seamPoint({ x: 0, y: 0 }, { ...bounds, width: 0 }, canvas)).toBeNull();
  });

  it('rounds start down and end up independent of drag direction', () => {
    const start = { x: 12.3, y: 20.1 };
    const end = { x: 101.2, y: 80.8 };
    const rect = { x: 12, y: 20, width: 90, height: 61 };
    expect(seamDragRect(start, end, canvas)).toEqual(rect);
    expect(seamDragRect(end, start, canvas)).toEqual(rect);
    expect(seamDragRect(start, start, canvas)).toBeNull();
  });

  it('rejects invalid canvases and nonintegral, empty or overflowing rectangles', () => {
    expect(validSeamCanvas({ width: 0, height: 4 })).toBe(false);
    expect(validSeamCanvas({ width: 0x100000000, height: 4 })).toBe(false);
    expect(validSeamRect({ x: 0, y: 0, width: 1000, height: 400 }, canvas)).toBe(true);
    for (const rect of [
      { x: -1, y: 0, width: 2, height: 2 },
      { x: 0, y: 0, width: 0, height: 2 },
      { x: 999, y: 0, width: 2, height: 2 },
      { x: 0.5, y: 0, width: 2, height: 2 },
      { x: 0, y: 0, width: Number.NaN, height: 2 },
    ])
      expect(validSeamRect(rect, canvas)).toBe(false);
  });
});
