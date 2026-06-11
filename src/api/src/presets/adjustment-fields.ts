/**
 * Known AdjustmentModel schema fields, canonical snake_case names — the
 * validation table for preset `fields` maps (#1115, spec §10.7).
 *
 * Source of truth is `raw_core::types::ADJUSTMENT_SCHEMA`, which codegen
 * emits to the web as
 * `src/web/projects/maple-common/src/lib/generated/adjustment-model.generated.ts`
 * (camelCase TS property names) and to Apple as the snake_case `FieldName`
 * enum in `AdjustmentModel+Generated.swift`. The API runtime image ships
 * WITHOUT the web sources (see src/api/Dockerfile — only src/api/src is
 * copied), so it cannot import the generated module at runtime; this table
 * is the API-side mirror, and `adjustment-fields.test.ts` is the golden
 * gate that pins it byte-for-byte against the generated web module (same
 * "one source, drift-gated mirrors" convention as tools/codegen.sh).
 *
 * Two kinds of known fields:
 *   - numeric: validated as finite numbers within the canonical range.
 *   - string-valued (enums on the clients): validated as non-empty strings.
 *     Variant-level validation deliberately stays client-side — enum
 *     variants evolve with the pipeline, and a downlevel server must not
 *     reject a preset written by an uplevel client (the passthrough rule).
 */

/** Canonical `[min, max]` range per numeric schema field (snake_case). */
export const NUMERIC_FIELD_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  temperature: [2000.0, 12000.0],
  tint: [-100.0, 100.0],
  exposure: [-4.0, 4.0],
  contrast: [-100.0, 100.0],
  highlights: [-100.0, 100.0],
  shadows: [-100.0, 100.0],
  whites: [-100.0, 100.0],
  blacks: [-100.0, 100.0],
  parametric_highlights: [-100.0, 100.0],
  parametric_lights: [-100.0, 100.0],
  parametric_darks: [-100.0, 100.0],
  parametric_shadows: [-100.0, 100.0],
  vibrance: [-100.0, 100.0],
  saturation: [-100.0, 100.0],
  clarity: [-100.0, 100.0],
  texture: [-100.0, 100.0],
  sharpen_amount: [0.0, 150.0],
  sharpen_radius: [0.5, 3.0],
  sharpen_detail: [0.0, 100.0],
  sharpen_masking: [0.0, 100.0],
  capture_sharpening_amount: [0.0, 100.0],
  capture_sharpening_sigma: [0.5, 2.0],
  capture_sharpening_radius: [0.5, 2.0],
  nr_luminance: [0.0, 100.0],
  nr_color: [0.0, 100.0],
  dehaze: [-100.0, 100.0],
  vignette_amount: [-100.0, 100.0],
  vignette_feather: [0.0, 100.0],
  grain_amount: [0.0, 100.0],
  grain_size: [0.0, 100.0],
  grain_roughness: [0.0, 100.0],
  split_tone_shadow_hue: [0.0, 360.0],
  split_tone_shadow_saturation: [0.0, 100.0],
  split_tone_highlight_hue: [0.0, 360.0],
  split_tone_highlight_saturation: [0.0, 100.0],
  split_tone_balance: [-100.0, 100.0],
};

/** String-valued schema fields (enums on the clients), snake_case. */
export const STRING_FIELDS: ReadonlySet<string> = new Set([
  'wb_method',
  'highlight_recovery',
  'auto_exposure',
  'look',
  'profile',
  'tone_curve_mode',
]);

export function isKnownNumericField(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NUMERIC_FIELD_RANGES, name);
}

export function isKnownStringField(name: string): boolean {
  return STRING_FIELDS.has(name);
}
