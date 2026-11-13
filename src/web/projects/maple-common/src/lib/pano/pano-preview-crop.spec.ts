import { describe, it, expect } from 'vitest';
import type { PanoEdgesReport } from '../api/pano.service';
import { panoPreviewCrop } from './pano-preview-crop';

const report = (rect: PanoEdgesReport['auto_crop']['rect']): PanoEdgesReport => ({
  output: { width: 2000, height: 800 },
  uncovered_px: 0,
  boundary_warp: {
    requested: 0,
    applied: 0,
    status: 'off',
    max_stretch: null,
    min_jacobian: null,
    predicted_coverage: null,
    solve_ms: null,
  },
  auto_crop: { requested: true, rect, invalid_px: rect ? 0 : null },
});

describe('panoPreviewCrop', () => {
  it('places the whole image inside a frame of the rectangle', () => {
    const crop = panoPreviewCrop(report({ x: 200, y: 80, width: 1000, height: 400 }));
    expect(crop).toEqual({
      ratio: 2.5,
      frameWidth: 'min(100%, calc(min(240px, 26vh) * 2.5))',
      imageWidthPercent: 200,
      imageLeftPercent: -20,
      imageTopPercent: -20,
    });
  });

  it('keeps a full wrapping axis whole', () => {
    const crop = panoPreviewCrop(report({ x: 0, y: 100, width: 2000, height: 600 }));
    expect(crop?.imageWidthPercent).toBe(100);
    expect(crop?.imageLeftPercent).toBeCloseTo(0);
  });

  it('shows nothing without a rectangle, for the whole image, or for one outside it', () => {
    expect(panoPreviewCrop(null)).toBeNull();
    expect(panoPreviewCrop(report(null))).toBeNull();
    expect(panoPreviewCrop(report({ x: 0, y: 0, width: 2000, height: 800 }))).toBeNull();
    expect(panoPreviewCrop(report({ x: 1500, y: 0, width: 1000, height: 800 }))).toBeNull();
  });
});
