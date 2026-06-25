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
 * ("City of London", "Town of Cary", "Village of Oak Park"). The trailing `\s+`
 * is what makes "Townsville"/"Cityscape" safe — they have no " of " after the
 * word, so they never match. */
const CIVIC_PREFIX = /^(?:City|Town|Village)\s+of\s+/i;

/**
 * Operator override for the backup folder's city/town segment (the locality).
 * Applied only to the locality — never the State/Country top segment — so the
 * `New York` rename below touches the city without disturbing the `New York`
 * state folder.
 *
 *   1. Drop a leading "City of " / "Town of " / "Village of " prefix, filing the
 *      place under its bare name. Skipped if stripping would empty the segment
 *      (a locality that is literally just "City of").
 *   2. Rename the city "New York" → "New York City".
 *
 * Rule 1 runs before rule 2 so the official "City of New York" lands on
 * "New York City" too.
 */
function normalizeBackupLocality(name: string | null): string | null {
  if (name == null) return null;
  let out = name;

  const stripped = out.replace(CIVIC_PREFIX, '').trim();
  if (stripped.length > 0) out = stripped;

  if (out === 'New York') out = 'New York City';

  return out;
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

  // Town/City || Place Name. The locality (the actual town/city) carries the
  // operator overrides; the POI fallback is a landmark name and is left as-is.
  const sub =
    normalizeBackupLocality(nonEmpty(rollups?.locality)) ?? nonEmpty(place.pois?.[0]?.name);
  return sub ? [top, sub] : [top];
}
