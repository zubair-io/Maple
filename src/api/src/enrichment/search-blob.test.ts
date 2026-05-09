/**
 * Pure-function tests for `composeSearchBlob` + the Mongo aggregation
 * expression shape. The aggregation pipeline is also exercised end-to-
 * end inside `ocr-worker.test.ts` against a real Mongo — these tests
 * cover only the pure logic.
 */

import { describe, it, expect } from "bun:test";
import {
  composeSearchBlob,
  searchBlobUpdateExpression,
} from "./search-blob.ts";
import type { Place } from "../db/schema.ts";

function placeWith(blob: string): Place {
  return {
    source: "nominatim",
    geocoder_version: 1,
    geocoded_at: "2026-05-09T00:00:00.000Z",
    lat: 0,
    lon: 0,
    display_name: null,
    address: {},
    pois: [],
    rollups: { locality: null, region: null, country_code: null },
    search_blob: blob,
  };
}

describe("composeSearchBlob", () => {
  it("returns empty string when every source is empty/missing", () => {
    expect(composeSearchBlob({})).toBe("");
    expect(
      composeSearchBlob({ place: null, description: null, ocrText: null }),
    ).toBe("");
    expect(
      composeSearchBlob({ description: "", ocrText: "" }),
    ).toBe("");
  });

  it("uses just the place blob when only place is set", () => {
    const out = composeSearchBlob({ place: placeWith("albany ny museum") });
    expect(out).toBe("albany museum ny");
  });

  it("merges all three sources, lowercases, dedups, and sorts", () => {
    const out = composeSearchBlob({
      place: placeWith("albany ny museum"),
      description: "A photograph of the New York State Museum exterior",
      ocrText: "MUSEUM ENTRANCE — ALBANY",
    });
    const tokens = out.split(" ");
    // Sorted alphabetically.
    expect(tokens).toEqual([...tokens].sort());
    // Dedup: "albany" + "museum" came from multiple sources and appear once.
    expect(tokens.filter((t) => t === "albany").length).toBe(1);
    expect(tokens.filter((t) => t === "museum").length).toBe(1);
    // Spot-check tokens from each source.
    expect(tokens).toContain("albany");
    expect(tokens).toContain("ny");
    expect(tokens).toContain("museum");
    expect(tokens).toContain("photograph");
    expect(tokens).toContain("entrance");
  });

  it("handles description-only input cleanly", () => {
    const out = composeSearchBlob({
      description: "Two cats on a windowsill",
    });
    expect(out.split(" ").sort()).toEqual([
      "a",
      "cats",
      "on",
      "two",
      "windowsill",
    ]);
  });

  it("handles ocr-only input cleanly", () => {
    const out = composeSearchBlob({
      ocrText: "Welcome\nto\tMaple",
    });
    // Tabs/newlines are whitespace.
    expect(out.split(" ").sort()).toEqual(["maple", "to", "welcome"]);
  });

  it("does not crash on weird whitespace and punctuation", () => {
    const out = composeSearchBlob({
      ocrText: "  Hello   World  \r\n  ",
      description: "  ",
    });
    expect(out).toBe("hello world");
  });
});

describe("searchBlobUpdateExpression", () => {
  it("with no overrides, references all three field paths", () => {
    const expr = searchBlobUpdateExpression();
    const json = JSON.stringify(expr);
    // Each source pulls from the row's current value.
    expect(json).toContain("$place.search_blob");
    expect(json).toContain("$description");
    expect(json).toContain("$ocr_text");
    // Pipeline shape: a $reduce whose input is a $sortArray over a $setUnion.
    expect(expr).toHaveProperty("$reduce");
    const reduce = (expr as { $reduce: Record<string, unknown> }).$reduce;
    expect(reduce.initialValue).toBe("");
    expect(reduce.input).toHaveProperty("$sortArray");
    // Tokenisation must handle CRLF/LF/CR/tab — the OCR text frequently
    // contains newlines, and Mongo `$split` only splits on the literal
    // delimiter so the expression has to pre-normalise.
    expect(json).toContain("\\r\\n");
    expect(json).toContain("\\n");
    expect(json).toContain("\\t");
  });

  it("supplied placeSearchBlob override replaces the field path", () => {
    const expr = searchBlobUpdateExpression({
      placeSearchBlob: "custom one two",
    });
    const json = JSON.stringify(expr);
    // Place override is in-line; the path is no longer referenced.
    expect(json).toContain("custom one two");
    expect(json).not.toContain("$place.search_blob");
    // Other two stay as field references.
    expect(json).toContain("$description");
    expect(json).toContain("$ocr_text");
  });

  it("supplied description and ocrText overrides replace those paths", () => {
    const expr = searchBlobUpdateExpression({
      description: "a cat",
      ocrText: "TEXT 1",
    });
    const json = JSON.stringify(expr);
    expect(json).toContain("a cat");
    expect(json).toContain("TEXT 1");
    expect(json).not.toContain("$description");
    expect(json).not.toContain("$ocr_text");
    // Place falls back to field reference.
    expect(json).toContain("$place.search_blob");
  });

  it("null override means 'no contribution from this source'", () => {
    const expr = searchBlobUpdateExpression({
      ocrText: null,
      description: null,
      placeSearchBlob: null,
    });
    const json = JSON.stringify(expr);
    // Field paths must not be referenced — every source is overridden.
    expect(json).not.toContain("$place.search_blob");
    expect(json).not.toContain("$description");
    expect(json).not.toContain("$ocr_text");
  });
});
