// preset-model.spec.ts — golden pins + unit tests for the preset model
// (#1115, spec §10.7).
//
// The load-bearing block is the ENUM_FIELD_VALUES golden pin: the
// generated module erases enum variants to TS union TYPES, so the
// runtime table in preset-model.ts is hand-mirrored — these tests pin it
// to the generated module so it cannot drift (same convention as the
// API-side adjustment-fields golden gate).

import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_RANGES,
  defaultGeneratedAdjustmentModel,
} from '../../generated/adjustment-model.generated';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import {
  ENUM_FIELD_VALUES,
  PRESET_NAME_MAX,
  buildApplyPatch,
  camelToSnakeField,
  capturePresetFields,
  normalizePresetName,
  snakeToCamelField,
} from './preset-model';

const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel() as unknown as Record<
  string,
  number | string | boolean
>;

describe('ENUM_FIELD_VALUES golden pin (vs generated module)', () => {
  it('lists exactly the non-numeric generated fields', () => {
    const expected = Object.keys(GENERATED_DEFAULTS)
      .filter((k) => typeof GENERATED_DEFAULTS[k] === 'string')
      .map(camelToSnakeField)
      .sort();
    expect(Object.keys(ENUM_FIELD_VALUES).sort()).toEqual(expected);
  });

  it('every generated default is a member of its allowed list', () => {
    for (const [snakeKey, allowed] of Object.entries(ENUM_FIELD_VALUES)) {
      const generatedKey = snakeToCamelField(snakeKey);
      expect(allowed).toContain(GENERATED_DEFAULTS[generatedKey]);
    }
  });

  it('variant lists are non-empty and duplicate-free', () => {
    for (const allowed of Object.values(ENUM_FIELD_VALUES)) {
      expect(allowed.length).toBeGreaterThan(0);
      expect(new Set(allowed).size).toBe(allowed.length);
    }
  });
});

describe('camelToSnakeField / snakeToCamelField', () => {
  it('round-trips every generated field name', () => {
    for (const key of Object.keys(GENERATED_DEFAULTS)) {
      expect(snakeToCamelField(camelToSnakeField(key))).toBe(key);
    }
  });

  it('produces the canonical snake_case schema names', () => {
    expect(camelToSnakeField('exposure')).toBe('exposure');
    expect(camelToSnakeField('nrLuminance')).toBe('nr_luminance');
    expect(camelToSnakeField('splitToneShadowHue')).toBe('split_tone_shadow_hue');
    expect(camelToSnakeField('captureSharpeningSigma')).toBe('capture_sharpening_sigma');
  });
});

describe('capturePresetFields', () => {
  it('captures nothing from a default model', () => {
    expect(capturePresetFields(defaultAdjustmentModel())).toEqual({});
  });

  it('captures only the non-default fields, snake_cased', () => {
    const adj = defaultAdjustmentModel();
    adj.exposure = 1.25;
    adj.nrLuminance = 40;
    adj.profile = 'Neutral';
    expect(capturePresetFields(adj)).toEqual({
      exposure: 1.25,
      nr_luminance: 40,
      profile: 'Neutral',
    });
  });

  it('never captures web-only extension fields', () => {
    const adj = defaultAdjustmentModel();
    adj.whiteBalancePreset = 'Daylight'; // not a schema field
    expect(capturePresetFields(adj)).toEqual({});
  });

  it('round-trips through buildApplyPatch onto a default model', () => {
    const adj = defaultAdjustmentModel();
    adj.contrast = -50;
    adj.temperature = 7200;
    adj.highlightRecovery = 'Blend';
    const fields = capturePresetFields(adj);
    expect(buildApplyPatch(fields)).toEqual({
      contrast: -50,
      temperature: 7200,
      highlightRecovery: 'Blend',
    });
  });
});

describe('buildApplyPatch', () => {
  it('maps snake_case keys to generated camelCase keys', () => {
    expect(buildApplyPatch({ nr_color: 10, split_tone_balance: -20 })).toEqual({
      nrColor: 10,
      splitToneBalance: -20,
    });
  });

  it('clamps numeric values to the canonical generated range', () => {
    expect(buildApplyPatch({ exposure: 99 })).toEqual({ exposure: ADJUSTMENT_RANGES.exposure[1] });
    expect(buildApplyPatch({ temperature: 0 })).toEqual({
      temperature: ADJUSTMENT_RANGES.temperature[0],
    });
  });

  it('skips unknown fields, non-finite numbers, and wrong-typed values', () => {
    expect(
      buildApplyPatch({
        future_field: 1, // unknown → skipped
        contrast: NaN, // non-finite → skipped
        exposure: 'bright', // wrong type → skipped
        saturation: -30, // valid → applied
      }),
    ).toEqual({ saturation: -30 });
  });

  it('applies known enum variants and skips unknown ones', () => {
    expect(
      buildApplyPatch({
        profile: 'Neutral',
        wb_method: 'WarpDrive', // not a known variant → skipped
        auto_exposure: 42, // wrong type → skipped
      }),
    ).toEqual({ profile: 'Neutral' });
  });

  /**
   * The retired `AcrMatch` profile (#1722, removed in #2312) is not a known
   * variant, so a preset written by an older client carrying it is skipped
   * rather than applied. The sidecar path migrates it to `Auto` instead
   * (raw-core `xmp/fields.rs`); a preset is a sparse patch, so skipping
   * leaves the target image's own profile untouched, which is the safer
   * of the two for a value that no longer names a real transform.
   */
  it('skips the retired AcrMatch profile', () => {
    expect(buildApplyPatch({ profile: 'AcrMatch', saturation: 10 })).toEqual({ saturation: 10 });
  });

  it('applies every variant listed in ENUM_FIELD_VALUES', () => {
    for (const [snakeKey, allowed] of Object.entries(ENUM_FIELD_VALUES)) {
      const generatedKey = snakeToCamelField(snakeKey);
      for (const variant of allowed) {
        expect(buildApplyPatch({ [snakeKey]: variant })).toEqual({ [generatedKey]: variant });
      }
    }
  });
});

describe('normalizePresetName', () => {
  it('trims and accepts printable names', () => {
    expect(normalizePresetName('  Soft Morning  ')).toBe('Soft Morning');
  });

  it('rejects empty, oversized, and control-character names', () => {
    expect(normalizePresetName('   ')).toBeNull();
    expect(normalizePresetName('x'.repeat(PRESET_NAME_MAX + 1))).toBeNull();
    expect(normalizePresetName('bad\nname')).toBeNull();
    expect(normalizePresetName('x'.repeat(PRESET_NAME_MAX))).toBe('x'.repeat(PRESET_NAME_MAX));
  });
});
