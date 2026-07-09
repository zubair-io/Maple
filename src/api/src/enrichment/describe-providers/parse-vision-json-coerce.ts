/**
 * Coercion helpers used by `parse-vision-json.ts` to normalise qwen
 * field values before validation. Split out from the orchestrator so it
 * stays under the file-size budget (#114).
 *
 * The `COERCE_FAIL` / `COERCE_FAIL_TYPE` sentinels let coercers distinguish
 * "couldn't normalise" from a legitimate null/false result, so the call
 * site can throw the right `VisionParseError` flavour (`bad-enum` vs
 * `wrong-type`) — the reason taxonomy matters for dead-letter triage.
 */

import { VisionParseError } from './parse-vision-json-errors.ts';

/** Sentinel returned by `coerce*` helpers to signal "this input couldn't be
 * normalised". Distinct from a legitimate null/false result so the caller
 * can throw a `VisionParseError` only when the input was actually invalid. */
export const COERCE_FAIL = Symbol('coerce-fail');

/** Distinguishes "the input wasn't a string at all" (wrong-type) from
 * "the input was a string but not in the allowed set / synonym map"
 * (bad-enum). Lets the call site preserve the error-reason taxonomy
 * dead-letter triage groups on. */
export const COERCE_FAIL_TYPE = Symbol('coerce-fail-type');

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    out.push(x);
  }
  return out;
}

/** Same as `asStringArray`, but `null`/`undefined` collapse to `[]`. qwen2.5-vl
 * returns `null` for these fields on featureless images (black/empty
 * frames) — treating that as "no subjects/colors/objects detected" is
 * more useful than dead-lettering the row. */
export function asStringArrayOrEmpty(v: unknown): string[] | null {
  if (v === null || v === undefined) return [];
  return asStringArray(v);
}

/** qwen2.5-vl regularly returns is_screenshot as a string ("false"), a
 * number (0/1), or omits it. Coerce the common variants — anything truly
 * unparseable returns COERCE_FAIL so the caller dead-letters the row.
 * Missing / null / undefined defaults to `false`: an outdoor scene with
 * no `is_screenshot` field is overwhelmingly likely to be a real photo. */
export function coerceIsScreenshot(v: unknown): boolean | typeof COERCE_FAIL {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') {
    if (v === 0) return false;
    if (v === 1) return true;
    return COERCE_FAIL;
  }
  if (typeof v === 'string') {
    const norm = v.trim().toLowerCase();
    if (norm === 'true' || norm === 'yes' || norm === '1') return true;
    if (norm === 'false' || norm === 'no' || norm === '0' || norm === '') return false;
    return COERCE_FAIL;
  }
  return COERCE_FAIL;
}

/** Coerce a value to a member of `allowed`. Resolution order:
 *   1. null/undefined → `defaultValue` (must itself be in `allowed`).
 *   2. non-string → COERCE_FAIL_TYPE (caller throws `wrong-type`).
 *   3. exact string match (post trim + lowercase).
 *   4. synonym map lookup (post trim + lowercase).
 *   5. otherwise COERCE_FAIL (caller throws `bad-enum`).
 *
 * The trim+lowercase normalisation is intentional — qwen2.5-vl
 * sometimes emits trailing whitespace or capitalisation drift. */
export function coerceEnum(
  v: unknown,
  allowed: Set<string>,
  synonyms: Record<string, string>,
  defaultValue: string,
): string | typeof COERCE_FAIL | typeof COERCE_FAIL_TYPE {
  if (v === null || v === undefined) return defaultValue;
  if (typeof v !== 'string') return COERCE_FAIL_TYPE;
  const norm = v.trim().toLowerCase();
  if (allowed.has(norm)) return norm;
  const mapped = synonyms[norm];
  if (mapped !== undefined && allowed.has(mapped)) return mapped;
  return COERCE_FAIL;
}

/** Resolve a `coerceEnum` result into a concrete string, throwing the
 * right `VisionParseError` flavour for the failure mode. Keeps the call
 * sites in `parseVisionJson` from repeating the same two-branch dance.
 *
 * The reason taxonomy matters: dead-letter triage groups by `reason`,
 * so "the model returned 42 for an enum field" (wrong-type) needs to
 * stay distinct from "the model returned a string that isn't in the
 * allowed set" (bad-enum). */
export function unwrapEnum(
  result: string | typeof COERCE_FAIL | typeof COERCE_FAIL_TYPE,
  field: string,
  rawValue: unknown,
  raw: string,
  allowed: Set<string>,
): string {
  if (result === COERCE_FAIL_TYPE) {
    throw new VisionParseError(
      'wrong-type',
      `expected string | null, got ${typeof rawValue}`,
      raw,
      field,
    );
  }
  if (result === COERCE_FAIL) {
    throw new VisionParseError(
      'bad-enum',
      `got ${JSON.stringify(rawValue)}; allowed: ${[...allowed].join(' | ')}`,
      raw,
      field,
    );
  }
  return result;
}

/** text_visible is often returned as a string array when multiple text
 * regions are visible (signs + a license plate). Join with newlines —
 * downstream consumers treat the field as opaque multi-line text. Empty
 * array, empty string, null, and undefined all collapse to null. */
export function coerceTextVisible(v: unknown): string | null | typeof COERCE_FAIL {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length === 0 ? null : v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      if (typeof x !== 'string') return COERCE_FAIL;
      if (x.length > 0) parts.push(x);
    }
    return parts.length === 0 ? null : parts.join('\n');
  }
  return COERCE_FAIL;
}
