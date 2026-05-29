import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveBackupLocation,
  setIngestGeocodeDepsForTests,
} from "../src/backup/ingest-geocode.ts";
import type { CoordinateCache } from "../src/enrichment/coordinate-cache.ts";
import { quantizedKey } from "../src/enrichment/coordinate-cache.ts";
import type { NominatimClient } from "../src/enrichment/nominatim-client.ts";
import type { Place } from "../src/db/schema.ts";
import type { NominatimReverseResponse } from "../src/enrichment/place-parser.ts";

// Mongo-free coverage for the ingest-path geocoder. The end-to-end "GPS →
// geocoded path" assertion lives in backup-ingest.test.ts (which needs a live
// MongoDB); this drives resolveBackupLocation directly with injected deps so
// the cache/live/dedup/soft-fail branches run on any CI runner.

/** In-memory stand-in for CoordinateCache (get/set/keyFor are all the module
 * touches). */
function fakeCache() {
  const store = new Map<string, Place>();
  let getCalls = 0;
  const cache = {
    async get(lat: number, lon: number): Promise<Place | null> {
      getCalls++;
      return store.get(quantizedKey(lat, lon)) ?? null;
    },
    async set(lat: number, lon: number, place: Place): Promise<void> {
      store.set(quantizedKey(lat, lon), place);
    },
    keyFor: (lat: number, lon: number) => quantizedKey(lat, lon),
  };
  return {
    cache: cache as unknown as CoordinateCache,
    store,
    getCalls: () => getCalls,
  };
}

/** Stub NominatimClient whose reverse() returns a canned response after a
 * microtask (so concurrent callers actually overlap), counting calls. */
function fakeClient(
  response: NominatimReverseResponse | (() => Promise<never>),
) {
  let calls = 0;
  const client = {
    async reverse(): Promise<NominatimReverseResponse> {
      calls++;
      await Promise.resolve();
      if (typeof response === "function") return response();
      return response;
    },
  };
  return { client: client as unknown as NominatimClient, calls: () => calls };
}

const PARIS: NominatimReverseResponse = {
  display_name: "Paris, France",
  address: { city: "Paris", country_code: "fr" },
} as unknown as NominatimReverseResponse;

afterEach(() => setIngestGeocodeDepsForTests(null));

describe("resolveBackupLocation", () => {
  test("non-finite coordinates → null, no lookup", async () => {
    const c = fakeClient(PARIS);
    setIngestGeocodeDepsForTests({
      client: c.client,
      cache: fakeCache().cache,
    });
    expect(await resolveBackupLocation(NaN, NaN)).toBeNull();
    expect(c.calls()).toBe(0);
  });

  test("warm cache hit → name, no live lookup", async () => {
    const fc = fakeCache();
    await fc.cache.set(48.8566, 2.3522, {
      pois: [{ name: "Louvre" }],
      rollups: { locality: "Paris" },
    } as unknown as Place);
    const c = fakeClient(PARIS);
    setIngestGeocodeDepsForTests({ client: c.client, cache: fc.cache });

    expect(await resolveBackupLocation(48.8566, 2.3522)).toBe("Louvre");
    expect(c.calls()).toBe(0);
  });

  test("cache miss → live geocode resolves locality + caches it", async () => {
    const fc = fakeCache();
    const c = fakeClient(PARIS);
    setIngestGeocodeDepsForTests({ client: c.client, cache: fc.cache });

    expect(await resolveBackupLocation(48.8566, 2.3522)).toBe("Paris");
    expect(c.calls()).toBe(1);
    // Cached for next time — a second call doesn't hit the client.
    expect(await resolveBackupLocation(48.8566, 2.3522)).toBe("Paris");
    expect(c.calls()).toBe(1);
  });

  test("concurrent misses for one location share a single live lookup", async () => {
    const fc = fakeCache();
    const c = fakeClient(PARIS);
    setIngestGeocodeDepsForTests({ client: c.client, cache: fc.cache });

    const [a, b, d] = await Promise.all([
      resolveBackupLocation(48.8566, 2.3522),
      resolveBackupLocation(48.8566, 2.3522),
      resolveBackupLocation(48.8566, 2.3522),
    ]);
    expect([a, b, d]).toEqual(["Paris", "Paris", "Paris"]);
    expect(c.calls()).toBe(1);
  });

  test("live geocode failure → null (soft), upload not blocked", async () => {
    const fc = fakeCache();
    const c = fakeClient(() => Promise.reject(new Error("nominatim down")));
    setIngestGeocodeDepsForTests({ client: c.client, cache: fc.cache });

    expect(await resolveBackupLocation(48.8566, 2.3522)).toBeNull();
    expect(c.calls()).toBe(1);
  });

  test("no geocoder configured → cache miss returns null (date-only path)", async () => {
    const fc = fakeCache();
    setIngestGeocodeDepsForTests({ client: null, cache: fc.cache });
    expect(await resolveBackupLocation(48.8566, 2.3522)).toBeNull();
  });

  test("unresolvable location (Nominatim error stub) → null, still cached", async () => {
    const fc = fakeCache();
    const c = fakeClient({
      error: "Unable to geocode",
    } as unknown as NominatimReverseResponse);
    setIngestGeocodeDepsForTests({ client: c.client, cache: fc.cache });

    expect(await resolveBackupLocation(10, 10)).toBeNull();
    expect(c.calls()).toBe(1);
    // Cached as a (nameless) Place so siblings don't re-query.
    expect(await resolveBackupLocation(10, 10)).toBeNull();
    expect(c.calls()).toBe(1);
  });
});
