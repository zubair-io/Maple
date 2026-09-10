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

/** The fields every verdict carries, whatever its source. */
function hasCommonShape(value: Partial<LensProfileResolution>): boolean {
  return (
    isStringList(value.approximations) &&
    isStringList(value.unsupported) &&
    (value.reference === undefined || typeof value.reference === 'string') &&
    isOptionalBoolean(value.enabled)
  );
}

/** An embedded (DNG OpcodeList3) verdict carries no calibration detail. */
function isEmbeddedVerdict(value: Partial<LensProfileResolution>): boolean {
  return value.source === 'embedded' && value.confidence === 'embedded';
}

/** An LCP verdict: in-range or approximate, with per-family flags and samples. */
function isLcpVerdict(value: Partial<LensProfileResolution>): boolean {
  return (
    value.source === 'lcp' &&
    (value.confidence === 'in-range' || value.confidence === 'approximate') &&
    [value.hasDistortion, value.hasCa, value.hasVignetting].every(isOptionalBoolean) &&
    [value.distortion, value.ca, value.vignetting].every(isSampleList)
  );
}

function parseObject(json: string): Partial<LensProfileResolution> | undefined {
  try {
    const value = JSON.parse(json) as Partial<LensProfileResolution> | null;
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Parse + validate one resolution document; `undefined` for anything else. */
export function lensProfileFromJson(json: string | undefined): LensProfileResolution | undefined {
  const value = json ? parseObject(json) : undefined;
  if (!value || !hasCommonShape(value)) return undefined;
  return isEmbeddedVerdict(value) || isLcpVerdict(value)
    ? (value as LensProfileResolution)
    : undefined;
}
