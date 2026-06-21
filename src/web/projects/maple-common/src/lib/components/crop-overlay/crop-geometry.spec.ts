// crop-geometry.spec.ts — unit coverage for the crop/straighten overlay math
// (#638). Mirrors the invariants the Swift `CropGeometry` port asserts so the
// two platforms can't drift on hit-testing, aspect locks, or the straighten
// cover-scale.

import type { Crop } from '../../models/adjustment-model';
import {
  MIN_CROP_FRACTION,
  centeredCropForAspect,
  coverScaleForAngle,
  cropRectToPx,
  fitFootprint,
  hitTestHandle,
  moveCrop,
  pxToNormalized,
  resizeCrop,
} from './crop-geometry';

const IDENTITY: Crop = { top: 0, left: 0, bottom: 1, right: 1, angle: 0 };

describe('crop-geometry', () => {
  describe('fitFootprint', () => {
    it('centers a 3:2 image inside a wider viewport (letterboxed left/right)', () => {
      const fp = fitFootprint(1000, 400, 600, 400);
      expect(fp.height).toBeCloseTo(400, 6);
      expect(fp.width).toBeCloseTo(600, 6);
      expect(fp.left).toBeCloseTo(200, 6);
      expect(fp.top).toBeCloseTo(0, 6);
    });

    it('never upscales past 1:1 CSS', () => {
      const fp = fitFootprint(4000, 4000, 600, 400);
      expect(fp.width).toBeCloseTo(600, 6);
      expect(fp.height).toBeCloseTo(400, 6);
    });
  });

  describe('cropRectToPx / pxToNormalized round-trip', () => {
    it('maps a normalized rect onto the footprint and back', () => {
      const fp = fitFootprint(1000, 400, 600, 400);
      const crop: Crop = { left: 0.25, right: 0.75, top: 0.1, bottom: 0.9, angle: 0 };
      const rect = cropRectToPx(crop, fp);
      expect(rect.x).toBeCloseTo(fp.left + 0.25 * fp.width, 6);
      expect(rect.width).toBeCloseTo(0.5 * fp.width, 6);

      const tl = pxToNormalized(rect.x, rect.y, fp);
      expect(tl.nx).toBeCloseTo(0.25, 6);
      expect(tl.ny).toBeCloseTo(0.1, 6);
    });

    it('clamps points outside the footprint to [0, 1]', () => {
      const fp = fitFootprint(1000, 400, 600, 400);
      const p = pxToNormalized(-50, 99999, fp);
      expect(p.nx).toBe(0);
      expect(p.ny).toBe(1);
    });
  });

  describe('coverScaleForAngle', () => {
    it('is 1 at zero rotation', () => {
      expect(coverScaleForAngle(0, 600, 400)).toBe(1);
    });

    it('grows with the angle and is symmetric in sign', () => {
      const pos = coverScaleForAngle(10, 600, 400);
      const neg = coverScaleForAngle(-10, 600, 400);
      expect(pos).toBeGreaterThan(1);
      expect(pos).toBeCloseTo(neg, 9);
    });

    it('matches the closed form cos|θ| + max(a,1/a)·sin|θ|', () => {
      const a = (10 * Math.PI) / 180;
      const expected = Math.cos(a) + 1.5 * Math.sin(a); // 600/400 = 1.5
      expect(coverScaleForAngle(10, 600, 400)).toBeCloseTo(expected, 9);
    });
  });

  describe('hitTestHandle', () => {
    const rect = { x: 100, y: 100, width: 200, height: 200 };
    it('detects each corner within tolerance', () => {
      expect(hitTestHandle(100, 100, rect, 12)).toBe('tl');
      expect(hitTestHandle(300, 100, rect, 12)).toBe('tr');
      expect(hitTestHandle(100, 300, rect, 12)).toBe('bl');
      expect(hitTestHandle(300, 300, rect, 12)).toBe('br');
    });
    it('detects edges and the interior', () => {
      expect(hitTestHandle(200, 100, rect, 12)).toBe('t');
      expect(hitTestHandle(100, 200, rect, 12)).toBe('l');
      expect(hitTestHandle(200, 200, rect, 12)).toBe('move');
    });
    it('returns null well outside the rect', () => {
      expect(hitTestHandle(10, 10, rect, 12)).toBeNull();
    });
  });

  describe('resizeCrop', () => {
    it('drags the top-left corner without inverting', () => {
      const out = resizeCrop(IDENTITY, 'tl', 0.3, 0.2, { aspect: null, imgW: 600, imgH: 400 });
      expect(out.left).toBeCloseTo(0.3, 6);
      expect(out.top).toBeCloseTo(0.2, 6);
      expect(out.right).toBe(1);
      expect(out.bottom).toBe(1);
    });

    it('enforces the minimum size when a handle crosses the opposite edge', () => {
      const out = resizeCrop(IDENTITY, 'r', 0.0, 0.5, { aspect: null, imgW: 600, imgH: 400 });
      expect(out.right).toBeCloseTo(MIN_CROP_FRACTION, 6); // left(0) + MIN
    });

    it('locks a 1:1 aspect on a corner drag (square image-space rect)', () => {
      const out = resizeCrop(IDENTITY, 'br', 0.5, 0.9, { aspect: 1, imgW: 400, imgH: 400 });
      const w = (out.right - out.left) * 400;
      const h = (out.bottom - out.top) * 400;
      expect(w).toBeCloseTo(h, 4);
    });
  });

  describe('moveCrop', () => {
    it('translates within bounds and clamps at the edge', () => {
      const crop: Crop = { left: 0.1, right: 0.5, top: 0.1, bottom: 0.5, angle: 0 };
      const moved = moveCrop(crop, 0.7, 0);
      expect(moved.right).toBeCloseTo(1, 6);
      expect(moved.left).toBeCloseTo(0.6, 6);
      expect(moved.bottom - moved.top).toBeCloseTo(0.4, 6);
    });
  });

  describe('centeredCropForAspect', () => {
    it('spans full width for a panoramic aspect on a 3:2 image', () => {
      const crop = centeredCropForAspect(2 / 1, 600, 400, 0);
      expect(crop.left).toBeCloseTo(0, 6);
      expect(crop.right).toBeCloseTo(1, 6);
      expect(crop.top).toBeGreaterThan(0);
      const w = (crop.right - crop.left) * 600;
      const h = (crop.bottom - crop.top) * 400;
      expect(w / h).toBeCloseTo(2, 4);
    });

    it('spans full height for a tall aspect', () => {
      const crop = centeredCropForAspect(1 / 2, 600, 400, 0);
      expect(crop.top).toBeCloseTo(0, 6);
      expect(crop.bottom).toBeCloseTo(1, 6);
      const w = (crop.right - crop.left) * 600;
      const h = (crop.bottom - crop.top) * 400;
      expect(w / h).toBeCloseTo(0.5, 4);
    });

    it('preserves the straighten angle', () => {
      const crop = centeredCropForAspect(1, 600, 400, 7.5);
      expect(crop.angle).toBe(7.5);
    });
  });
});
