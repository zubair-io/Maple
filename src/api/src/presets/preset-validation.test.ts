/** Unit tests for preset document validation (#1115). Pure — no DB. */

import { describe, expect, it } from 'bun:test';
import {
  PRESET_FIELDS_MAX,
  PRESET_NAME_MAX,
  isMongoSafeKey,
  validatePresetDocument,
  validatePresetFields,
  validatePresetName,
} from './preset-validation.ts';

describe('validatePresetName', () => {
  it('trims and accepts a normal name', () => {
    expect(validatePresetName('  Flat  ')).toEqual({ name: 'Flat' });
  });

  it('rejects empty / whitespace-only names', () => {
    expect(validatePresetName('')).toHaveProperty('error');
    expect(validatePresetName('   ')).toHaveProperty('error');
  });

  it('rejects non-strings', () => {
    expect(validatePresetName(42)).toHaveProperty('error');
    expect(validatePresetName(null)).toHaveProperty('error');
  });

  it('rejects names over the length cap', () => {
    expect(validatePresetName('x'.repeat(PRESET_NAME_MAX))).toEqual({
      name: 'x'.repeat(PRESET_NAME_MAX),
    });
    expect(validatePresetName('x'.repeat(PRESET_NAME_MAX + 1))).toHaveProperty('error');
  });

  it('rejects control characters but allows spaces', () => {
    expect(validatePresetName('Good Name')).toEqual({ name: 'Good Name' });
    expect(validatePresetName('bad\tname')).toHaveProperty('error');
    expect(validatePresetName('bad\nname')).toHaveProperty('error');
  });
});

describe('validatePresetFields', () => {
  it('accepts known numeric fields within range', () => {
    expect(validatePresetFields({ contrast: -50, temperature: 5500 })).toEqual({
      fields: { contrast: -50, temperature: 5500 },
    });
  });

  it('rejects known numeric fields out of range', () => {
    expect(validatePresetFields({ contrast: -101 })).toHaveProperty('error');
    expect(validatePresetFields({ temperature: 1999 })).toHaveProperty('error');
    expect(validatePresetFields({ exposure: 4.5 })).toHaveProperty('error');
  });

  it('rejects known numeric fields with the wrong type', () => {
    expect(validatePresetFields({ contrast: 'red' })).toHaveProperty('error');
    expect(validatePresetFields({ contrast: NaN })).toHaveProperty('error');
    expect(validatePresetFields({ contrast: Infinity })).toHaveProperty('error');
  });

  it('accepts known string fields with string values', () => {
    expect(validatePresetFields({ profile: 'Neutral' })).toEqual({
      fields: { profile: 'Neutral' },
    });
  });

  it('rejects known string fields with non-string values', () => {
    expect(validatePresetFields({ profile: 1 })).toHaveProperty('error');
    expect(validatePresetFields({ profile: '' })).toHaveProperty('error');
  });

  it('accepts an empty string for film_look — its canonical "clear the look" value', () => {
    expect(validatePresetFields({ film_look: '' })).toEqual({
      fields: { film_look: '' },
    });
  });

  it('still rejects an empty string for other (closed-enum) string fields', () => {
    expect(validatePresetFields({ wb_method: '' })).toHaveProperty('error');
    expect(validatePresetFields({ look: '' })).toHaveProperty('error');
    expect(validatePresetFields({ black_white: '' })).toHaveProperty('error');
  });

  it('rejects non-string values for film_look same as any other string field', () => {
    expect(validatePresetFields({ film_look: 1 })).toHaveProperty('error');
  });

  it('preserves unknown scalar fields (passthrough rule)', () => {
    expect(
      validatePresetFields({ future_curve_strength: 0.5, future_mode: 'Soft', future_flag: true }),
    ).toEqual({
      fields: { future_curve_strength: 0.5, future_mode: 'Soft', future_flag: true },
    });
  });

  it('rejects unknown fields with non-scalar values', () => {
    expect(validatePresetFields({ future_blob: { nested: 1 } })).toHaveProperty('error');
    expect(validatePresetFields({ future_list: [1, 2] })).toHaveProperty('error');
    expect(validatePresetFields({ future_null: null })).toHaveProperty('error');
  });

  // #2232 round-trip: a preset `fields` map is flat-scalar-only, so BOTH
  // curve families — the pre-existing scene-linear `tone_curve_*` and the
  // new display-referred `display_tone_curve_*` — are unknown to the
  // validator (see the module doc and `adjustment-fields.test.ts`'s golden
  // gate) and hit the same unknown-field path as anything else. A curve
  // object rejects with a clean 400 rather than silently dropping —
  // it never reaches storage in either shape.
  it('rejects a preset field carrying an actual curve object, scene-linear or display', () => {
    const curve = {
      points: [
        [0, 0],
        [1, 1],
      ],
    };
    expect(validatePresetFields({ tone_curve_luma: curve })).toHaveProperty('error');
    expect(validatePresetFields({ display_tone_curve_luma: curve })).toHaveProperty('error');
  });

  it('rejects non-object fields payloads', () => {
    expect(validatePresetFields(null)).toHaveProperty('error');
    expect(validatePresetFields([1])).toHaveProperty('error');
    expect(validatePresetFields('x')).toHaveProperty('error');
  });

  it('rejects oversized field maps', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i <= PRESET_FIELDS_MAX; i++) big[`future_${i}`] = i;
    expect(validatePresetFields(big)).toHaveProperty('error');
  });

  it('rejects Mongo-unsafe keys (dots, $-prefix, NUL) with a clean error', () => {
    // These would otherwise pass validation and blow up the insert (500).
    expect(validatePresetFields({ 'future.dotted': 1 })).toHaveProperty('error');
    expect(validatePresetFields({ $set: 1 })).toHaveProperty('error');
    expect(validatePresetFields({ 'future\0nul': 1 })).toHaveProperty('error');
    // `$` is only forbidden as a PREFIX — elsewhere in the key is fine.
    expect(validatePresetFields({ future$x: 1 })).toEqual({ fields: { future$x: 1 } });
  });
});

describe('isMongoSafeKey', () => {
  it('classifies key shapes the way MongoDB inserts require', () => {
    expect(isMongoSafeKey('contrast')).toBe(true);
    expect(isMongoSafeKey('future$x')).toBe(true);
    expect(isMongoSafeKey('$set')).toBe(false);
    expect(isMongoSafeKey('a.b')).toBe(false);
    expect(isMongoSafeKey('a\0b')).toBe(false);
  });
});

describe('validatePresetDocument', () => {
  it('accepts the canonical document shape', () => {
    const res = validatePresetDocument({
      schemaVersion: 1,
      name: 'Flat',
      fields: { contrast: -50 },
    });
    expect(res).toEqual({
      ok: true,
      preset: { name: 'Flat', schemaVersion: 1, fields: { contrast: -50 } },
    });
  });

  it('accepts NEWER schema versions (forward compat)', () => {
    const res = validatePresetDocument({
      schemaVersion: 7,
      name: 'From the future',
      fields: { future_field: 1 },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects invalid schema versions', () => {
    expect(validatePresetDocument({ schemaVersion: 0, name: 'x', fields: {} }).ok).toBe(false);
    expect(validatePresetDocument({ schemaVersion: 1.5, name: 'x', fields: {} }).ok).toBe(false);
    expect(validatePresetDocument({ schemaVersion: '1', name: 'x', fields: {} }).ok).toBe(false);
  });
});
