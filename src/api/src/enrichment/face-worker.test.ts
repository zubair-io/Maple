/**
 * FaceWorker integration tests.
 *
 * Real Mongo (skip-pass when unreachable). The detector is mocked so CI
 * never depends on the real ONNX runtime / model files. A small fake JPEG
 * is written to the asset's thumb cache path so the worker can exercise
 * the file-presence check without `sharp` actually decoding anything.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
} from "mongodb";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { AssetDoc } from "../db/schema.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { FaceWorker, FACE_HANDLER_VERSION } from "./face-worker.ts";
import {
  setDefaultFaceDetectorForTests,
  type DetectedFace,
  type FaceDetector,
} from "./face-detector.ts";
import { cachePathFor } from "../fs/xmp.ts";

const TEST_DB = `maple_test_face_worker_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string | null = null;

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
    try { await c.close(); } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[face-worker.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "maple-face-worker-"));
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  setDefaultFaceDetectorForTests(null);
});

interface MockDetector extends FaceDetector {
  setNextDetections: (faces: DetectedFace[]) => void;
  setError: (err: Error | null) => void;
  detectCount: () => number;
  embedCount: () => number;
}

function mockDetector(): MockDetector {
  let nextDetections: DetectedFace[] = [];
  let nextErr: Error | null = null;
  let detectCount = 0;
  let embedCount = 0;
  return {
    detectFaces: async () => {
      detectCount++;
      if (nextErr) throw nextErr;
      return nextDetections;
    },
    embedFace: async () => {
      embedCount++;
      // Return a tiny embedding so we can assert it round-trips through
      // the detection-to-doc conversion. Real MobileFaceNet returns 512
      // floats; the worker doesn't care about the length.
      return new Float32Array([0.1, 0.2, 0.3, 0.4]);
    },
    setNextDetections: (faces) => { nextDetections = faces; nextErr = null; },
    setError: (err) => { nextErr = err; },
    detectCount: () => detectCount,
    embedCount: () => embedCount,
  };
}

interface SeedOpts {
  /** Asset id; auto-generated when omitted. */
  id?: ObjectId;
  /** Whether to drop a stub thumb file at the cache path. Default true. */
  withThumb?: boolean;
  lockedBy?: string | null;
  leaseExpiresAt?: string | null;
  doneAt?: string | null;
  attempts?: number;
  deadLetterAt?: string | null;
}

async function seedAsset(opts: SeedOpts = {}): Promise<{
  id: ObjectId;
  absPath: string;
}> {
  const c = assetsColl();
  const _id = opts.id ?? new ObjectId();
  const absPath = join(tmpRoot!, `${_id.toHexString()}.dng`);
  if (opts.withThumb !== false) {
    // Materialise a stub thumb file so cachePathFor's existsSync check
    // passes. The mock detector never actually decodes it.
    const thumbPath = cachePathFor(absPath, "thumbs");
    mkdirSync(dirname(thumbPath), { recursive: true });
    writeFileSync(thumbPath, "stub-jpeg-bytes");
  }
  await c.insertOne({
    _id,
    folder_id: new ObjectId(),
    filename: `${_id.toHexString()}.dng`,
    abs_path: absPath,
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
    enrichment: {
      geocode: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
      face: {
        done_at: opts.doneAt ?? null,
        locked_by: opts.lockedBy ?? null,
        lease_expires_at: opts.leaseExpiresAt ?? null,
        attempts: opts.attempts ?? 0,
        last_error: null,
        version: null,
        dead_letter_at: opts.deadLetterAt ?? null,
      },
      describe: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
    },
    place: null,
    faces: [],
    description: null,
  } as never);
  return { id: _id, absPath };
}

function assetsColl(): Collection<AssetDoc> {
  return db!.collection<AssetDoc>("assets");
}

function makeWorker(opts: {
  detector: MockDetector;
  workerId?: string;
  fixedNow?: Date;
  maxAttempts?: number;
  leaseMs?: number;
}): FaceWorker {
  return new FaceWorker({
    detector: opts.detector,
    workerId: opts.workerId,
    pollMs: 0,
    leaseMs: opts.leaseMs ?? 30 * 60 * 1000,
    maxAttempts: opts.maxAttempts,
    now: opts.fixedNow ? () => opts.fixedNow! : undefined,
    log: () => {},
  });
}

function fakeDetection(): DetectedFace {
  return {
    bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.5 },
    confidence: 0.95,
    landmarks: [
      { x: 0.2, y: 0.2 },
      { x: 0.4, y: 0.2 },
      { x: 0.3, y: 0.3 },
      { x: 0.22, y: 0.4 },
      { x: 0.38, y: 0.4 },
    ],
  };
}

describe("FaceWorker.tick — happy path", () => {
  it("claims pending asset, detects, embeds, writes faces + done_at", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset();
    const det = mockDetector();
    det.setNextDetections([fakeDetection()]);
    const worker = makeWorker({ detector: det });

    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.faces).toHaveLength(1);
    expect(doc!.faces![0]!.confidence).toBeCloseTo(0.95);
    expect(doc!.faces![0]!.bbox.x).toBeCloseTo(0.1);
    expect(doc!.faces![0]!.person_id).toBeNull();
    expect(doc!.faces![0]!.embedding).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
      expect.closeTo(0.4, 5),
    ] as never);
    expect(doc!.enrichment!.face.done_at).toBeTruthy();
    expect(doc!.enrichment!.face.version).toBe(FACE_HANDLER_VERSION);
    expect(doc!.enrichment!.face.locked_by).toBeNull();
    expect(doc!.enrichment!.face.lease_expires_at).toBeNull();
    expect(det.detectCount()).toBe(1);
    expect(det.embedCount()).toBe(1);
  });

  it("zero detections still completes successfully (faces=[])", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset();
    const det = mockDetector();
    det.setNextDetections([]);
    const worker = makeWorker({ detector: det });

    const result = await worker.tick();
    expect(result.kind).toBe("completed");
    if (result.kind === "completed") expect(result.faces).toEqual([]);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.faces).toEqual([]);
    expect(doc!.enrichment!.face.done_at).toBeTruthy();
    expect(det.embedCount()).toBe(0);
  });

  it("returns no-claim when nothing is pending", async () => {
    if (!mongoReachable) return;
    const det = mockDetector();
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(det.detectCount()).toBe(0);
  });

  it("ignores assets already done", async () => {
    if (!mongoReachable) return;
    await seedAsset({ doneAt: new Date().toISOString() });
    const det = mockDetector();
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("FaceWorker.claim — atomic single-winner", () => {
  it("only one of two parallel claim attempts wins", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset();
    const det = mockDetector();
    det.setNextDetections([]);
    const a = makeWorker({ detector: det, workerId: "worker-A" });
    const b = makeWorker({ detector: det, workerId: "worker-B" });

    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    const completed = [ra, rb].filter((r) => r.kind === "completed").length;
    const noClaim = [ra, rb].filter((r) => r.kind === "no-claim").length;
    expect(completed).toBe(1);
    expect(noClaim).toBe(1);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.face.done_at).toBeTruthy();
  });
});

describe("FaceWorker — lease expiry", () => {
  it("re-claims a row whose lease has expired", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset({
      lockedBy: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const det = mockDetector();
    det.setNextDetections([]);
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.face.done_at).toBeTruthy();
  });

  it("does NOT re-claim a row whose lease is still active", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      lockedBy: "live-worker",
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const det = mockDetector();
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(det.detectCount()).toBe(0);
  });
});

describe("FaceWorker — retry + dead-letter", () => {
  it("a detector throw increments attempts and releases the lock", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset();
    const det = mockDetector();
    det.setError(new Error("synthetic detector failure"));
    const worker = makeWorker({ detector: det, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.retryable).toBe(true);
    expect(result.kind === "failed" && result.deadLettered).toBe(false);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.face.attempts).toBe(1);
    expect(doc!.enrichment!.face.locked_by).toBeNull();
    expect(doc!.enrichment!.face.last_error).toMatch(/synthetic detector/);
    expect(doc!.enrichment!.face.dead_letter_at).toBeNull();
  });

  it("after maxAttempts retryable failures, dead-letters the row", async () => {
    if (!mongoReachable) return;
    const { id } = await seedAsset({ attempts: 4 });
    const det = mockDetector();
    det.setError(new Error("still broken"));
    const worker = makeWorker({ detector: det, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.face.attempts).toBe(5);
    expect(doc!.enrichment!.face.dead_letter_at).toBeTruthy();
  });

  it("missing thumbnail dead-letters immediately (non-retryable)", async () => {
    if (!mongoReachable) return;
    const { id, absPath } = await seedAsset({ withThumb: false });
    const thumbPath = cachePathFor(absPath, "thumbs");
    expect(existsSync(thumbPath)).toBe(false);

    const det = mockDetector();
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.retryable).toBe(false);
    expect(result.kind === "failed" && result.deadLettered).toBe(true);
    expect(det.detectCount()).toBe(0);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.face.dead_letter_at).toBeTruthy();
    expect(doc!.enrichment!.face.last_error).toMatch(/thumb-missing/);
  });

  it("dead-lettered rows are not re-claimed", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      deadLetterAt: new Date().toISOString(),
      attempts: 5,
    });
    const det = mockDetector();
    const worker = makeWorker({ detector: det });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("FaceWorker — circuit breaker passthrough", () => {
  it("circuit-open is reported when the breaker pauses calls", async () => {
    if (!mongoReachable) return;
    await seedAsset();
    const det = mockDetector();
    // Force-open breaker by feeding it failures up to threshold = 1.
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 60_000 });
    breaker.recordFailure(); // closed -> open
    const worker = new FaceWorker({
      detector: det,
      breaker,
      pollMs: 0,
      log: () => {},
    });
    const r = await worker.tick();
    expect(r.kind).toBe("circuit-open");
    expect(det.detectCount()).toBe(0);
  });
});
