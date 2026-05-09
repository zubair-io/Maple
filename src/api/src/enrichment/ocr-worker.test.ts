/**
 * OcrWorker integration tests.
 *
 * Real Mongo (skip-pass when unreachable) + a stub OCR engine so we
 * never have to ship the tesseract.js wasm in CI. The thumbnail file is
 * created on a tmp dir per-test; `cachePathFor` derives the path from
 * the asset's abs_path so the worker reads it the same way production
 * does.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "bun:test";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { AssetDoc } from "../db/schema.ts";
import { cachePathFor } from "../fs/xmp.ts";
import type { MeilisearchClient } from "./meilisearch-client.ts";
import { setMeilisearchClientForTests } from "./meilisearch-client.ts";
import {
  OcrWorker,
  OCR_HANDLER_VERSION,
} from "./ocr-worker.ts";
import type { OcrEngine, RecognitionResult } from "./ocr-engine.ts";

const TEST_DB = `maple_test_ocr_worker_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string | null = null;
const PRIOR_ROOTS = process.env.MAPLE_ROOTS;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[ocr-worker.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-ocr-test-"));
  // Make our tmp library a permitted root so `cachePathFor` writes can
  // happen without tripping safeWriteAllowed (the worker only reads,
  // but the test seed writes a thumb file).
  process.env.MAPLE_ROOTS = tmpRoot;
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
});

afterEach(() => {
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  if (tmpRoot) {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
  if (PRIOR_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = PRIOR_ROOTS;
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

function assetsColl(): Collection<AssetDoc> {
  return db!.collection<AssetDoc>("assets");
}

interface SeedOpts {
  withThumb?: boolean;
  thumbBytes?: Uint8Array;
  description?: string | null;
  ocrDoneAt?: string | null;
  ocrAttempts?: number;
  ocrDeadLetterAt?: string | null;
  ocrLockedBy?: string | null;
  ocrLeaseExpiresAt?: string | null;
  mapleId?: string;
  /** Override the asset's abs_path. Defaults to a tmp-dir file. */
  absPath?: string;
}

async function seedAsset(opts: SeedOpts = {}): Promise<{
  _id: ObjectId;
  abs_path: string;
}> {
  const _id = new ObjectId();
  const abs_path = opts.absPath ?? path.join(tmpRoot!, `${_id.toHexString()}.dng`);
  const thumbPath = cachePathFor(abs_path, "thumbs");
  if (opts.withThumb !== false) {
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await fs.writeFile(
      thumbPath,
      opts.thumbBytes ? Buffer.from(opts.thumbBytes) : Buffer.from([0xff, 0xd8, 0xff]),
    );
  }
  const doc: Partial<AssetDoc> & { maple_id?: string } = {
    folder_id: new ObjectId(),
    filename: path.basename(abs_path),
    abs_path,
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
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    },
    description: opts.description ?? null,
    enrichment: {
      geocode: pendingState(),
      face: pendingState(),
      describe: pendingState(),
      ocr: {
        done_at: opts.ocrDoneAt ?? null,
        locked_by: opts.ocrLockedBy ?? null,
        lease_expires_at: opts.ocrLeaseExpiresAt ?? null,
        attempts: opts.ocrAttempts ?? 0,
        last_error: null,
        version: null,
        dead_letter_at: opts.ocrDeadLetterAt ?? null,
      },
    },
  };
  if (opts.mapleId !== undefined) doc.maple_id = opts.mapleId;
  await assetsColl().insertOne({ _id, ...(doc as AssetDoc) });
  return { _id, abs_path };
}

function pendingState() {
  return {
    done_at: null,
    locked_by: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    version: null,
    dead_letter_at: null,
  };
}

function fakeEngine(text: string): OcrEngine {
  return {
    async recognizeText(): Promise<RecognitionResult> {
      return {
        text,
        engine: "tesseract",
        engine_version: "tesseract@5.1",
      };
    },
    async shutdown(): Promise<void> {},
  };
}

function throwingEngine(err: Error): OcrEngine {
  return {
    async recognizeText(): Promise<RecognitionResult> {
      throw err;
    },
    async shutdown(): Promise<void> {},
  };
}

describe("OcrWorker.tick — happy path", () => {
  it("claims, recognises, writes ocr_text + ocr_meta + search_blob", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset();
    const worker = new OcrWorker({
      engine: fakeEngine("Welcome to Maple\nALBANY MUSEUM"),
      pollMs: 0,
      log: () => {},
    });

    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const after = await assetsColl().findOne({ _id });
    expect(after!.ocr_text).toBe("Welcome to Maple\nALBANY MUSEUM");
    expect(after!.ocr_meta).toEqual({
      engine: "tesseract",
      engine_version: "tesseract@5.1",
      generated_at: expect.any(String),
    });
    expect(after!.enrichment!.ocr.done_at).toBeTruthy();
    expect(after!.enrichment!.ocr.version).toBe(OCR_HANDLER_VERSION);
    expect(after!.enrichment!.ocr.locked_by).toBeNull();
    expect(after!.enrichment!.ocr.lease_expires_at).toBeNull();

    // search_blob is the unified field, recomputed from the live row
    // state. Description was null and place was null, so only OCR
    // tokens contribute. Lowercased + sorted.
    const blob = (after as { search_blob?: string }).search_blob;
    expect(typeof blob).toBe("string");
    const tokens = blob!.split(" ");
    expect(tokens).toContain("welcome");
    expect(tokens).toContain("albany");
    expect(tokens).toContain("museum");
    expect(tokens).toEqual([...tokens].sort());
  });

  it("returns no-claim when nothing is pending", async () => {
    if (!mongoReachable) return;
    const worker = new OcrWorker({
      engine: fakeEngine(""),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });

  it("ignores assets already done", async () => {
    if (!mongoReachable) return;
    await seedAsset({ ocrDoneAt: new Date().toISOString() });
    const worker = new OcrWorker({
      engine: fakeEngine("ignored"),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });

  it("ignores assets in the dead-letter state", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      ocrDeadLetterAt: new Date().toISOString(),
      ocrAttempts: 5,
    });
    const worker = new OcrWorker({
      engine: fakeEngine("ignored"),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("OcrWorker.complete — search_blob composition", () => {
  it("merges OCR text with existing place + description tokens", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset({
      description: "Two cats on a windowsill",
    });
    // Add a place document directly so the worker sees it on claim.
    await assetsColl().updateOne(
      { _id },
      {
        $set: {
          place: {
            source: "nominatim",
            geocoder_version: 1,
            geocoded_at: "2026-05-01T00:00:00.000Z",
            lat: 0,
            lon: 0,
            display_name: null,
            address: {},
            pois: [],
            rollups: { locality: null, region: null, country_code: null },
            search_blob: "albany ny museum",
          },
        },
      },
    );

    const worker = new OcrWorker({
      engine: fakeEngine("ENTRANCE"),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const after = await assetsColl().findOne({ _id });
    const blob = (after as { search_blob?: string }).search_blob;
    expect(typeof blob).toBe("string");
    const tokens = blob!.split(" ");
    // Each source contributes.
    expect(tokens).toContain("albany");        // place
    expect(tokens).toContain("museum");        // place
    expect(tokens).toContain("ny");            // place
    expect(tokens).toContain("cats");          // description
    expect(tokens).toContain("windowsill");    // description
    expect(tokens).toContain("entrance");      // OCR
    // Sorted + deduped.
    expect(tokens).toEqual([...tokens].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("OcrWorker — Meilisearch sync", () => {
  it("complete() upserts all three fields when maple_id is set", async () => {
    if (!mongoReachable) return;
    const upserts: Array<Record<string, unknown>> = [];
    const meili: MeilisearchClient = {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async (doc) => {
        upserts.push(doc);
      },
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    };
    setMeilisearchClientForTests(meili);

    await seedAsset({ mapleId: "maple-foo", description: "a cat" });
    const worker = new OcrWorker({
      engine: fakeEngine("HELLO"),
      meilisearch: meili,
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    expect(upserts.length).toBe(1);
    const u = upserts[0]!;
    expect(u.id).toBe("maple-foo");
    expect(u.ocrText).toBe("HELLO");
    expect(u.description).toBe("a cat");
    // Unified blob in the upsert mirrors the asset.search_blob.
    expect(typeof u.searchBlob).toBe("string");
    expect((u.searchBlob as string).split(" ")).toContain("hello");
  });

  it("skips Meilisearch upsert when row has no maple_id", async () => {
    if (!mongoReachable) return;
    const upserts: Array<Record<string, unknown>> = [];
    const meili: MeilisearchClient = {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async (doc) => {
        upserts.push(doc);
      },
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    };
    await seedAsset();
    const worker = new OcrWorker({
      engine: fakeEngine("HELLO"),
      meilisearch: meili,
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");
    expect(upserts.length).toBe(0);
  });

  it("Meilisearch upsert error does NOT break the Mongo write", async () => {
    if (!mongoReachable) return;
    const meili: MeilisearchClient = {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {
        throw new Error("simulated meili failure");
      },
      tombstone: async () => {},
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    };
    const { _id } = await seedAsset({ mapleId: "maple-foo" });
    const worker = new OcrWorker({
      engine: fakeEngine("HI"),
      meilisearch: meili,
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");
    const after = await assetsColl().findOne({ _id });
    expect(after!.ocr_text).toBe("HI");
    expect(after!.enrichment!.ocr.done_at).toBeTruthy();
  });
});

describe("OcrWorker — failure modes", () => {
  it("ENOENT on the thumb retries and releases the lock", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset({ withThumb: false });
    const worker = new OcrWorker({
      engine: fakeEngine("never called"),
      pollMs: 0,
      maxAttempts: 5,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.retryable).toBe(true);
    expect(result.kind === "failed" && result.deadLettered).toBe(false);

    const after = await assetsColl().findOne({ _id });
    expect(after!.enrichment!.ocr.attempts).toBe(1);
    expect(after!.enrichment!.ocr.locked_by).toBeNull();
    expect(after!.enrichment!.ocr.dead_letter_at).toBeNull();
  });

  it("a tesseract throw dead-letters immediately (non-retryable)", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset();
    const worker = new OcrWorker({
      engine: throwingEngine(new Error("tesseract crashed")),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind === "failed" && result.retryable).toBe(false);
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const after = await assetsColl().findOne({ _id });
    expect(after!.enrichment!.ocr.dead_letter_at).toBeTruthy();
  });

  it("after maxAttempts ENOENT failures, dead-letters", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset({ withThumb: false, ocrAttempts: 4 });
    const worker = new OcrWorker({
      engine: fakeEngine("ignored"),
      pollMs: 0,
      maxAttempts: 5,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind === "failed" && result.deadLettered).toBe(true);
    const after = await assetsColl().findOne({ _id });
    expect(after!.enrichment!.ocr.attempts).toBe(5);
    expect(after!.enrichment!.ocr.dead_letter_at).toBeTruthy();
  });
});

describe("OcrWorker.claim — atomic single-winner + lease expiry", () => {
  it("only one of two parallel claim attempts wins", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset();
    const a = new OcrWorker({
      engine: fakeEngine("text"),
      workerId: "ocr-A",
      pollMs: 0,
      log: () => {},
    });
    const b = new OcrWorker({
      engine: fakeEngine("text"),
      workerId: "ocr-B",
      pollMs: 0,
      log: () => {},
    });
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const completed = [ra, rb].filter((r) => r.kind === "completed").length;
    const noClaim = [ra, rb].filter((r) => r.kind === "no-claim").length;
    expect(completed).toBe(1);
    expect(noClaim).toBe(1);

    const after = await assetsColl().findOne({ _id });
    expect(after!.enrichment!.ocr.done_at).toBeTruthy();
  });

  it("re-claims a row whose lease has expired", async () => {
    if (!mongoReachable) return;
    const { _id } = await seedAsset({
      ocrLockedBy: "dead-worker",
      ocrLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const worker = new OcrWorker({
      engine: fakeEngine("recovered"),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");
    const after = await assetsColl().findOne({ _id });
    expect(after!.ocr_text).toBe("recovered");
  });

  it("does NOT re-claim a row whose lease is still active", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      ocrLockedBy: "live-worker",
      ocrLeaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const worker = new OcrWorker({
      engine: fakeEngine("ignored"),
      pollMs: 0,
      log: () => {},
    });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});
