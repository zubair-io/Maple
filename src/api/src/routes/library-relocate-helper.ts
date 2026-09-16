import type { MetadataOverride } from '../db/schema.ts';
import { locationSegmentsFromFields } from '../backup/location-segments.ts';

/**
 * Compute location segments directly from `metadata_override.place_text` —
 * reads from the IPTC override fields so the relocate uses the user's just-set
 * geo selection rather than the stale Nominatim-geocoded `doc.place`.
 *
 * Returns `[]` when `place_text` is absent or has no usable country/state.
 */
export function geoSegmentsFromOverride(override: MetadataOverride | null | undefined): string[] {
  const pt = override?.place_text;
  if (!pt) return [];
  return locationSegmentsFromFields({
    countryCode: pt.country_code,
    state: pt.state,
    country: pt.country,
    locality: pt.city,
  });
}
