/**
 * Cross-target contract: generated API preset validation tables agree exactly
 * with the generated web model/ranges. Web imports are test-only; production
 * API images contain only the generated API output.
 */

import { describe, expect, it } from 'bun:test';
import { defaultGeneratedAdjustmentModel } from '../../../web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts';
// Ranges live in the sibling generated file (#2683 — split out of
// adjustment-model.generated.ts to keep both generated files well under
// the file-size budget as the schema grows).
import { ADJUSTMENT_RANGES } from '../../../web/projects/maple-common/src/lib/generated/adjustment-tables.generated.ts';
import { allowsEmptyString, NUMERIC_FIELD_RANGES, STRING_FIELDS } from './adjustment-fields.ts';

/** camelCase → snake_case, the mechanical mapping between the generated
 * TS property names and the canonical schema names (Apple's generated
 * `FieldName` enum carries the same snake_case strings). */
function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

describe('adjustment-fields golden gate (vs generated web module)', () => {
  it('only free-form strings permit empty values', () => {
    expect([...STRING_FIELDS].filter(allowsEmptyString).sort()).toEqual([
      'film_look',
      'lens_profile',
    ]);
    expect(allowsEmptyString('unknown_field')).toBe(false);
  });

  it('numeric field names + ranges match ADJUSTMENT_RANGES exactly', () => {
    const expected = Object.fromEntries(
      Object.entries(ADJUSTMENT_RANGES).map(([k, range]) => [camelToSnake(k), [...range]]),
    );
    const actual = Object.fromEntries(
      Object.entries(NUMERIC_FIELD_RANGES).map(([k, range]) => [k, [...range]]),
    );
    expect(actual).toEqual(expected);
  });

  it('string fields are exactly the non-numeric generated fields', () => {
    const defaults = defaultGeneratedAdjustmentModel() as unknown as Record<string, unknown>;
    const expected = Object.keys(defaults)
      .filter((k) => typeof defaults[k] === 'string')
      .map(camelToSnake)
      .sort();
    expect([...STRING_FIELDS].sort()).toEqual(expected);
  });

  it('every scalar generated field is known to the validator (numeric or string)', () => {
    const defaults = defaultGeneratedAdjustmentModel() as unknown as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      if (typeof defaults[key] === 'object') continue; // structured, see below
      const snake = camelToSnake(key);
      const known =
        Object.prototype.hasOwnProperty.call(NUMERIC_FIELD_RANGES, snake) ||
        STRING_FIELDS.has(snake);
      expect(known).toBe(true);
    }
  });

  // Preset `fields` maps are flat scalar maps on both sides of the wire
  // (`PresetFields = Record<string, number | string | boolean>`), so the
  // structured point-curve fields — both the scene-linear family (#366)
  // and the display-referred family (#2232) — are deliberately outside
  // the validation surface — the clients never capture them. Pinned here
  // so a NEW structured field can't slip past the assertion above
  // unnoticed.
  it('the only generated fields outside the validator are the point curves', () => {
    const defaults = defaultGeneratedAdjustmentModel() as unknown as Record<string, unknown>;
    const structured = Object.keys(defaults)
      .filter((k) => typeof defaults[k] === 'object')
      .map(camelToSnake)
      .sort();
    expect(structured).toEqual([
      'display_tone_curve_blue',
      'display_tone_curve_green',
      'display_tone_curve_luma',
      'display_tone_curve_red',
      'tone_curve_blue',
      'tone_curve_green',
      'tone_curve_luma',
      'tone_curve_red',
    ]);
    for (const snake of structured) {
      expect(Object.prototype.hasOwnProperty.call(NUMERIC_FIELD_RANGES, snake)).toBe(false);
      expect(STRING_FIELDS.has(snake)).toBe(false);
    }
  });
});
