// Validation of raw-core's lens-profile resolution JSON (#3479). Runs once on
// the worker side before the facts reach any main-thread signal: a malformed
// document leaves the asset "unassessed" rather than enabling a correction
// the renderer never applied.

import type { LensProfileResolution, LensProfileSample } from './lens-profile.types';

const SAMPLE_KEYS: readonly (keyof LensProfileSample)[] = [
  'index',
  'weight',
  'focalMm',
  'apertureApex',
  'focusM',
];

function isSampleList(value: unknown): value is LensProfileSample[] {
  return (
    Array.isArray(value) &&
    value.every(
      (sample) =>
        typeof sample === 'object' &&
        sample !== null &&
        SAMPLE_KEYS.every((key) => {
          const field = (sample as Record<string, unknown>)[key];
          return typeof field === 'number' && Number.isFinite(field);
        }),
    )
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** Parse + validate one resolution document; `undefined` for anything else. */
export function lensProfileFromJson(json: string | undefined): LensProfileResolution | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as Partial<LensProfileResolution> | null;
    if (typeof value !== 'object' || value === null) return undefined;
    if (!isStringList(value.approximations) || !isStringList(value.unsupported)) return undefined;
    if (value.reference !== undefined && typeof value.reference !== 'string') return undefined;
    if (!isOptionalBoolean(value.enabled)) return undefined;
    if (value.source === 'embedded') {
      return value.confidence === 'embedded' ? (value as LensProfileResolution) : undefined;
    }
    if (value.source !== 'lcp') return undefined;
    if (value.confidence !== 'in-range' && value.confidence !== 'approximate') return undefined;
    if (![value.hasDistortion, value.hasCa, value.hasVignetting].every(isOptionalBoolean))
      return undefined;
    if (![value.distortion, value.ca, value.vignetting].every(isSampleList)) return undefined;
    return value as LensProfileResolution;
  } catch {
    return undefined;
  }
}
