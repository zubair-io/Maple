/**
 * Preset document validation (#1115, spec §10.7).
 *
 * A preset is a named, schema-versioned SPARSE AdjustmentModel:
 *
 *   { "schemaVersion": 1, "name": "Flat", "fields": { "contrast": -50 } }
 *
 * `fields` keys are the canonical snake_case `ADJUSTMENT_SCHEMA` names.
 * Validation contract (the XMP passthrough philosophy applied to presets):
 *
 *   - KNOWN numeric fields must be finite numbers within the canonical
 *     range; KNOWN string fields must be non-empty strings (variant-level
 *     enum checks stay client-side so a downlevel server never rejects an
 *     uplevel client's preset) — EXCEPT the free-form fields in
 *     `FREE_FORM_STRING_FIELDS` (currently just `film_look`), whose empty
 *     string is itself a valid, meaningful value (explicit "clear the
 *     look") rather than a missing one.
 *   - UNKNOWN fields (newer schema versions) are accepted and preserved
 *     verbatim — but must still be JSON scalars within size caps, so the
 *     collection can't be used as a blob store.
 *   - ALL keys must be Mongo-safe (no `.`/NUL, no `$` prefix) — they are
 *     written as subdocument keys, and an unsafe one would otherwise only
 *     fail at insert time as a 500 instead of a clean 400.
 *
 * Pure functions, no I/O — unit-tested in `preset-validation.test.ts`.
 */

import {
  NUMERIC_FIELD_RANGES,
  allowsEmptyString,
  isKnownNumericField,
  isKnownStringField,
} from './adjustment-fields.ts';

export const PRESET_NAME_MAX = 120;
/** Generous headroom over the 42 schema fields for future versions. */
export const PRESET_FIELDS_MAX = 128;
const PRESET_FIELD_KEY_MAX = 64;
const PRESET_STRING_VALUE_MAX = 200;

export type PresetFields = Record<string, number | string | boolean>;

export interface ValidatedPreset {
  name: string;
  schemaVersion: number;
  fields: PresetFields;
}

export type PresetValidationResult =
  | { ok: true; preset: ValidatedPreset }
  | { ok: false; error: string };

/**
 * MongoDB forbids document keys that contain `.` or NUL or start with `$`
 * (exact rules vary by server version). Preset `fields` keys — and the
 * preserved unknown top-level keys in `doc.extra` — are written as
 * subdocument keys, so an unsafe key would only surface at insert time as
 * a 500. Reject it during validation instead, as a deterministic 400.
 */
export function isMongoSafeKey(key: string): boolean {
  return !key.startsWith('$') && !key.includes('.') && !key.includes('\0');
}

/** Shared 400 message for a Mongo-unsafe key (field, preserved top-level,
 * or nested inside a preserved value). */
export function unsafeKeyError(key: string): string {
  return `key "${key.slice(0, 80)}" must not contain "." or NUL or start with "$"`;
}

/** Trim + validate a preset name. Returns the trimmed name or an error. */
export function validatePresetName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'name must be a string' };
  const name = raw.trim();
  if (name.length === 0) return { error: 'name must not be empty' };
  if (name.length > PRESET_NAME_MAX) {
    return { error: `name must be at most ${PRESET_NAME_MAX} characters` };
  }
  // Control characters never belong in a display name (and break list UIs).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return { error: 'name contains control characters' };
  return { name };
}

/**
 * Validate the `fields` map of a preset document. Returns the (shallow-
 * copied) map on success so callers never share the request object.
 */
export function validatePresetFields(raw: unknown): { fields: PresetFields } | { error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'fields must be an object' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > PRESET_FIELDS_MAX) {
    return { error: `fields must have at most ${PRESET_FIELDS_MAX} entries` };
  }
  const fields: PresetFields = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > PRESET_FIELD_KEY_MAX) {
      return { error: `field key "${key.slice(0, 80)}" has invalid length` };
    }
    if (!isMongoSafeKey(key)) {
      return { error: unsafeKeyError(key) };
    }
    if (isKnownNumericField(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: `field "${key}" must be a finite number` };
      }
      const [lo, hi] = NUMERIC_FIELD_RANGES[key];
      if (value < lo || value > hi) {
        return { error: `field "${key}" must be within [${lo}, ${hi}]` };
      }
      fields[key] = value;
      continue;
    }
    if (isKnownStringField(key)) {
      if (typeof value !== 'string') {
        return { error: `field "${key}" must be a string` };
      }
      if (value.length === 0 && !allowsEmptyString(key)) {
        return { error: `field "${key}" must be a non-empty string` };
      }
      if (value.length > PRESET_STRING_VALUE_MAX) {
        return { error: `field "${key}" value is too long` };
      }
      fields[key] = value;
      continue;
    }
    // Unknown field — preserved per the passthrough rule, but only as a
    // bounded JSON scalar.
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { error: `field "${key}" must be a finite number` };
      fields[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > PRESET_STRING_VALUE_MAX) {
        return { error: `field "${key}" value is too long` };
      }
      fields[key] = value;
    } else if (typeof value === 'boolean') {
      fields[key] = value;
    } else {
      return { error: `field "${key}" must be a number, string, or boolean` };
    }
  }
  return { fields };
}

/**
 * Validate a full create-preset payload `{ schemaVersion, name, fields }`.
 * Versions newer than the current server version are accepted (their
 * unknown fields ride the passthrough rule); non-positive or non-integer
 * versions are rejected.
 */
export function validatePresetDocument(body: {
  schemaVersion?: unknown;
  name?: unknown;
  fields?: unknown;
}): PresetValidationResult {
  const version = body.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 1000) {
    return { ok: false, error: 'schemaVersion must be a positive integer' };
  }
  const name = validatePresetName(body.name);
  if ('error' in name) return { ok: false, error: name.error };
  const fields = validatePresetFields(body.fields);
  if ('error' in fields) return { ok: false, error: fields.error };
  return { ok: true, preset: { name: name.name, schemaVersion: version, fields: fields.fields } };
}
