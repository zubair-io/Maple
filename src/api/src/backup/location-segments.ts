/**
 * Derive the ordered backup folder segments from a reverse-geocoded place.
 *
 *   USA:        [<State>,   <Town/City || Place Name>]
 *   elsewhere:  [<Country>, <Town/City || Place Name>]
 *
 * "USA" is decided by the ISO 3166-1 country code (`us`, lowercased on the
 * `Place`). The top segment is the US state full name (e.g. "California") in
 * the USA, otherwise the country full name (e.g. "France"). The second segment
 * is the locality (town/city) when known, otherwise the nearest place/POI name
 * — "Town/City || Place Name" in the spec.
 *
 * Returns:
 *   - `[]` when there is no usable country/state. The caller then falls back to
 *     the date-only `<year>/<MM>` layout. This is also what the unresolved
 *     geocode stub (empty address/rollups) yields.
 *   - `[top]` when a region/country is known but there is no locality or POI.
 *   - `[top, sub]` in the common case.
 *
 * Shared by the backup-ingest hot path (`resolveBackupLocation`) and the
 * `refile-backups` cleanup migration so a migrated file lands
 * exactly where a fresh ingest of the same place would write it. The result is
 * pre-sanitised downstream by `sanitizeLocationSegments` in `path-formatter.ts`.
 *
 * Spec: docs/superpowers/specs/2026-06-05-backup-geo-layout.md.
 */

import type { Place } from '../db/schema.ts';

/** ISO 3166-1 alpha-2 code for the United States (lowercased, as stored). */
const USA_COUNTRY_CODE = 'us';

/** Trim and null out empty/whitespace strings. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Leading civic prefix Nominatim attaches to some official locality names
 * ("City of London", "Town of Cary", "Village of Oak Park"). The `\s+` right
 * after the keyword is what keeps "Townsville"/"Cityscape" safe — there's no
 * whitespace there, so the match fails before it ever reaches "of". */
const CIVIC_PREFIX = /^(?:City|Town|Village)\s+of\s+/i;

/**
 * Strip a leading "City of " / "Town of " / "Village of " civic prefix from a
 * locality so it files under the bare place name ("City of London" → "London").
 * Falls back to the original when a strip would leave nothing (defensive — the
 * locality is pre-trimmed by `nonEmpty`).
 *
 * Country-agnostic: civic prefixes occur worldwide, so this runs regardless of
 * country. The NYC rename is scoped to the USA and applied by the caller, which
 * has the country/state context (see `locationSegmentsFromFields`).
 */
function stripCivicPrefix(name: string | null): string | null {
  if (name == null) return null;
  const stripped = name.replace(CIVIC_PREFIX, '').trim();
  return stripped.length > 0 ? stripped : name;
}

/** Common folder naming policy; source-specific fallbacks stay in the adapters. */
export function locationSegmentsFromFields(fields: {
  countryCode?: string | null;
  state?: string | null;
  country?: string | null;
  locality?: string | null;
}): string[] {
  const isUSA = (nonEmpty(fields.countryCode) ?? '').toLowerCase() === USA_COUNTRY_CODE;
  const state = nonEmpty(fields.state);
  const country = nonEmpty(fields.country);
  // Cross-fallback preserves usable sparse responses without inventing a region.
  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  const locality = stripCivicPrefix(nonEmpty(fields.locality));
  // Rename only the NYC locality, never NY state or a non-NY namesake.
  const city =
    locality === 'New York' && isUSA && state === 'New York' ? 'New York City' : locality;
  return city ? [top, city] : [top];
}

export function backupLocationSegments(place: Place | null | undefined): string[] {
  if (!place) return [];
  const addr = place.address ?? {};
  const rollups = place.rollups;
  const segments = locationSegmentsFromFields({
    countryCode: nonEmpty(addr.country_code) ?? nonEmpty(rollups?.country_code),
    // Rollup region mirrors the state and survives a sparse address sweep.
    state: nonEmpty(addr.state) ?? nonEmpty(rollups?.region),
    country: addr.country,
    locality: rollups?.locality,
  });
  // Only the Place adapter has a POI fallback. Landmark names bypass civic/NYC
  // rewriting, and cannot supply a folder when there is no country or state.
  const poi = nonEmpty(place.pois?.[0]?.name);
  return segments.length === 1 && poi ? [...segments, poi] : segments;
}
