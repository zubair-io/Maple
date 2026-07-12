// Tests the GPU live-session fast-path gate (#1914): which models the 19-scalar
// `render_with_params` path can faithfully render, and which must route through
// the full `render(xmp)` path so their edits aren't silently dropped.

import { describe, it, expect } from 'vitest';

import { canUseLiveFastPath, buildLiveParams } from './image-canvas.live-params';
import {
  type AdjustmentModel,
  type Crop,
  defaultAdjustmentModel,
} from '../../models/adjustment-model';

// A model whose only non-scalar chain sliders are at the stripped prefix's zeros
// (sharpen + color NR off) — the baseline on which the fast path IS faithful.
function fastPathBaseline(): AdjustmentModel {
  return { ...defaultAdjustmentModel(), sharpenAmount: 0, nrColor: 0 };
}

const NON_IDENTITY_CROP: Crop = { top: 0.1, left: 0.1, bottom: 0.9, right: 0.9, angle: 0 };

describe('canUseLiveFastPath (#1914)', () => {
  it('rejects the DEFAULT model — its sharpenAmount=40 / nrColor=25 cannot survive the prefix-zeroing fast path', () => {
    // This is the crux of #1914: the stripped develop prefix zeroes sharpen + color
    // NR, but their model defaults are non-zero, so `render_with_params` would drop
    // the default sharpening/NR on every scalar drag. Such a model must use render(xmp).
    expect(canUseLiveFastPath(defaultAdjustmentModel())).toBe(false);
  });

  it('accepts a model with sharpen + color NR explicitly zeroed and no other edits', () => {
    expect(canUseLiveFastPath(fastPathBaseline())).toBe(true);
  });

  it('accepts pure 19-scalar edits (exposure/contrast/…/grain) on that baseline', () => {
    const m: AdjustmentModel = {
      ...fastPathBaseline(),
      exposure: 1.5,
      contrast: 30,
      highlights: -20,
      clarity: 40,
      grainAmount: 10,
      vignetteAmount: -25,
    };
    expect(canUseLiveFastPath(m)).toBe(true);
  });

  it('accepts a custom white-balance edit (temperature/tint ride the params array)', () => {
    const m: AdjustmentModel = {
      ...fastPathBaseline(),
      whiteBalancePreset: 'Custom',
      temperature: 5000,
      tint: 12,
    };
    expect(canUseLiveFastPath(m)).toBe(true);
  });

  // Every non-scalar edit the fast path can't carry must route to render(xmp).
  it('rejects an HSL edit', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), hueAdjustmentRed: 10 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), saturationAdjustmentBlue: -30 })).toBe(
      false,
    );
    expect(canUseLiveFastPath({ ...fastPathBaseline(), luminanceAdjustmentGreen: 15 })).toBe(false);
  });

  it('rejects a split-tone edit', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), splitToneBalance: 30 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), splitToneShadowSaturation: 20 })).toBe(
      false,
    );
  });

  it('rejects a parametric tone-curve edit', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), parametricHighlights: 40 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), parametricShadows: -25 })).toBe(false);
  });

  it('rejects a sharpen edit (any of the four sharpen sub-params)', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), sharpenAmount: 60 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), sharpenRadius: 2 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), sharpenDetail: 50 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), sharpenMasking: 30 })).toBe(false);
  });

  it('rejects a noise-reduction edit', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), nrLuminance: 20 })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), nrColor: 40 })).toBe(false);
  });

  it('rejects a profile change', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), profile: 'Neutral' })).toBe(false);
  });

  it('rejects tone-curve-mode, WB-method and highlight-recovery changes', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), toneCurveMode: 'RatioPreserving' })).toBe(
      false,
    );
    expect(canUseLiveFastPath({ ...fastPathBaseline(), wbMethod: 'DiagonalRec2020' })).toBe(false);
    expect(canUseLiveFastPath({ ...fastPathBaseline(), highlightRecovery: 'Off' })).toBe(false);
  });

  it('rejects a non-identity crop', () => {
    expect(canUseLiveFastPath({ ...fastPathBaseline(), crop: NON_IDENTITY_CROP })).toBe(false);
  });
});

describe('buildLiveParams (#1914)', () => {
  it('packs the 19 scalar fields in the wasm ABI order', () => {
    const m: AdjustmentModel = {
      ...fastPathBaseline(),
      whiteBalancePreset: 'Custom',
      exposure: 1,
      brightness: 2,
      contrast: 3,
      highlights: 4,
      shadows: 5,
      whites: 6,
      blacks: 7,
      vibrance: 8,
      saturation: 9,
      temperature: 5200,
      tint: 11,
      clarity: 12,
      texture: 13,
      dehaze: 14,
      vignetteAmount: 15,
      vignetteFeather: 16,
      grainAmount: 17,
      grainSize: 18,
      grainRoughness: 19,
    };
    const p = buildLiveParams(m);
    expect(Array.from(p)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 5200, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it('sends the identity WB pair (6500/0) for an As-Shot model, not the seeded slider values (#1892)', () => {
    const m: AdjustmentModel = {
      ...fastPathBaseline(),
      whiteBalancePreset: 'As Shot',
      temperature: 4800, // camera As-Shot slider seed — must NOT be sent as an edit
      tint: -20,
    };
    const p = buildLiveParams(m);
    expect(p[9]).toBe(6500);
    expect(p[10]).toBe(0);
  });
});
