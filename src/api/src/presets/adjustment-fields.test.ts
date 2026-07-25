/**
 * Golden gate: the API's known-field validation table
 * (`adjustment-fields.ts`) must agree exactly with the codegen-generated
 * web module. Same convention as the tools/codegen.sh drift gate — one
 * canonical source (raw_core::types::ADJUSTMENT_SCHEMA), mirrors that are
 * test-pinned so they cannot drift.
 *
 * The import below reaches across the monorepo INTO src/web at TEST time
 * only — the API runtime never does this (the Docker image ships without
 * web sources), which is exactly why the runtime table is mirrored here.
 */

import { describe, expect, it } from 'bun:test';
import {
  ADJUSTMENT_RANGES,
  defaultGeneratedAdjustmentModel,
} from '../../../web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts';
import { NUMERIC_FIELD_RANGES, STRING_FIELDS } from './adjustment-fields.ts';

/** camelCase → snake_case, the mechanical mapping between the generated
 * TS property names and the canonical schema names (Apple's generated
 * `FieldName` enum carries the same snake_case strings). */
function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

describe('adjustment-fields golden gate (vs generated web module)', () => {
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
  // structured point-curve fields (#366) are deliberately outside the
  // validation surface — the clients never capture them. Pinned here so a
  // NEW structured field can't slip past the assertion above unnoticed.
  it('the only generated fields outside the validator are the point curves', () => {
    const defaults = defaultGeneratedAdjustmentModel() as unknown as Record<string, unknown>;
    const structured = Object.keys(defaults)
      .filter((k) => typeof defaults[k] === 'object')
      .map(camelToSnake)
      .sort();
    expect(structured).toEqual([
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
