// preset-model.spec.ts — golden pins + unit tests for the preset model
// (#1115, spec §10.7).
//
// The load-bearing block is the ENUM_FIELD_VALUES golden pin: the
// generated module erases enum variants to TS union TYPES, so the
// runtime table in preset-model.ts is hand-mirrored — these tests pin it
// to the generated module so it cannot drift (same convention as the
// API-side adjustment-fields golden gate).

import { describe, expect, it } from 'vitest';

import { defaultGeneratedAdjustmentModel } from '../../generated/adjustment-model.generated';
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-tables.generated';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import {
  ENUM_FIELD_VALUES,
  FREE_FORM_STRING_FIELDS,
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
  it('lists exactly the non-numeric, non-free-form generated fields', () => {
    const expected = Object.keys(GENERATED_DEFAULTS)
      .filter((k) => typeof GENERATED_DEFAULTS[k] === 'string')
      .map(camelToSnakeField)
      .filter((snakeKey) => !FREE_FORM_STRING_FIELDS.has(snakeKey))
      .sort();
    expect(Object.keys(ENUM_FIELD_VALUES).sort()).toEqual(expected);
  });

  // Every string-valued generated field is EITHER a known enum (checked
  // above) OR listed in FREE_FORM_STRING_FIELDS — never neither. A field
  // in neither set would silently fall out of ENUM_FIELD_VALUES's coverage
  // without buildApplyPatch's free-form fallback picking it up, exactly
  // the `film_look` gap #2683 introduced (buildApplyPatch dropped it: not
  // numeric, and `ENUM_FIELD_VALUES['film_look']` was undefined).
  it('every string-valued generated field is enum-known or free-form, never neither', () => {
    const stringFields = Object.keys(GENERATED_DEFAULTS)
      .filter((k) => typeof GENERATED_DEFAULTS[k] === 'string')
      .map(camelToSnakeField);
    for (const snakeKey of stringFields) {
      const isEnum = Object.prototype.hasOwnProperty.call(ENUM_FIELD_VALUES, snakeKey);
      const isFreeForm = FREE_FORM_STRING_FIELDS.has(snakeKey);
      expect(isEnum || isFreeForm).toBe(true);
      expect(isEnum && isFreeForm).toBe(false);
    }
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

  /**
   * `film_look` (#2683) is the first free-form string field — no fixed
   * variant list, so it is deliberately absent from `ENUM_FIELD_VALUES`.
   * Before the `FREE_FORM_STRING_FIELDS` fallback, `buildApplyPatch` fell
   * through to the enum branch for every non-numeric field, found no entry
   * in `ENUM_FIELD_VALUES`, and silently dropped the value — this pins the
   * fix, including the case that motivates "resolves to identity" instead
   * of "must be a known variant": an id the current catalog doesn't
   * recognise still applies (raw-core's XMP parser accepts it too).
   */
  it('applies free-form string fields without checking a fixed variant list', () => {
    expect(buildApplyPatch({ film_look: 'color_negative_kodak_portra_400' })).toEqual({
      filmLook: 'color_negative_kodak_portra_400',
    });
    expect(buildApplyPatch({ film_look: 'unreleased_future_catalog_id' })).toEqual({
      filmLook: 'unreleased_future_catalog_id',
    });
    // Wrong-typed value still skipped, same as every other field kind.
    expect(buildApplyPatch({ film_look: 42 })).toEqual({});
  });

  /**
   * The empty string is `film_look`'s own canonical "no look" value (the
   * `AdjustmentModel` default), so a preset that sets `film_look: ''`
   * explicitly clears a previously-applied look rather than being treated
   * as an invalid/missing value — mirrors the API's
   * `FREE_FORM_STRING_FIELDS` / `allowsEmptyString` acceptance in
   * `src/api/src/presets/adjustment-fields.ts`.
   */
  it('applies an empty string for film_look as an explicit clear', () => {
    expect(buildApplyPatch({ film_look: '' })).toEqual({ filmLook: '' });
  });

  it('still skips an empty string for closed-enum string fields', () => {
    expect(buildApplyPatch({ profile: '' })).toEqual({});
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
