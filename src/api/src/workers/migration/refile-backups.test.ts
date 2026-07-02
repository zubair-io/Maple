/**
 * Unit tests for `computeCanonicalDir` — pure path/segment derivation (no DB).
 * Subsumes the geo, screenshot, and folder-flatten path logic of the three
 * migrations this replaces, so this suite ports their corpora into one table.
 * The Mongo-gated migration + describe-hook e2e live in `refile-backups.e2e.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { computeCanonicalDir } from "./refile-backups.ts";
import type { FileInfo, Place } from "../../db/schema.ts";

function fi(p: string, filename = "IMG.HEIC"): FileInfo {
  return { path: p, filename, library_id: new ObjectId(), deleted_at: null };
}

function place(p: {
  address?: Partial<Place["address"]>;
  rollups?: Partial<Place["rollups"]>;
  pois?: Place["pois"];
}): Place {
  return {
    source: "nominatim",
    geocoder_version: 1,
    geocoded_at: "2024-01-01T00:00:00.000Z",
    lat: 0,
    lon: 0,
    display_name: null,
    address: (p.address ?? {}) as Place["address"],
    pois: p.pois ?? [],
    rollups: {
      locality: null,
      region: null,
      country_code: null,
      ...(p.rollups ?? {}),
    },
    search_blob: "",
  };
}

describe("computeCanonicalDir — geo (subsumes computeGeoDir)", () => {
  test("old single-segment loc → year/Country/City", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/Tokyo")],
        place: place({
          address: { country: "Japan", country_code: "jp" },
          rollups: { locality: "Kyoto" },
        }),
      }),
    ).toBe("2024/Japan/Kyoto");
  });

  test("date fallback folder, USA → year/State/City", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/03")],
        place: place({
          address: {
            state: "California",
            country: "United States",
            country_code: "us",
          },
          rollups: { locality: "San Francisco", country_code: "us" },
        }),
      }),
    ).toBe("2024/California/San Francisco");
  });

  test("keeps the year the file already lives under (no cross-year move)", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2019/Paris")],
        place: place({
          address: { country: "France", country_code: "fr" },
          rollups: { locality: "Paris" },
        }),
        exif: { captured_year: 2024 },
      }),
    ).toBe("2019/France/Paris");
  });

  test("falls back to EXIF year when the path has no 4-digit lead", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("weird/loc")],
        place: place({
          address: { country: "France", country_code: "fr" },
          rollups: { locality: "Paris" },
        }),
        exif: { captured_year: 2021 },
      }),
    ).toBe("2021/France/Paris");
  });

  test("locality preferred over POI name", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/somewhere")],
        place: place({
          address: { country: "France", country_code: "fr" },
          rollups: { locality: "Paris" },
          pois: [
            { name: "24 rue Vignon", category: "building", type: "apartments" },
          ],
        }),
      }),
    ).toBe("2024/France/Paris");
  });

  test("falls back to POI name when no locality", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/somewhere")],
        place: place({
          address: { country: "France", country_code: "fr" },
          pois: [{ name: "Louvre", category: "tourism", type: "museum" }],
        }),
      }),
    ).toBe("2024/France/Louvre");
  });

  test("sanitises a slash in a segment into an underscore (no extra level)", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/x")],
        place: place({
          address: { country: "France", country_code: "fr" },
          rollups: { locality: "Aix/Marseille" },
        }),
      }),
    ).toBe("2024/France/Aix_Marseille");
  });

  test("THE regression: v2-frozen Paris POI path re-files to year/Country/City", () => {
    // The asset that surfaced the bug: stuck at "2026/24 rue Vignon" (a pre-geo
    // POI path) though its place now resolves to France/Paris.
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2026/24 rue Vignon", "IMG_0333.JPG")],
        place: place({
          address: {
            country: "France",
            country_code: "fr",
            state: "Île-de-France",
          },
          rollups: { locality: "Paris", country_code: "fr" },
          pois: [
            { name: "24 rue Vignon", category: "building", type: "apartments" },
          ],
        }),
        exif: { captured_year: 2026 },
      }),
    ).toBe("2026/France/Paris");
  });
});

describe("computeCanonicalDir — screenshot (subsumes computeScreenshotDir)", () => {
  function shot(p: string): {
    fileinfo: FileInfo[];
    is_screenshot: boolean;
    exif?: { captured_year?: number };
  } {
    return { fileinfo: [fi(p, "Screenshot.png")], is_screenshot: true };
  }

  test("date-folder screenshot → year/Screenshot", () => {
    expect(computeCanonicalDir(shot("2024/03"))).toBe("2024/Screenshot");
  });

  test("location-folder screenshot → year/Screenshot", () => {
    expect(computeCanonicalDir(shot("2024/California/San Francisco"))).toBe(
      "2024/Screenshot",
    );
  });

  test("old MM-DD day-folder screenshot → year/Screenshot (skips intermediate flatten)", () => {
    expect(computeCanonicalDir(shot("2019/05/12"))).toBe("2019/Screenshot");
  });

  test("already in year/Screenshot → no-op", () => {
    expect(computeCanonicalDir(shot("2024/Screenshot"))).toBe(
      "2024/Screenshot",
    );
  });

  test("screenshot WINS over geo location", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/03", "Screenshot.png")],
        is_screenshot: true,
        place: place({
          address: { country: "France", country_code: "fr" },
          rollups: { locality: "Paris" },
        }),
      }),
    ).toBe("2024/Screenshot");
  });

  test("keeps the year the file already lives under (no cross-year move)", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2019/08", "Screenshot.png")],
        is_screenshot: true,
        exif: { captured_year: 2024 },
      }),
    ).toBe("2019/Screenshot");
  });
});

describe("computeCanonicalDir — no location (subsumes restructureDir flatten)", () => {
  test("old <year>/<loc>/<MM-DD> day-folder → year/Misc", () => {
    expect(computeCanonicalDir({ fileinfo: [fi("2024/Tokyo/03-15")] })).toBe(
      "2024/Misc",
    );
  });

  test("old <year>/<MM>/<DD> day-folder → year/Misc", () => {
    expect(computeCanonicalDir({ fileinfo: [fi("2019/05/12")] })).toBe(
      "2019/Misc",
    );
  });

  test("stub place (no usable segments) → year/Misc", () => {
    expect(
      computeCanonicalDir({ fileinfo: [fi("2024/05")], place: place({}) }),
    ).toBe("2024/Misc");
  });

  test("already-flat new-layout dir with no place → year/Misc", () => {
    expect(computeCanonicalDir({ fileinfo: [fi("2024/Tokyo")] })).toBe(
      "2024/Misc",
    );
  });

  test("no location, capture month known → <year>/Misc (normalizes a junk folder)", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2026/2595")],
        exif: { captured_year: 2026, captured_month: 5 },
      }),
    ).toBe("2026/Misc");
  });

  test("stub place but capture month known → <year>/Misc (drops the stale loc)", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("2024/Tokyo/03-15")],
        place: place({}),
        exif: { captured_year: 2024, captured_month: 7 },
      }),
    ).toBe("2024/Misc");
  });
});

describe("computeCanonicalDir — degenerate", () => {
  test("no determinable year → null", () => {
    expect(
      computeCanonicalDir({
        fileinfo: [fi("weird")],
        place: place({ address: { country: "France", country_code: "fr" } }),
      }),
    ).toBeNull();
  });

  test("missing fileinfo → null", () => {
    expect(
      computeCanonicalDir({ place: place({ address: { country: "France" } }) }),
    ).toBeNull();
  });
});
