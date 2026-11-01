import { describe, expect, it } from 'vitest';

import { panoBoundaryWarpReason } from './pano-edges-reason';

const report = (status: string, applied = 0) => ({ boundary_warp: { status, applied } });

describe('panoBoundaryWarpReason', () => {
  it('words each refusal from the design copy', () => {
    expect(panoBoundaryWarpReason(report('refused_disconnected'))).toBe(
      'Not applied: the frames form separate pieces, so the edges stay as stitched.',
    );
    expect(panoBoundaryWarpReason(report('refused_full_wrap'))).toBe(
      'Not applied to 360° panoramas. Auto Crop can still trim the top and bottom.',
    );
    expect(panoBoundaryWarpReason(report('refused_fold'))).toBe(
      'Not applied: warping this shape would fold the image.',
    );
  });

  it('has a line for the rare refusals', () => {
    for (const status of ['refused_empty', 'refused_shape', 'refused_solve']) {
      expect(panoBoundaryWarpReason(report(status))).toMatch(/^Not applied: /);
    }
  });

  it('names the rounded applied strength when the warp was limited', () => {
    expect(panoBoundaryWarpReason(report('clamped_fold', 37.4))).toBe(
      "Limited to 37% so the image doesn't fold.",
    );
  });

  it('shows no reason when the warp took effect, is off, or the status is unknown', () => {
    for (const status of ['off', 'applied', 'refused_from_the_future']) {
      expect(panoBoundaryWarpReason(report(status, 50))).toBeNull();
    }
    expect(panoBoundaryWarpReason(null)).toBeNull();
    expect(panoBoundaryWarpReason(undefined)).toBeNull();
  });
});
