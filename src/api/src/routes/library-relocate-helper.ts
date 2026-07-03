import type { MetadataOverride } from "../db/schema.ts";

/** ISO 3166-1 alpha-2 code for the United States (lowercased, as stored). */
const USA_COUNTRY_CODE = "us";

/** Trim and null out empty/whitespace strings. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Leading civic prefix Nominatim attaches to some official locality names. */
const CIVIC_PREFIX = /^(?:City|Town|Village)\s+of\s+/i;

/** Strip a leading "City of " / "Town of " / "Village of " civic prefix. */
function stripCivicPrefix(name: string | null): string | null {
  if (name == null) return null;
  const stripped = name.replace(CIVIC_PREFIX, "").trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * Compute location segments directly from `metadata_override.place_text` —
 * reads from the IPTC override fields so the relocate uses the user's just-set
 * geo selection rather than the stale Nominatim-geocoded `doc.place`.
 *
 * Returns `[]` when `place_text` is absent or has no usable country/state.
 */
export function geoSegmentsFromOverride(
  override: MetadataOverride | null | undefined,
): string[] {
  const pt = override?.place_text;
  if (!pt) return [];

  const countryCode = (nonEmpty(pt.country_code) ?? "").toLowerCase();
  const isUSA = countryCode === USA_COUNTRY_CODE;
  const state = nonEmpty(pt.state);
  const country = nonEmpty(pt.country);

  // USA → State, else Country (cross-fallback same as backupLocationSegments).
  const top = isUSA ? (state ?? country) : (country ?? state);
  if (!top) return [];

  const rawCity = nonEmpty(pt.city);
  const locality = stripCivicPrefix(rawCity);
  // NYC rename scoped to NY state in the USA (matches backupLocationSegments).
  const city =
    locality === "New York" && isUSA && state === "New York"
      ? "New York City"
      : locality;

  return city ? [top, city] : [top];
}
