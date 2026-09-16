/**
 * Preset fields use the canonical raw-core scalar schema via codegen (#3663).
 * Structured tone curves are excluded from the flat preset fields map.
 * Enum strings remain forward-compatible: the validator checks nonempty
 * strings, not known variants. Free-form strings also permit empty values.
 * Generated data lives inside the API image; no web runtime import is needed.
 */
import {
  FREE_FORM_STRING_FIELDS,
  NUMERIC_FIELD_RANGES,
  STRING_FIELDS,
} from '../generated/adjustment-fields.generated.ts';

export { NUMERIC_FIELD_RANGES, STRING_FIELDS };

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
