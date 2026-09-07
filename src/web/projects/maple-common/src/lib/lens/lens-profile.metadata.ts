import type { LensProfileResolution, LensProfileSample } from './lens-profile.types';

function samples(value: unknown): value is LensProfileSample[] {
  return (
    Array.isArray(value) &&
    value.every(
      (sample) =>
        sample &&
        ['index', 'weight', 'focalMm', 'apertureApex', 'focusM'].every(
          (key) => typeof sample[key] === 'number' && Number.isFinite(sample[key]),
        ),
    )
  );
}

/** Decode facts are optional; malformed metadata cannot enable corrections. */
export function lensProfileFromJson(json: string | undefined): LensProfileResolution | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as LensProfileResolution;
    if (value.source !== 'lcp' || !['in-range', 'approximate'].includes(value.confidence))
      return undefined;
    if (
      ![value.approximations, value.unsupported].every(
        (items) => Array.isArray(items) && items.every((item) => typeof item === 'string'),
      )
    )
      return undefined;
    if (![value.distortion, value.ca, value.vignetting].every(samples)) return undefined;
    if (value.reference !== undefined && typeof value.reference !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}
