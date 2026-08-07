// preset-model.ts — develop presets (#1115, spec §10.7).
//
// A preset is a named, schema-versioned SPARSE AdjustmentModel:
//
//   { "schemaVersion": 1, "name": "Flat", "fields": { "contrast": -50 } }
//
// `fields` keys are the canonical snake_case names from raw-core's
// `ADJUSTMENT_SCHEMA` — the same stable strings Apple's generated
// `FieldName` enum exposes — so a preset document written by any platform
// parses on every other one. The generated TS model uses camelCase
// property names; the conversion between the two is mechanical (see
// `camelToSnakeField` / `snakeToCamelField`, round-trip-pinned in the
// spec for every generated key).
//
// Passthrough rule (same philosophy as XMP): unknown `fields` keys from
// newer schema versions are PRESERVED on round-trip and SKIPPED on apply.

import {
  defaultGeneratedAdjustmentModel,
  type AutoExposureMode,
  type BlackWhiteMode,
  type GeneratedAdjustmentModel,
  type HighlightRecoveryMode,
  type HotPixelSuppressionMode,
  type LensProfileEnable,
  type Look,
  type Profile,
  type ToneCurveMode,
  type WbMethod,
} from '../../generated/adjustment-model.generated';
// Ranges live in the sibling generated file (#2683 — split out to keep both
// generated files well under the file-size budget as the schema grows).
import { ADJUSTMENT_RANGES } from '../../generated/adjustment-tables.generated';
import type { AdjustmentModel } from '../../models/adjustment-model';

/** Preset document schema version this client writes. */
export const PRESET_SCHEMA_VERSION = 1;

export const PRESET_NAME_MAX = 120;

/** Sparse adjustment fields: canonical snake_case key → scalar value. */
export type PresetFields = Record<string, number | string | boolean>;

export interface Preset {
  /** Stable identity — Mongo hex id (self-hosted), generated UUID (hosted),
   *  or the bundled `builtin-*` id. */
  id: string;
  schemaVersion: number;
  name: string;
  fields: PresetFields;
  /** Bundled presets are read-only: no delete, no overwrite. */
  builtIn: boolean;
}

// ── Canonical field-name mapping ─────────────────────────────────────────

/** camelCase generated property name → canonical snake_case schema name. */
export function camelToSnakeField(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Canonical snake_case schema name → camelCase generated property name. */
export function snakeToCamelField(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Known-field tables (derived from the generated module at load) ───────

const GENERATED_DEFAULTS = defaultGeneratedAdjustmentModel();

/** snake_case schema name → camelCase generated key, for every generated
 *  field. Built from the generated defaults so it can't drift. */
const SNAKE_TO_GENERATED_KEY: ReadonlyMap<string, keyof GeneratedAdjustmentModel> = new Map(
  (Object.keys(GENERATED_DEFAULTS) as (keyof GeneratedAdjustmentModel)[]).map((k) => [
    camelToSnakeField(k),
    k,
  ]),
);

/**
 * Compile-time exhaustiveness guard for the hand-mirrored variant lists
 * below. The listed tuple must cover EVERY variant of the generated union
 * `U` — no more, no less. Omitting one, or leaving behind a variant the
 * schema has dropped, makes the argument unassignable, so `ng build` fails
 * naming the offending variant instead of the value being silently skipped
 * at apply time. That bidirectionality is what keeps this table honest
 * when raw-core adds a variant (e.g. a new `HighlightRecoveryMode`) or
 * retires one (as `profile` did with `AcrMatch` in #2312).
 */
const allVariantsOf =
  <U extends string>() =>
  <T extends readonly U[]>(
    values: T &
      (Exclude<U, T[number]> extends never
        ? unknown
        : ['missing enum variant', Exclude<U, T[number]>]),
  ): readonly U[] =>
    values;

/**
 * Allowed values per enum-valued schema field (canonical snake_case
 * names). The generated module only carries these variants as TS union
 * TYPES (erased at runtime), so the table is hand-mirrored here — pinned
 * against the generated unions at compile time by `allVariantsOf`, and
 * against the generated defaults at runtime by `preset-model.spec.ts`
 * (every string-valued generated field EXCEPT those listed in
 * `FREE_FORM_STRING_FIELDS` below; every generated default a member; every
 * listed variant round-trips through `buildApplyPatch`).
 * Apply-time validation SKIPS values outside this table instead of
 * failing the whole preset — a newer client's new variant must not break
 * older clients.
 */
export const ENUM_FIELD_VALUES: Readonly<Record<string, readonly string[]>> = {
  wb_method: allVariantsOf<WbMethod>()(['Cat16', 'DiagonalRec2020']),
  highlight_recovery: allVariantsOf<HighlightRecoveryMode>()([
    'Off',
    'Blend',
    'Luminance',
    'ChromaticAdaptation',
    'OklabChromaReduction',
  ]),
  auto_exposure: allVariantsOf<AutoExposureMode>()(['Off', 'On']),
  look: allVariantsOf<Look>()(['Neutral', 'Default']),
  profile: allVariantsOf<Profile>()(['Auto', 'Neutral']),
  tone_curve_mode: allVariantsOf<ToneCurveMode>()(['PerChannel', 'RatioPreserving']),
  // Hot/dead-pixel suppression (#1106) — decode-product enum field.
  hot_pixel_suppression: allVariantsOf<HotPixelSuppressionMode>()(['Off', 'On']),
  // Black & white toggle (#276) — 8-band Oklab stage's monochrome mode.
  black_white: allVariantsOf<BlackWhiteMode>()(['Off', 'On']),
  // DNG lens corrections master switch (#376) — decode-product enum field.
  lens_profile_enable: allVariantsOf<LensProfileEnable>()(['Off', 'On']),
};

/**
 * String-valued schema fields (canonical snake_case names) that are NOT
 * closed enums — free-form text with no fixed variant list, so they don't
 * belong in `ENUM_FIELD_VALUES` above. `buildApplyPatch` accepts any string
 * for these instead of checking membership.
 *
 * `film_look` (#2683) is the first: a film-catalog id. Unlike every enum
 * field above, an id the current catalog doesn't recognise is not an
 * error — raw-core's XMP parser (`xmp/fields.rs`) resolves an unknown id to
 * identity at render time rather than rejecting it, and the client-side
 * apply path follows the same rule.
 */
export const FREE_FORM_STRING_FIELDS: ReadonlySet<string> = new Set(['film_look']);

// ── Capture (save-preset) ─────────────────────────────────────────────────

/**
 * Capture the current model's NON-DEFAULT generated fields as a sparse
 * preset `fields` map (canonical snake_case keys). Web-only extensions
 * (e.g. `whiteBalancePreset`) are not schema fields and are never
 * captured — matching the S5 sliders, which also write only generated
 * fields.
 */
export function capturePresetFields(adj: AdjustmentModel): PresetFields {
  const fields: PresetFields = {};
  for (const key of Object.keys(GENERATED_DEFAULTS) as (keyof GeneratedAdjustmentModel)[]) {
    const value = adj[key];
    // Structured fields (the four `toneCurve*` point curves, #366) are not
    // preset values: `PresetFields` is a flat scalar map on both the client
    // and the API validator, and strict-equality against the default would
    // capture an identity curve on every save. Presets stay scalar-only
    // until point-curve support lands with the curve editor (#367).
    if (typeof value === 'object') continue;
    if (value !== GENERATED_DEFAULTS[key]) {
      fields[camelToSnakeField(key)] = value;
    }
  }
  return fields;
}

// ── Apply (sparse merge patch) ────────────────────────────────────────────

/**
 * Coerce a raw preset value for a known NUMERIC generated field: must be a
 * finite number, clamped to the field's canonical generated range.
 * Returns `undefined` when the value doesn't qualify (skip on apply).
 */
function coerceNumericField(
  key: keyof GeneratedAdjustmentModel,
  value: PresetFields[string],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const range = ADJUSTMENT_RANGES[key as keyof typeof ADJUSTMENT_RANGES];
  return range ? Math.min(range[1], Math.max(range[0], value)) : value;
}

/**
 * Coerce a raw preset value for a known enum-valued field: applied only
 * when it's a member of that field's `ENUM_FIELD_VALUES` variant list.
 * Returns `undefined` for an unknown variant (e.g. a retired one like the
 * `profile` field's old `AcrMatch`) — skip on apply.
 */
function coerceEnumField(snakeKey: string, value: string): string | undefined {
  const allowed = ENUM_FIELD_VALUES[snakeKey];
  return allowed?.includes(value) ? value : undefined;
}

/**
 * Coerce a raw preset value for a known STRING generated field (must
 * already be typed as `string`): free-form fields (`FREE_FORM_STRING_FIELDS`,
 * e.g. `film_look`) apply any string verbatim — including the empty
 * string, which is `film_look`'s canonical "no look" / explicit-clear
 * value — since there is no fixed variant list to check against. Every
 * other string field is a closed enum, delegated to `coerceEnumField`.
 */
function coerceStringField(snakeKey: string, value: string): string | undefined {
  return FREE_FORM_STRING_FIELDS.has(snakeKey) ? value : coerceEnumField(snakeKey, value);
}

/**
 * Build the `Partial<AdjustmentModel>` patch a preset applies. Defensive
 * by design — storage is validated at create time, but presets written by
 * NEWER schema versions flow through here too:
 *
 *   - unknown keys → skipped (preserved in storage, never applied)
 *   - numeric fields → must be finite numbers; clamped to the canonical
 *     generated range
 *   - enum fields → applied only when the value is a known variant
 *   - free-form string fields (`FREE_FORM_STRING_FIELDS`, e.g. `film_look`)
 *     → any string is applied — there is no fixed variant list to check
 *   - structured fields (the `toneCurve*` point curves) → never applied;
 *     they are not capturable either (see `capturePresetFields`)
 */
export function buildApplyPatch(fields: PresetFields): Partial<AdjustmentModel> {
  const patch: Partial<AdjustmentModel> = {};
  for (const [snakeKey, value] of Object.entries(fields)) {
    const key = SNAKE_TO_GENERATED_KEY.get(snakeKey);
    if (!key) continue; // Unknown field (newer schema) — skip on apply.
    const resolved =
      typeof GENERATED_DEFAULTS[key] === 'number'
        ? coerceNumericField(key, value)
        : typeof value === 'string'
          ? coerceStringField(snakeKey, value)
          : undefined;
    if (resolved !== undefined) {
      (patch as Record<string, number | string>)[key] = resolved;
    }
  }
  return patch;
}

// ── Name validation (shared by sheet + service) ───────────────────────────

/** Trimmed name, or null when invalid (empty / too long / control chars). */
export function normalizePresetName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > PRESET_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}
