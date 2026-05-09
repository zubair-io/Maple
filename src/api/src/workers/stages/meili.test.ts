import { describe, it, expect } from "bun:test";
import { ObjectId } from "mongodb";
import type { ImageDoc } from "../runtime/define-stage.ts";
import type { MeilisearchClient, MeilisearchAssetDoc } from "../../enrichment/meilisearch-client.ts";

import { meiliHandler } from "./meili.ts";

function fakeDoc(overrides: Partial<ImageDoc> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    folder_id: new ObjectId(),
    filename: "test.dng",
    abs_path: "/lib/test.dng",
    // maple_id is an IndexerAssetFields extension; cast through unknown for test setup.
    ...({ maple_id: "maple-abc-123" } as unknown as Partial<ImageDoc>),
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
      iso: null, aperture: null, shutter: null, focal_length: null, gps: null,
    },
    faces: [],
    description: "A red bicycle",
    // ocr_text is on AssetDoc; cast through unknown for test setup.
    ...({ ocr_text: "BIKE SHOP" } as unknown as Partial<ImageDoc>),
    place: {
      source: "nominatim",
      geocoder_version: 1,
      geocoded_at: "2024-06-01T00:00:00.000Z",
      lat: 42.65,
      lon: -73.75,
      display_name: "Albany",
      address: {},
      pois: [],
      rollups: { locality: "Albany", region: "NY", country_code: "us" },
      search_blob: "albany ny",
    },
    stages: {},
    ...overrides,
  } as ImageDoc;
}

function capturingClient(): { client: MeilisearchClient; upserts: MeilisearchAssetDoc[] } {
  const upserts: MeilisearchAssetDoc[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => { upserts.push(doc); },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { client, upserts };
}

function failingClient(): MeilisearchClient {
  return {
    isConfigured: () => true,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => { throw new Error("simulated meili failure"); },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

describe("meiliHandler — upsert payload shape", () => {
  it("upserts with correct id, folderId, capturedAt, searchBlob, description, ocrText", async () => {
    const { client, upserts } = capturingClient();
    const doc = fakeDoc();
    const result = await meiliHandler(doc, { meilisearch: client } as never);
    expect((result as { wrote: boolean }).wrote).toBe(true);
    expect(upserts.length).toBe(1);
    const u = upserts[0]!;
    expect(u.id).toBe("maple-abc-123");
    expect(u.folderId).toBe(doc.folder_id.toHexString());
    expect(u.capturedAt).toBe("2024-06-01T12:00:00.000Z");
    expect(u.deletedAt).toBeNull();
    expect(u.description).toBe("A red bicycle");
    expect(u.ocrText).toBe("BIKE SHOP");
    // Unified blob must include tokens from all three sources.
    const tokens = u.searchBlob.split(" ");
    expect(tokens).toContain("albany");    // place
    expect(tokens).toContain("bicycle");   // description
    expect(tokens).toContain("bike");      // OCR
    expect(tokens).toContain("shop");      // OCR
    // Blob is sorted + deduped.
    expect(tokens).toEqual([...tokens].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("meiliHandler — no maple_id", () => {
  it("returns { wrote: true } and skips the upsert when maple_id is absent", async () => {
    const { client, upserts } = capturingClient();
    // Override to drop maple_id — cast through unknown since it's not on ImageDoc's
    // base type (it's an IndexerAssetFields extension).
    const doc = { ...fakeDoc(), ...({ maple_id: undefined } as unknown as Partial<ImageDoc>) } as ImageDoc;
    const result = await meiliHandler(doc, { meilisearch: client } as never);
    expect((result as { wrote: boolean }).wrote).toBe(true);
    expect(upserts.length).toBe(0);
  });
});

describe("meiliHandler — Meilisearch error tolerance", () => {
  it("Meilisearch upsert failure results in handler throw so runtime retries", async () => {
    const doc = fakeDoc();
    await expect(
      meiliHandler(doc, { meilisearch: failingClient() } as never),
    ).rejects.toThrow("simulated meili failure");
  });
});

describe("meiliHandler — null enrichment fields", () => {
  it("produces a valid (possibly empty) blob when description and ocr_text are null", async () => {
    const { client, upserts } = capturingClient();
    const doc = { ...fakeDoc(), description: null, ...({ ocr_text: null } as unknown as Partial<ImageDoc>) } as ImageDoc;
    await meiliHandler(doc, { meilisearch: client } as never);
    expect(upserts.length).toBe(1);
    const blob = upserts[0]!.searchBlob;
    // Place tokens still contribute.
    expect(blob.split(" ")).toContain("albany");
  });
});
