/**
 * Nominatim `/reverse` response → `Place` schema.
 *
 * The Nominatim docs aren't a strict contract — fields are commonly missing
 * for water bodies, ocean coordinates, or places without OSM tags. Every
 * field on the input type is therefore optional, and the parser tolerates
 * holes by mapping to `undefined` (address fields) or empty arrays (POIs).
 *
 * Spec: `docs/indexer-enrichment.md` §4.4.
 */

import type {
  Place,
  PlaceAddress,
  PlacePoi,
  PlaceRollups,
} from "../db/schema.ts";

/** Subset of the Nominatim `/reverse` JSON we read. Defensive — every
 * field is optional because real-world responses vary by location type. */
export interface NominatimReverseResponse {
  /** Set on lookups that fail to resolve (e.g. open ocean). When present,
   * the rest of the response body is missing. */
  error?: string;

  lat?: string;
  lon?: string;

  /** Top-level OSM category/type for the resolved feature, e.g.
   * `category: "tourism"` + `type: "museum"`. Used to seed the POI list
   * even when `extratags` is empty. */
  category?: string;
  type?: string;
  /** Top-level "name" field — the human-friendly label for the resolved
   * feature, distinct from `display_name` which is the full address line. */
  name?: string;
  display_name?: string;

  address?: NominatimAddress;
  extratags?: Record<string, string>;
  namedetails?: Record<string, string>;
}

export interface NominatimAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  county?: string;
  state?: string;
  /** Mixed-key field, e.g. `"US-NY"`. The lvl is country-specific. */
  "ISO3166-2-lvl4"?: string;
  "ISO3166-2-lvl6"?: string;
  postcode?: string;
  country?: string;
  /** Lower-case ISO 3166-1 alpha-2, e.g. `"us"`. */
  country_code?: string;

  // POI-bearing fields. Present when the reverse-geocode hit a feature.
  amenity?: string;
  shop?: string;
  tourism?: string;
  leisure?: string;
  historic?: string;
  natural?: string;
}

const POI_ADDRESS_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "historic",
  "natural",
] as const satisfies ReadonlyArray<keyof NominatimAddress>;

/**
 * Parse a Nominatim `/reverse` response into the `Place` schema.
 *
 * `lat` and `lon` come from the original request, not the response — the
 * response's lat/lon may be the centroid of the matched feature, but we
 * want the coordinates the EXIF actually recorded.
 *
 * `geocoderVersion` lets §7.3 versioned-rerun migrations identify which
 * outputs need re-fetching after a parser bug fix.
 */
export function parseNominatimResponse(
  raw: NominatimReverseResponse,
  lat: number,
  lon: number,
  geocoderVersion: number,
  now: () => Date = () => new Date(),
): Place {
  const geocodedAt = now().toISOString();

  // Failed lookup: build a minimal stub so the worker can mark the asset
  // done without retrying. The `error` field signals "geocoded but
  // unresolvable" — still a completed enrichment, just with no data.
  if (raw.error || !raw.address) {
    return {
      source: "nominatim",
      geocoder_version: geocoderVersion,
      geocoded_at: geocodedAt,
      lat,
      lon,
      display_name: null,
      address: {},
      pois: [],
      rollups: {
        locality: null,
        region: null,
        country_code: null,
      },
      search_blob: "",
    };
  }

  const address = mapAddress(raw.address);
  const rollups = mapRollups(raw.address);
  const pois = mapPois(raw);

  return {
    source: "nominatim",
    geocoder_version: geocoderVersion,
    geocoded_at: geocodedAt,
    lat,
    lon,
    display_name: raw.display_name ?? null,
    address,
    pois,
    rollups,
    // Phase 3 builds the search blob; Phase 2 keeps it empty so the type
    // stays satisfied without preempting the search-index design.
    search_blob: "",
  };
}

function mapAddress(input: NominatimAddress): PlaceAddress {
  const out: PlaceAddress = {};
  if (input.house_number) out.house_number = input.house_number;
  if (input.road) out.road = input.road;
  if (input.neighbourhood) out.neighbourhood = input.neighbourhood;
  if (input.suburb) out.suburb = input.suburb;
  if (input.city) out.city = input.city;
  if (input.town) out.town = input.town;
  if (input.village) out.village = input.village;
  if (input.county) out.county = input.county;
  if (input.state) out.state = input.state;
  if (input.postcode) out.postcode = input.postcode;
  if (input.country) out.country = input.country;
  if (input.country_code) out.country_code = input.country_code;
  const stateCode = parseStateCode(input);
  if (stateCode) out.state_code = stateCode;
  return out;
}

/** "US-NY" → "NY". Nominatim emits this under `ISO3166-2-lvl4` for
 * countries whose level-4 subdivisions are states/regions; `lvl6` for
 * counties in some places. We prefer lvl4 — the user-facing search target
 * is "NY", not "Albany County". */
function parseStateCode(input: NominatimAddress): string | undefined {
  const raw = input["ISO3166-2-lvl4"];
  if (!raw) return undefined;
  const dash = raw.indexOf("-");
  if (dash < 0) return undefined;
  const code = raw.slice(dash + 1).trim();
  return code.length > 0 ? code : undefined;
}

function mapRollups(input: NominatimAddress): PlaceRollups {
  return {
    locality: input.city ?? input.town ?? input.village ?? input.hamlet ?? null,
    region: input.state ?? null,
    country_code: input.country_code ?? null,
  };
}

/**
 * Build the POI list. Two sources, in priority order:
 *
 * 1. Top-level `category` + `type` + `name` — the resolved feature itself.
 *    A reverse-geocode that landed inside a museum returns
 *    `category: "tourism", type: "museum", name: "New York State Museum"`
 *    at the top level. This is the "primary" POI for the location.
 *
 * 2. Address-bearing POI keys (`amenity`, `shop`, `tourism`, `leisure`,
 *    `historic`, `natural`) — secondary POIs co-located at the address.
 *    Each key's value is the POI name; the key itself is the category.
 *    The OSM `type` is unknown for these without an extra lookup, so we
 *    set `type` to the same string as `category` (the OSM convention is
 *    `category=type` for top-level keys; treat it as best-effort).
 *
 * Duplicates between (1) and (2) are deduped by `(name, category)`.
 */
function mapPois(raw: NominatimReverseResponse): PlacePoi[] {
  const pois: PlacePoi[] = [];
  const seen = new Set<string>();
  const push = (name: string, category: string, type: string): void => {
    const key = `${name}::${category}`;
    if (seen.has(key)) return;
    seen.add(key);
    pois.push({ name, category, type });
  };

  if (raw.category && raw.type && raw.name) {
    push(raw.name, raw.category, raw.type);
  }

  const address = raw.address;
  if (address) {
    for (const key of POI_ADDRESS_KEYS) {
      const value = address[key];
      if (typeof value === "string" && value.length > 0) {
        // Address-bearing POI keys carry the name as the value; we don't
        // know the OSM `type` from this alone, so fall back to the key.
        push(value, key, key);
      }
    }
  }

  return pois;
}
