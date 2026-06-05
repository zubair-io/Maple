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
 * geo-layout migration (`restructure-backup-geo`) so a migrated file lands
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

export function backupLocationSegments(place: Place | null | undefined): string[] {
  if (!place) return [];
  const addr = place.address ?? {};
  const rollups = place.rollups;

  const countryCode = (
    nonEmpty(addr.country_code) ??
    nonEmpty(rollups?.country_code) ??
    ''
  ).toLowerCase();
  const isUSA = countryCode === USA_COUNTRY_CODE;

  // `rollups.region` mirrors `address.state` (full name) — kept as a defensive
  // fallback in case the address sweep dropped it.
  const state = nonEmpty(addr.state) ?? nonEmpty(rollups?.region);
  const country = nonEmpty(addr.country);

  // USA → State, else Country. Cross-fall-back so a sparse response (e.g. a US
  // coordinate that resolved a country but no state) still produces a folder.
  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  // Town/City || Place Name.
  const sub = nonEmpty(rollups?.locality) ?? nonEmpty(place.pois?.[0]?.name);
  return sub ? [top, sub] : [top];
}
