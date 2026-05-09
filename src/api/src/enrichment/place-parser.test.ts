/**
 * Place parser tests — golden fixture (real Nominatim shape) + edge cases.
 */

import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  parseNominatimResponse,
  type NominatimReverseResponse,
} from "./place-parser.ts";

const FIXTURE_DIR = path.resolve(import.meta.dir, "../../test-fixtures");
const FIXED_NOW = () => new Date("2026-05-08T12:00:00.000Z");

describe("parseNominatimResponse — golden fixture", () => {
  it("maps a real museum reverse-geocode into the Place schema", async () => {
    const raw = JSON.parse(
      await fs.readFile(
        path.join(FIXTURE_DIR, "nominatim-reverse-museum.json"),
        "utf8",
      ),
    ) as NominatimReverseResponse;
    const place = parseNominatimResponse(raw, 42.6526, -73.7562, 1, FIXED_NOW);

    expect(place.source).toBe("nominatim");
    expect(place.geocoder_version).toBe(1);
    expect(place.geocoded_at).toBe("2026-05-08T12:00:00.000Z");
    expect(place.lat).toBe(42.6526);
    expect(place.lon).toBe(-73.7562);
    expect(place.display_name).toBe(
      "New York State Museum, 222, Madison Avenue, Mansion District, Downtown, Albany, Albany County, New York, 12230, United States",
    );

    expect(place.address).toEqual({
      house_number: "222",
      road: "Madison Avenue",
      neighbourhood: "Mansion District",
      suburb: "Downtown",
      city: "Albany",
      county: "Albany County",
      state: "New York",
      state_code: "NY",
      postcode: "12230",
      country: "United States",
      country_code: "us",
    });

    expect(place.rollups).toEqual({
      locality: "Albany",
      region: "New York",
      country_code: "us",
    });

    // Top-level `category=tourism, type=museum, name=...` is preserved as
    // the primary POI; the address-key `tourism: "New York State Museum"`
    // is deduped against it.
    expect(place.pois).toEqual([
      { name: "New York State Museum", category: "tourism", type: "museum" },
    ]);

    expect(place.search_blob).toBe("");
  });
});

describe("parseNominatimResponse — rollups fallback", () => {
  it("falls back to town when city is missing", () => {
    const raw: NominatimReverseResponse = {
      address: { town: "Saratoga Springs", country_code: "us" },
    };
    const place = parseNominatimResponse(raw, 0, 0, 1, FIXED_NOW);
    expect(place.rollups.locality).toBe("Saratoga Springs");
  });

  it("falls back to village then hamlet when town is missing", () => {
    const village = parseNominatimResponse(
      { address: { village: "Crailo" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(village.rollups.locality).toBe("Crailo");

    const hamlet = parseNominatimResponse(
      { address: { hamlet: "Schodack Landing" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(hamlet.rollups.locality).toBe("Schodack Landing");
  });

  it("returns null locality / region when address is empty", () => {
    const place = parseNominatimResponse(
      { address: {} },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(place.rollups.locality).toBeNull();
    expect(place.rollups.region).toBeNull();
    expect(place.rollups.country_code).toBeNull();
  });
});

describe("parseNominatimResponse — state code parsing", () => {
  it("extracts NY from ISO3166-2-lvl4: US-NY", () => {
    const place = parseNominatimResponse(
      { address: { "ISO3166-2-lvl4": "US-NY", state: "New York" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(place.address.state_code).toBe("NY");
  });

  it("returns undefined when ISO3166-2-lvl4 is missing", () => {
    const place = parseNominatimResponse(
      { address: { state: "New York" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(place.address.state_code).toBeUndefined();
  });

  it("returns undefined when ISO3166-2-lvl4 has no dash", () => {
    const place = parseNominatimResponse(
      { address: { "ISO3166-2-lvl4": "USNY" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(place.address.state_code).toBeUndefined();
  });
});

describe("parseNominatimResponse — POIs", () => {
  it("emits a POI from each address-bearing key", () => {
    const raw: NominatimReverseResponse = {
      address: {
        amenity: "Public Library",
        shop: "Bookstore",
        leisure: "Park",
      },
    };
    const place = parseNominatimResponse(raw, 0, 0, 1, FIXED_NOW);
    expect(place.pois).toEqual([
      { name: "Public Library", category: "amenity", type: "amenity" },
      { name: "Bookstore", category: "shop", type: "shop" },
      { name: "Park", category: "leisure", type: "leisure" },
    ]);
  });

  it("dedupes top-level POI against address-key POI with same (name, category)", () => {
    const raw: NominatimReverseResponse = {
      category: "tourism",
      type: "museum",
      name: "Albany Institute",
      address: { tourism: "Albany Institute" },
    };
    const place = parseNominatimResponse(raw, 0, 0, 1, FIXED_NOW);
    expect(place.pois).toEqual([
      { name: "Albany Institute", category: "tourism", type: "museum" },
    ]);
  });

  it("emits no POIs when no top-level category and no address-bearing keys", () => {
    const place = parseNominatimResponse(
      { address: { city: "Albany" } },
      0,
      0,
      1,
      FIXED_NOW,
    );
    expect(place.pois).toEqual([]);
  });
});

describe("parseNominatimResponse — failed lookup", () => {
  it("returns a stub Place when Nominatim emits {error}", () => {
    const place = parseNominatimResponse(
      { error: "Unable to geocode" },
      55.5,
      -130.2,
      1,
      FIXED_NOW,
    );
    expect(place).toEqual({
      source: "nominatim",
      geocoder_version: 1,
      geocoded_at: "2026-05-08T12:00:00.000Z",
      lat: 55.5,
      lon: -130.2,
      display_name: null,
      address: {},
      pois: [],
      rollups: { locality: null, region: null, country_code: null },
      search_blob: "",
    });
  });

  it("treats a response without an `address` object as an unresolved hit", () => {
    const place = parseNominatimResponse(
      { display_name: "Open ocean" },
      0,
      -180,
      1,
      FIXED_NOW,
    );
    expect(place.display_name).toBeNull();
    expect(place.address).toEqual({});
    expect(place.rollups.locality).toBeNull();
  });
});

describe("parseNominatimResponse — provenance", () => {
  it("records the request lat/lon, not the response lat/lon", () => {
    const raw: NominatimReverseResponse = {
      lat: "99.9",
      lon: "99.9",
      address: { city: "Albany" },
    };
    const place = parseNominatimResponse(raw, 42.6526, -73.7562, 1, FIXED_NOW);
    expect(place.lat).toBe(42.6526);
    expect(place.lon).toBe(-73.7562);
  });

  it("propagates the geocoderVersion supplied by the worker", () => {
    const place = parseNominatimResponse(
      { address: { city: "x" } },
      0,
      0,
      7,
      FIXED_NOW,
    );
    expect(place.geocoder_version).toBe(7);
  });
});
