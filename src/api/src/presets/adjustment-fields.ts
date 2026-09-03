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
 *
 * The schema's structured fields — the four scene-linear `tone_curve_*`
 * point curves (#366) and the four display-referred `display_tone_curve_*`
 * point curves (#2232) — are not preset fields at all: a preset `fields`
 * map is flat (`Record<string, number | string | boolean>`) and no client
 * captures them. `adjustment-fields.test.ts` pins that exclusion so a
 * future structured field can't quietly join them.
 */

/** Canonical `[min, max]` range per numeric schema field (snake_case). */
export const NUMERIC_FIELD_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  temperature: [2000.0, 12000.0],
  tint: [-150.0, 150.0], // ACR's crs:Tint span (#1870)
  // White-balance provenance (#2434): the normalised point a sampled pair
  // was picked at, and the version of the derivation behind it. Metadata,
  // never a render input — the `wb_source` enum lives in STRING_FIELDS.
  wb_sample_x: [0.0, 1.0],
  wb_sample_y: [0.0, 1.0],
  wb_algorithm_version: [0.0, 1000000.0],
  exposure: [-4.0, 4.0],
  contrast: [-100.0, 100.0],
  brightness: [-100.0, 100.0],
  highlights: [-100.0, 100.0],
  shadows: [-100.0, 100.0],
  whites: [-100.0, 100.0],
  blacks: [-100.0, 100.0],
  parametric_highlights: [-100.0, 100.0],
  parametric_lights: [-100.0, 100.0],
  parametric_darks: [-100.0, 100.0],
  parametric_shadows: [-100.0, 100.0],
  // ACR's parametric split points (#2320) — round-tripped through the
  // sidecar; defaults 25/50/75, not 0.
  parametric_shadow_split: [0.0, 100.0],
  parametric_midtone_split: [0.0, 100.0],
  parametric_highlight_split: [0.0, 100.0],
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
  // Decode-time chroma pre-filter (#1104) — decode-product field; tail
  // position mirrors the generated module.
  chroma_prefilter: [0.0, 100.0],
  // BM3D deep denoise (#1105) — decode-product field.
  deep_denoise: [0.0, 100.0],
  dehaze: [-100.0, 100.0],
  vignette_amount: [-100.0, 100.0],
  vignette_feather: [0.0, 100.0],
  grain_amount: [0.0, 100.0],
  grain_size: [0.0, 100.0],
  grain_roughness: [0.0, 100.0],
  // Film emulation blend strength (#2683) — the paired `film_look` catalog
  // id is a string field and lives in STRING_FIELDS below.
  film_strength: [0.0, 100.0],
  split_tone_shadow_hue: [0.0, 360.0],
  split_tone_shadow_saturation: [0.0, 100.0],
  split_tone_highlight_hue: [0.0, 360.0],
  split_tone_highlight_saturation: [0.0, 100.0],
  split_tone_balance: [-100.0, 100.0],
  // Colour grading (#275) — the rest of the Color Grading panel beyond the
  // five `split_tone_*` sliders above, which are ACR's `crs:SplitToning*`
  // shadow/highlight pairs and balance.
  color_grade_shadow_luminance: [-100.0, 100.0],
  color_grade_midtone_hue: [0.0, 360.0],
  color_grade_midtone_saturation: [0.0, 100.0],
  color_grade_midtone_luminance: [-100.0, 100.0],
  color_grade_highlight_luminance: [-100.0, 100.0],
  color_grade_global_hue: [0.0, 360.0],
  color_grade_global_saturation: [0.0, 100.0],
  color_grade_global_luminance: [-100.0, 100.0],
  // HSL 8-band per-channel adjustments (#1112) — range -100..+100.
  // Snake_case matches the raw-core schema (hue_adjustment_* etc.).
  hue_adjustment_red: [-100.0, 100.0],
  hue_adjustment_orange: [-100.0, 100.0],
  hue_adjustment_yellow: [-100.0, 100.0],
  hue_adjustment_green: [-100.0, 100.0],
  hue_adjustment_aqua: [-100.0, 100.0],
  hue_adjustment_blue: [-100.0, 100.0],
  hue_adjustment_purple: [-100.0, 100.0],
  hue_adjustment_magenta: [-100.0, 100.0],
  saturation_adjustment_red: [-100.0, 100.0],
  saturation_adjustment_orange: [-100.0, 100.0],
  saturation_adjustment_yellow: [-100.0, 100.0],
  saturation_adjustment_green: [-100.0, 100.0],
  saturation_adjustment_aqua: [-100.0, 100.0],
  saturation_adjustment_blue: [-100.0, 100.0],
  saturation_adjustment_purple: [-100.0, 100.0],
  saturation_adjustment_magenta: [-100.0, 100.0],
  luminance_adjustment_red: [-100.0, 100.0],
  luminance_adjustment_orange: [-100.0, 100.0],
  luminance_adjustment_yellow: [-100.0, 100.0],
  luminance_adjustment_green: [-100.0, 100.0],
  luminance_adjustment_aqua: [-100.0, 100.0],
  luminance_adjustment_blue: [-100.0, 100.0],
  luminance_adjustment_purple: [-100.0, 100.0],
  luminance_adjustment_magenta: [-100.0, 100.0],
  // Black & white mix (#276) — the eight per-band luminance weights, over
  // the same hue bands as the HSL block above. The `black_white` mode
  // toggle is an enum and lives in STRING_FIELDS below.
  gray_mixer_red: [-100.0, 100.0],
  gray_mixer_orange: [-100.0, 100.0],
  gray_mixer_yellow: [-100.0, 100.0],
  gray_mixer_green: [-100.0, 100.0],
  gray_mixer_aqua: [-100.0, 100.0],
  gray_mixer_blue: [-100.0, 100.0],
  gray_mixer_purple: [-100.0, 100.0],
  gray_mixer_magenta: [-100.0, 100.0],
  // DNG lens corrections (#376) — per-family strengths applied to the
  // `OpcodeList3` the RAW itself carries. The `lens_profile_enable` master
  // switch is an enum and lives in STRING_FIELDS below.
  lens_correction_distortion: [0.0, 100.0],
  lens_correction_ca: [0.0, 100.0],
  lens_correction_vignetting: [0.0, 100.0],
};

/** String-valued schema fields (enums on the clients), snake_case. */
export const STRING_FIELDS: ReadonlySet<string> = new Set([
  'wb_method',
  // Where the white balance came from (#2434) —
  // AsShot|Auto|Preset|Sampled|Manual.
  'wb_source',
  'highlight_recovery',
  'auto_exposure',
  'look',
  'profile',
  'tone_curve_mode',
  // Hot/dead-pixel suppression (#1106) — Off|On enum, decode-product field.
  'hot_pixel_suppression',
  // Black & white conversion (#276) — Off|On enum; the eight
  // `gray_mixer_*` weights it drives are numeric fields above.
  'black_white',
  // DNG lens-correction master switch (#376) — Off|On enum; the three
  // `lens_correction_*` strengths it gates are numeric fields above.
  'lens_profile_enable',
  // Film emulation look id (#2683) — a free-form film-catalog id, NOT a
  // closed enum like the other entries in this set (there is no fixed
  // variant list; an id the catalog doesn't recognise resolves as identity
  // at render time). Classified as string-valued here so it gets the
  // scalar/length checks every STRING_FIELDS entry gets, but it is ALSO
  // listed in FREE_FORM_STRING_FIELDS below because — unlike the closed
  // enums in this set — the empty string is its own canonical "no look"
  // value, not an invalid one: a preset must be able to explicitly clear a
  // film look by writing `film_look: ""`.
  'film_look',
]);

/**
 * The subset of STRING_FIELDS whose empty string is a meaningful, valid
 * value rather than "missing" — currently just `film_look`, whose empty
 * string is the canonical "no look selected" state. Every other
 * STRING_FIELDS entry is a closed enum where an empty string can never be
 * a real variant, so it stays rejected.
 */
const FREE_FORM_STRING_FIELDS: ReadonlySet<string> = new Set(['film_look']);

export function isKnownNumericField(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(NUMERIC_FIELD_RANGES, name);
}

export function isKnownStringField(name: string): boolean {
  return STRING_FIELDS.has(name);
}

/** Whether `name` is a known string field that allows an empty-string value. */
export function allowsEmptyString(name: string): boolean {
  return FREE_FORM_STRING_FIELDS.has(name);
}
