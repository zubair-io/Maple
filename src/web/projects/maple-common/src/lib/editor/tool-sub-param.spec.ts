// tool-sub-param.spec.ts — multi-param tool pills (#1108, spec §10.0).
//
// Pins the sub-param catalog, the generated-schema sourcing, the
// internal↔display mappings (including first-sub-param parity with the
// tool-level mapping, so arming the default sub-param behaves exactly
// like the pre-#1108 single-param pill), and the chip value format.

import { describe, it, expect } from 'vitest';

import {
  defaultSubParamId,
  formatSubParamValue,
  isCommitOnRelease,
  isMultiParam,
  subParamById,
  subParamDefaultDisplay,
  subParamDisplayFromInternal,
  subParamDisplayRange,
  subParamInternalFromDisplay,
  subParamsFor,
} from './tool-sub-param';
import {
  ALL_TOOLS,
  displayValueFromInternal,
  internalValueFromDisplay,
  type ToolId,
} from './tool-model';

describe('sub-param catalog', () => {
  it('noise declares Luminance / Color / Deep / Prefilter (spec §10.0)', () => {
    const subs = subParamsFor('noise');
    expect(subs.map((s) => s.id)).toEqual(['luminance', 'color', 'deep', 'prefilter']);
    expect(subs.map((s) => s.field)).toEqual([
      'nrLuminance',
      'nrColor',
      'deepDenoise',
      'chromaPrefilter',
    ]);
    expect(isMultiParam('noise')).toBe(true);
    expect(defaultSubParamId('noise')).toBe('luminance');
  });

  it('only the decode-product noise tiers commit on release (#1153)', () => {
    // Deep (BM3D) and Prefilter land inside the decoded buffer, so a per-tick
    // write would re-develop; the NLM pair stays on the live per-tick path.
    const deferred = ALL_TOOLS.flatMap((tool) =>
      subParamsFor(tool as ToolId)
        .filter((s) => isCommitOnRelease(s))
        .map((s) => `${tool}.${s.id}`),
    );
    expect(deferred).toEqual(['noise.deep', 'noise.prefilter']);
    expect(isCommitOnRelease(subParamById('noise', 'luminance'))).toBe(false);
    expect(isCommitOnRelease(subParamById('noise', 'color'))).toBe(false);
    expect(isCommitOnRelease(null)).toBe(false);
  });

  it('sharpen declares Amount / Radius / Detail / Masking', () => {
    const subs = subParamsFor('sharpen');
    expect(subs.map((s) => s.id)).toEqual(['amount', 'radius', 'detail', 'masking']);
    expect(subs.map((s) => s.field)).toEqual([
      'sharpenAmount',
      'sharpenRadius',
      'sharpenDetail',
      'sharpenMasking',
    ]);
    expect(defaultSubParamId('sharpen')).toBe('amount');
  });

  it('vignette declares Amount + Feather (#1109)', () => {
    const subs = subParamsFor('vignette');
    expect(subs.map((s) => s.id)).toEqual(['amount', 'feather']);
    expect(subs.map((s) => s.field)).toEqual(['vignetteAmount', 'vignetteFeather']);
    expect(isMultiParam('vignette')).toBe(true);
    expect(defaultSubParamId('vignette')).toBe('amount');
  });

  it('grain declares Amount + Size + Roughness (#1110)', () => {
    const subs = subParamsFor('grain');
    expect(subs.map((s) => s.id)).toEqual(['amount', 'size', 'roughness']);
    expect(subs.map((s) => s.field)).toEqual(['grainAmount', 'grainSize', 'grainRoughness']);
    expect(isMultiParam('grain')).toBe(true);
    expect(defaultSubParamId('grain')).toBe('amount');
  });

  it('splitTone declares Balance + the hue/sat pairs (#1111)', () => {
    const subs = subParamsFor('splitTone');
    expect(subs.map((s) => s.id)).toEqual([
      'balance',
      'shadowHue',
      'shadowSat',
      'highlightHue',
      'highlightSat',
    ]);
    expect(subs.map((s) => s.field)).toEqual([
      'splitToneBalance',
      'splitToneShadowHue',
      'splitToneShadowSaturation',
      'splitToneHighlightHue',
      'splitToneHighlightSaturation',
    ]);
    expect(isMultiParam('splitTone')).toBe(true);
    // Balance leads — the schema-declared primary drag-bar field.
    expect(defaultSubParamId('splitTone')).toBe('balance');
  });

  it('hsl declares Hue/Sat/Lum × 8 bands in order (#1112)', () => {
    const subs = subParamsFor('hsl');
    expect(subs).toHaveLength(24);
    // IDs: hue row first, then sat, then lum; within each row Red → Magenta.
    expect(subs.map((s) => s.id)).toEqual([
      'hueRed',
      'hueOrange',
      'hueYellow',
      'hueGreen',
      'hueAqua',
      'hueBlue',
      'huePurple',
      'hueMagenta',
      'satRed',
      'satOrange',
      'satYellow',
      'satGreen',
      'satAqua',
      'satBlue',
      'satPurple',
      'satMagenta',
      'lumRed',
      'lumOrange',
      'lumYellow',
      'lumGreen',
      'lumAqua',
      'lumBlue',
      'lumPurple',
      'lumMagenta',
    ]);
    expect(subs.map((s) => s.field)).toEqual([
      'hueAdjustmentRed',
      'hueAdjustmentOrange',
      'hueAdjustmentYellow',
      'hueAdjustmentGreen',
      'hueAdjustmentAqua',
      'hueAdjustmentBlue',
      'hueAdjustmentPurple',
      'hueAdjustmentMagenta',
      'saturationAdjustmentRed',
      'saturationAdjustmentOrange',
      'saturationAdjustmentYellow',
      'saturationAdjustmentGreen',
      'saturationAdjustmentAqua',
      'saturationAdjustmentBlue',
      'saturationAdjustmentPurple',
      'saturationAdjustmentMagenta',
      'luminanceAdjustmentRed',
      'luminanceAdjustmentOrange',
      'luminanceAdjustmentYellow',
      'luminanceAdjustmentGreen',
      'luminanceAdjustmentAqua',
      'luminanceAdjustmentBlue',
      'luminanceAdjustmentPurple',
      'luminanceAdjustmentMagenta',
    ]);
    expect(isMultiParam('hsl')).toBe(true);
    expect(defaultSubParamId('hsl')).toBe('hueRed');
  });

  it('every other tool is single-param (crop pending its own spec)', () => {
    for (const tool of ALL_TOOLS) {
      if (
        tool === 'noise' ||
        tool === 'sharpen' ||
        tool === 'vignette' ||
        tool === 'grain' ||
        tool === 'splitTone' ||
        tool === 'hsl' // HSL wired at #1112: 24 sub-params
      )
        continue;
      expect(subParamsFor(tool as ToolId)).toEqual([]);
      expect(isMultiParam(tool as ToolId)).toBe(false);
      expect(defaultSubParamId(tool as ToolId)).toBeNull();
    }
  });

  it('subParamById resolves only declared ids', () => {
    expect(subParamById('sharpen', 'radius')?.field).toBe('sharpenRadius');
    expect(subParamById('sharpen', 'luminance')).toBeNull();
    expect(subParamById('exposure', 'amount')).toBeNull();
  });
});

describe('ranges + defaults (sourced from the generated schema)', () => {
  it('pins ranges to ADJUSTMENT_RANGES', () => {
    expect(subParamDisplayRange(subParamById('noise', 'luminance')!)).toEqual([0, 100]);
    expect(subParamDisplayRange(subParamById('noise', 'color')!)).toEqual([0, 100]);
    expect(subParamDisplayRange(subParamById('noise', 'deep')!)).toEqual([0, 100]);
    expect(subParamDisplayRange(subParamById('noise', 'prefilter')!)).toEqual([0, 100]);
    expect(subParamDisplayRange(subParamById('sharpen', 'amount')!)).toEqual([0, 150]);
    expect(subParamDisplayRange(subParamById('sharpen', 'radius')!)).toEqual([0.5, 3]);
    expect(subParamDisplayRange(subParamById('sharpen', 'detail')!)).toEqual([0, 100]);
    expect(subParamDisplayRange(subParamById('sharpen', 'masking')!)).toEqual([0, 100]);
  });

  it('pins defaults to the generated model defaults', () => {
    expect(subParamDefaultDisplay(subParamById('noise', 'luminance')!)).toBe(0);
    expect(subParamDefaultDisplay(subParamById('noise', 'color')!)).toBe(25);
    // Both new tiers ship OFF (spec § 3.1 / § 3.2 default 0).
    expect(subParamDefaultDisplay(subParamById('noise', 'deep')!)).toBe(0);
    expect(subParamDefaultDisplay(subParamById('noise', 'prefilter')!)).toBe(0);
    expect(subParamDefaultDisplay(subParamById('sharpen', 'amount')!)).toBe(40);
    expect(subParamDefaultDisplay(subParamById('sharpen', 'radius')!)).toBe(1);
    expect(subParamDefaultDisplay(subParamById('sharpen', 'detail')!)).toBe(25);
    expect(subParamDefaultDisplay(subParamById('sharpen', 'masking')!)).toBe(0);
  });
});

describe('internal ↔ display mapping', () => {
  it('anchored sub-params pivot on the canonical default (amount = 40)', () => {
    const amount = subParamById('sharpen', 'amount')!;
    expect(subParamDisplayFromInternal(amount, 0)).toBe(40);
    expect(subParamDisplayFromInternal(amount, 100)).toBe(150);
    expect(subParamDisplayFromInternal(amount, -100)).toBe(0);
    expect(subParamInternalFromDisplay(amount, 40)).toBe(0);
    expect(subParamInternalFromDisplay(amount, 150)).toBe(100);
    expect(subParamInternalFromDisplay(amount, 0)).toBe(-100);
  });

  it('radius pivots on its 1.0 px default across 0.5..3.0', () => {
    const radius = subParamById('sharpen', 'radius')!;
    expect(subParamDisplayFromInternal(radius, 0)).toBe(1.0);
    expect(subParamDisplayFromInternal(radius, 100)).toBe(3.0);
    expect(subParamDisplayFromInternal(radius, -100)).toBe(0.5);
    expect(subParamInternalFromDisplay(radius, 1.0)).toBe(0);
    expect(subParamInternalFromDisplay(radius, 3.0)).toBe(100);
    expect(subParamInternalFromDisplay(radius, 0.5)).toBe(-100);
  });

  it('linear sub-params map lo..hi affinely onto -100..+100', () => {
    const detail = subParamById('sharpen', 'detail')!;
    expect(subParamDisplayFromInternal(detail, -100)).toBe(0);
    expect(subParamDisplayFromInternal(detail, 0)).toBe(50);
    expect(subParamDisplayFromInternal(detail, 100)).toBe(100);
    expect(subParamInternalFromDisplay(detail, 25)).toBe(-50);
  });

  it('FIRST sub-param mapping equals the tool-level mapping (pre-#1108 parity)', () => {
    // Arming the default sub-param must behave exactly like the
    // single-param pill did: noise ≡ nrLuminance, sharpen ≡ sharpenAmount.
    const lum = subParamById('noise', 'luminance')!;
    const amount = subParamById('sharpen', 'amount')!;
    for (const v of [-100, -50, -7, 0, 13, 50, 100]) {
      expect(subParamDisplayFromInternal(lum, v)).toBeCloseTo(
        displayValueFromInternal('noise', v),
        9,
      );
      expect(subParamDisplayFromInternal(amount, v)).toBeCloseTo(
        displayValueFromInternal('sharpen', v),
        9,
      );
    }
    for (const d of [0, 10, 25, 40, 99.5, 100]) {
      expect(subParamInternalFromDisplay(lum, d)).toBeCloseTo(
        internalValueFromDisplay('noise', d),
        9,
      );
      expect(subParamInternalFromDisplay(amount, d)).toBeCloseTo(
        internalValueFromDisplay('sharpen', d),
        9,
      );
    }
  });

  it('round-trips internal → display → internal for every declared sub-param', () => {
    for (const tool of ['noise', 'sharpen'] as const) {
      for (const sub of subParamsFor(tool)) {
        for (const v of [-100, -50, 0, 50, 100]) {
          const d = subParamDisplayFromInternal(sub, v);
          expect(subParamInternalFromDisplay(sub, d)).toBeCloseTo(v, 6);
        }
      }
    }
  });
});

describe('formatSubParamValue (chip text)', () => {
  it('one-sided ranges format unsigned (spec §10.0 "FEATHER · 35")', () => {
    expect(formatSubParamValue(subParamById('sharpen', 'detail')!, 35)).toBe('35');
    expect(formatSubParamValue(subParamById('noise', 'color')!, 25)).toBe('25');
    expect(formatSubParamValue(subParamById('sharpen', 'amount')!, 40)).toBe('40');
  });

  it('radius shows one decimal ("RADIUS · 1.0")', () => {
    expect(formatSubParamValue(subParamById('sharpen', 'radius')!, 1)).toBe('1.0');
    expect(formatSubParamValue(subParamById('sharpen', 'radius')!, 2.34)).toBe('2.3');
  });

  it('rounds and never emits a negative zero', () => {
    expect(formatSubParamValue(subParamById('sharpen', 'masking')!, 49.6)).toBe('50');
    expect(formatSubParamValue(subParamById('sharpen', 'radius')!, -0.04)).toBe('0.0');
  });
});
