/**
 * DescribeWorker integration tests.
 *
 * Real Mongo (skip-pass when unreachable). The provider is mocked — we
 * never call out to a real LLM in CI.
 *
 * Mirrors `geocode-worker.test.ts` so the two test surfaces evolve in
 * lockstep.
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
import type { AssetDoc } from "../db/schema.ts";
import {
  RemoteError,
  type DescribeProvider,
  type DescribeResult,
} from "./describe-providers/index.ts";
import {
  DescribeWorker,
  DESCRIBE_HANDLER_VERSION,
} from "./describe-worker.ts";

const TEST_DB = `maple_test_describe_worker_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

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
    console.log("[describe-worker.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
  await db!.collection("describe_spend").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../db/client.ts");
  await closeDb();
});

/** Programmable mock provider. Returns whatever's queued; tests can also
 * supply a thrown error per call to drive retry / dead-letter paths. */
interface MockProvider extends DescribeProvider {
  setResponses: (responses: ProviderResponse[]) => void;
  callCount: () => number;
}

type ProviderResponse =
  | { kind: "ok"; result: DescribeResult }
  | { kind: "throw"; error: Error };

function mockProvider(): MockProvider {
  let responses: ProviderResponse[] = [];
  let i = 0;
  const provider: MockProvider = {
    name: "ollama",
    async describe(_jpegBytes, _opts): Promise<DescribeResult> {
      const r = responses[Math.min(i++, responses.length - 1)];
      if (!r) {
        return {
          text: "default",
          cost_usd: 0,
          provider_info: {},
        };
      }
      if (r.kind === "throw") throw r.error;
      return r.result;
    },
    async health(): Promise<void> { /* no-op */ },
    setResponses: (r) => { responses = r; i = 0; },
    callCount: () => i,
  };
  return provider;
}

interface SeedOpts {
  lockedBy?: string | null;
  leaseExpiresAt?: string | null;
  doneAt?: string | null;
  attempts?: number;
  deadLetterAt?: string | null;
  description?: string | null;
}

async function seedAsset(opts: SeedOpts = {}): Promise<ObjectId> {
  const c = assetsColl();
  const _id = new ObjectId();
  await c.insertOne({
    _id,
    folder_id: new ObjectId(),
    filename: `${_id.toHexString()}.dng`,
    abs_path: `/lib/${_id.toHexString()}.dng`,
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
    } as never,
    enrichment: {
      geocode: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
      face: {
        done_at: null, locked_by: null, lease_expires_at: null,
        attempts: 0, last_error: null, version: null, dead_letter_at: null,
      },
      describe: {
        done_at: opts.doneAt ?? null,
        locked_by: opts.lockedBy ?? null,
        lease_expires_at: opts.leaseExpiresAt ?? null,
        attempts: opts.attempts ?? 0,
        last_error: null,
        version: null,
        dead_letter_at: opts.deadLetterAt ?? null,
      },
    },
    place: null,
    faces: [],
    description: opts.description ?? null,
  } as never);
  return _id;
}

function assetsColl(): Collection<AssetDoc> {
  return db!.collection<AssetDoc>("assets");
}

function makeWorker(opts: {
  provider: DescribeProvider;
  workerId?: string;
  fixedNow?: Date;
  maxAttempts?: number;
  leaseMs?: number;
  dailyCapUsd?: number;
}): DescribeWorker {
  return new DescribeWorker({
    provider: opts.provider,
    systemPrompt: "describe this",
    model: "llava:latest",
    dailyCapUsd: opts.dailyCapUsd ?? 5,
    workerId: opts.workerId,
    pollMs: 0,
    leaseMs: opts.leaseMs ?? 10 * 60 * 1000,
    maxAttempts: opts.maxAttempts,
    now: opts.fixedNow ? () => opts.fixedNow! : undefined,
    log: () => {},
    // Stub thumb reader — return a tiny dummy buffer; the mock provider
    // doesn't care about the bytes.
    readThumb: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
}

describe("DescribeWorker.tick — happy path", () => {
  it("claims a pending asset, captions it, and writes description + done_at", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      {
        kind: "ok",
        result: {
          text: "A red bicycle leaning against a brick wall.",
          cost_usd: 0,
          provider_info: { model: "llava:latest", eval_count: "42" },
        },
      },
    ]);
    const worker = makeWorker({ provider });

    const result = await worker.tick();
    expect(result.kind).toBe("completed");

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.description).toBe(
      "A red bicycle leaning against a brick wall.",
    );
    expect(doc!.description_meta?.provider).toBe("ollama");
    expect(doc!.description_meta?.model).toBe("llava:latest");
    expect(doc!.description_meta?.cost_usd).toBe(0);
    expect(doc!.enrichment!.describe.done_at).toBeTruthy();
    expect(doc!.enrichment!.describe.version).toBe(DESCRIBE_HANDLER_VERSION);
    expect(doc!.enrichment!.describe.locked_by).toBeNull();
    expect(doc!.enrichment!.describe.lease_expires_at).toBeNull();
  });

  it("returns no-claim when nothing is pending", async () => {
    if (!mongoReachable) return;
    const provider = mockProvider();
    const worker = makeWorker({ provider });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
    expect(provider.callCount()).toBe(0);
  });

  it("ignores assets already done", async () => {
    if (!mongoReachable) return;
    await seedAsset({ doneAt: new Date().toISOString() });
    const provider = mockProvider();
    const worker = makeWorker({ provider });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });

  it("ignores dead-lettered rows", async () => {
    if (!mongoReachable) return;
    await seedAsset({
      deadLetterAt: new Date().toISOString(),
      attempts: 5,
    });
    const provider = mockProvider();
    const worker = makeWorker({ provider });
    const result = await worker.tick();
    expect(result.kind).toBe("no-claim");
  });
});

describe("DescribeWorker — daily cost cap", () => {
  it("returns circuit-pause when today's spend already exceeds the cap", async () => {
    if (!mongoReachable) return;
    // Pre-seed today's spend over the cap.
    const today = new Date();
    const key = today.toISOString().slice(0, 10);
    await db!.collection("describe_spend").insertOne({
      _id: key,
      total_usd: 6.5,
      updated_at: Date.now(),
    } as never);
    await seedAsset();
    const provider = mockProvider();
    const worker = makeWorker({ provider, dailyCapUsd: 5 });

    const result = await worker.tick();
    expect(result.kind).toBe("circuit-pause");
    if (result.kind === "circuit-pause") {
      expect(result.reason).toBe("cap-exceeded");
      expect(result.spendUsd).toBeGreaterThanOrEqual(5);
    }
    // Provider was NOT called; the asset stays pending.
    expect(provider.callCount()).toBe(0);
    const doc = await assetsColl().findOne({});
    expect(doc!.enrichment!.describe.done_at).toBeNull();
    expect(doc!.enrichment!.describe.locked_by).toBeNull();
  });

  it("happy path increments today's spend", async () => {
    if (!mongoReachable) return;
    await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      {
        kind: "ok",
        result: { text: "caption", cost_usd: 0.0125, provider_info: {} },
      },
    ]);
    const worker = makeWorker({ provider, dailyCapUsd: 5 });
    await worker.tick();
    const today = new Date().toISOString().slice(0, 10);
    const spend = await db!
      .collection<{ _id: string; total_usd: number }>("describe_spend")
      .findOne({ _id: today });
    expect(spend?.total_usd).toBeCloseTo(0.0125, 6);
  });

  it("clears the pause once the cap is reset (cancel via cap reset)", async () => {
    if (!mongoReachable) return;
    const today = new Date().toISOString().slice(0, 10);
    await db!.collection("describe_spend").insertOne({
      _id: today,
      total_usd: 6,
      updated_at: Date.now(),
    } as never);
    await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      {
        kind: "ok",
        result: { text: "caption", cost_usd: 0.001, provider_info: {} },
      },
    ]);
    const worker = makeWorker({ provider, dailyCapUsd: 5 });
    expect((await worker.tick()).kind).toBe("circuit-pause");

    // Simulate a cap reset (operator zeroes today's row).
    await db!
      .collection("describe_spend")
      .updateOne({ _id: today }, { $set: { total_usd: 0 } });
    const second = await worker.tick();
    expect(second.kind).toBe("completed");
  });
});

describe("DescribeWorker — retry + dead-letter", () => {
  it("a 5xx increments attempts and releases the lock for re-claim", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      { kind: "throw", error: new RemoteError("Provider 5xx: 503", true, 503) },
    ]);
    const worker = makeWorker({ provider, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.retryable).toBe(true);
    expect(result.kind === "failed" && result.deadLettered).toBe(false);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.describe.attempts).toBe(1);
    expect(doc!.enrichment!.describe.locked_by).toBeNull();
    expect(doc!.enrichment!.describe.last_error).toMatch(/5xx|503/);
    expect(doc!.enrichment!.describe.dead_letter_at).toBeNull();
    expect(doc!.description).toBeNull();
  });

  it("after maxAttempts retryable failures, dead-letters the row", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset({ attempts: 4 }); // one more failure → dead-letter
    const provider = mockProvider();
    provider.setResponses([
      { kind: "throw", error: new RemoteError("Provider 5xx: 503", true, 503) },
    ]);
    const worker = makeWorker({ provider, maxAttempts: 5 });

    const result = await worker.tick();
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.describe.attempts).toBe(5);
    expect(doc!.enrichment!.describe.dead_letter_at).toBeTruthy();
  });

  it("a 4xx dead-letters immediately (non-retryable)", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      { kind: "throw", error: new RemoteError("Provider 4xx: 401", false, 401) },
    ]);
    const worker = makeWorker({ provider });

    const result = await worker.tick();
    expect(result.kind === "failed" && result.retryable).toBe(false);
    expect(result.kind === "failed" && result.deadLettered).toBe(true);

    const doc = await assetsColl().findOne({ _id: id });
    expect(doc!.enrichment!.describe.dead_letter_at).toBeTruthy();
  });
});

describe("DescribeWorker — provenance", () => {
  it("stores provider_info extras alongside canonical meta", async () => {
    if (!mongoReachable) return;
    const id = await seedAsset();
    const provider = mockProvider();
    provider.setResponses([
      {
        kind: "ok",
        result: {
          text: "two cats on a couch",
          cost_usd: 0.04,
          provider_info: { input_tokens: "120", output_tokens: "20" },
        },
      },
    ]);
    const worker = makeWorker({ provider });
    await worker.tick();

    const doc = await assetsColl().findOne({ _id: id });
    const meta = doc!.description_meta as Record<string, unknown>;
    expect(meta.provider).toBe("ollama");
    expect(meta.cost_usd).toBe(0.04);
    expect(meta.input_tokens).toBe("120");
    expect(meta.output_tokens).toBe("20");
    expect(typeof meta.generated_at).toBe("string");
  });
});
