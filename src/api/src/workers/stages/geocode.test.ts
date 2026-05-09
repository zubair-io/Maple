import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import { CoordinateCache } from "../../enrichment/coordinate-cache.ts";
import { NominatimClient, NominatimError } from "../../enrichment/nominatim-client.ts";

import { geocodeHandler } from "./geocode.ts";

function fakeDoc(gps: { lat: number; lng: number } | null = { lat: 42.65, lng: -73.75 }): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: "/lib/test.dng",
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: "2024-06-01T12:00:00.000Z",
      captured_year: 2024,
      captured_month: 6,
      camera_make: null, camera_model: null, lens: null,
      iso: null, aperture: null, shutter: null, focal_length: null,
      gps,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as ImageDoc;
}

const MUSEUM_RESPONSE = {
  address: { city: "Albany", state: "New York", country_code: "us" },
  display_name: "Test Museum, Albany",
  category: "tourism",
  type: "museum",
  name: "Test Museum",
};

function fakeNominatim(body: unknown): NominatimClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: "http://nominatim.test",
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

function errorNominatim(status: number): NominatimClient {
  const fetchImpl = (async () =>
    new Response("{}", { status })) as unknown as typeof fetch;
  return new NominatimClient({
    baseUrl: "http://nominatim.test",
    fetchImpl,
    rateLimitPerSec: 1000,
  });
}

// Use a unique geocoderVersion per call to avoid MongoDB cache hits across
// tests (each test run must see cold-cache behaviour on first access).
let versionCounter = Date.now();
function freshCache(): CoordinateCache {
  return new CoordinateCache({ geocoderVersion: ++versionCounter });
}

function makeCtx(client: NominatimClient) {
  return { client, cache: freshCache() } as never;
}

describe("geocodeHandler — happy path", () => {
  it("returns patch with place populated from Nominatim response", async () => {
    const doc = fakeDoc();
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(MUSEUM_RESPONSE)));
    const patch = (result as { patch: { place: Record<string, unknown> } }).patch;
    expect(patch.place).toBeTruthy();
    expect(patch.place.display_name).toBe("Test Museum, Albany");
    expect(typeof patch.place.search_blob).toBe("string");
    expect(patch.place.lat).toBe(42.65);
    expect(patch.place.lon).toBe(-73.75);
  });

  it("uses cached place on second call for same coordinates", async () => {
    const cache = freshCache();
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return new Response(JSON.stringify(MUSEUM_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new NominatimClient({ baseUrl: "http://nominatim.test", fetchImpl, rateLimitPerSec: 1000 });
    const ctx = { client, cache } as never;
    await geocodeHandler(fakeDoc(), ctx);
    await geocodeHandler(fakeDoc(), ctx);
    expect(callCount).toBe(1);
  });

  it("returns skip when image has no GPS", async () => {
    const doc = fakeDoc(null);
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(MUSEUM_RESPONSE)));
    expect((result as { skip: string }).skip).toBeTruthy();
  });
});

describe("geocodeHandler — Nominatim errors", () => {
  it("5xx propagates as NominatimError (retryable)", async () => {
    const doc = fakeDoc();
    await expect(geocodeHandler(doc, makeCtx(errorNominatim(503))))
      .rejects.toBeInstanceOf(NominatimError);
  });

  it("4xx propagates as NominatimError (non-retryable)", async () => {
    const doc = fakeDoc();
    await expect(geocodeHandler(doc, makeCtx(errorNominatim(400))))
      .rejects.toBeInstanceOf(NominatimError);
  });
});

describe("geocodeHandler — lat/lon provenance", () => {
  it("place.lat/lon are taken from the asset's EXIF, not Nominatim response", async () => {
    const doc = fakeDoc({ lat: 42.65, lng: -73.75 });
    const bodyWithDifferentCoords = { ...MUSEUM_RESPONSE, lat: "99.9", lon: "99.9" };
    const result = await geocodeHandler(doc, makeCtx(fakeNominatim(bodyWithDifferentCoords)));
    const place = (result as { patch: { place: { lat: number; lon: number } } }).patch.place;
    expect(place.lat).toBe(42.65);
    expect(place.lon).toBe(-73.75);
  });
});
