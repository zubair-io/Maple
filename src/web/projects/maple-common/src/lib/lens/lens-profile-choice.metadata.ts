// Validation of raw-core's lens-profile-CHOICE JSON (#3569) — the direct
// `compatibleLensProfiles`/`resolveLensProfile` fetches the profile dropdown
// makes, independent of the render-reply-fed `lens-profile.metadata.ts`
// (#3479). Runs on the worker side before either shape reaches a signal, so
// a malformed document degrades to "no data" rather than showing a bogus
// pick or a fabricated coverage claim.

import type { CompatibleLensProfile, LensProfileEvidence } from './lens-profile-choice.types';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringOrNullish(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

const SOURCES = new Set(['embedded', 'lcp', 'lensfun', 'none']);
const CONFIDENCES = new Set(['embedded', 'in-range', 'approximate']);

/** Parse + validate one `resolveLensProfile` document; `undefined` for anything else. */
export function lensProfileEvidenceFromJson(json: string): LensProfileEvidence | undefined {
  let value: Partial<LensProfileEvidence> | null;
  try {
    value = JSON.parse(json) as Partial<LensProfileEvidence> | null;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const valid =
    typeof value.source === 'string' &&
    SOURCES.has(value.source) &&
    typeof value.confidence === 'string' &&
    CONFIDENCES.has(value.confidence) &&
    typeof value.hasDistortion === 'boolean' &&
    typeof value.hasCa === 'boolean' &&
    typeof value.hasVignetting === 'boolean' &&
    isStringList(value.approximations) &&
    isStringList(value.unsupported) &&
    isStringOrNullish(value.lens) &&
    isStringOrNullish(value.dbVersion);
  return valid ? (value as LensProfileEvidence) : undefined;
}

/** Parse + filter one `compatibleLensProfiles` document; a malformed entry is
 *  dropped rather than failing the whole list. */
export function compatibleLensProfilesFromJson(json: string): CompatibleLensProfile[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CompatibleLensProfile => {
    const lens = item as Partial<CompatibleLensProfile> | null;
    return (
      typeof lens === 'object' &&
      lens !== null &&
      typeof lens.slug === 'string' &&
      typeof lens.maker === 'string' &&
      typeof lens.model === 'string'
    );
  });
}
