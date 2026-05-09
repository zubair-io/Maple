/**
 * Dead-letter triage repo tests.
 *
 * Per `docs/workers-architecture.md` §6 / §11: the indexer's `dead_letter`
 * collection is a sink today. This file exercises the three triage extensions
 * (`filterDeadLetter`, `groupDeadLetterByError`, `resetDeadLetter`) before any
 * third-party handlers ship and start dropping rows in.
 *
 * Round-trips against a real MongoDB; skip-passes if no instance is reachable
 * (mirrors the `indexer-images-repo.test.ts` integration pattern).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, type Db } from "mongodb";
import type { DeadLetterDoc } from "../src/indexer/indexer.repo.ts";

// Each bun process gets its own DB so concurrent test shards don't collide.
const TEST_DB = `maple_test_dead_letter_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const COLL = "indexer_dead_letter";

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
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log(
      "[indexer-dead-letter.test] skipping: MongoDB unreachable at",
      MONGO_URI,
    );
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  // Reset the singleton so getDb() reads MAPLE_MONGO_DB on next call.
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection(COLL).deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

function seed(doc: Partial<DeadLetterDoc>): DeadLetterDoc {
  const now = doc.lastFailedAt ?? new Date().toISOString();
  return {
    key: doc.key ?? "default-key",
    stage: doc.stage ?? "ai",
    absPath: doc.absPath ?? "/lib/default.dng",
    error: doc.error ?? "boom",
    attempts: doc.attempts ?? 3,
    firstFailedAt: doc.firstFailedAt ?? now,
    lastFailedAt: now,
  };
}

async function insertAll(rows: DeadLetterDoc[]): Promise<void> {
  await db!
    .collection<DeadLetterDoc>(COLL)
    .insertMany(rows as unknown as DeadLetterDoc[]);
}

// ---------------------------------------------------------------------------
// filterDeadLetter
// ---------------------------------------------------------------------------

describe("filterDeadLetter", () => {
  it("filters by stage", async () => {
    if (!mongoReachable) return;
    const { filterDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({ key: "k1", stage: "ai", error: "AI: rate limited" }),
      seed({ key: "k2", stage: "exif", error: "ENOENT: missing" }),
      seed({ key: "k3", stage: "ai", error: "AI: timeout" }),
    ]);

    const out = await filterDeadLetter({ stage: "ai" });
    expect(out).toHaveLength(2);
    for (const row of out) expect(row.stage).toBe("ai");
  });

  it("filters by errorPrefix (literal prefix, regex-escaped)", async () => {
    if (!mongoReachable) return;
    const { filterDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({ key: "k1", stage: "exif", error: "ENOENT: /lib/a.dng" }),
      seed({ key: "k2", stage: "thumb", error: "ENOENT: /lib/b.dng" }),
      seed({ key: "k3", stage: "ai", error: "AI: timed out" }),
      // Regex metacharacter in the error must not match a non-anchored find.
      seed({ key: "k4", stage: "exif", error: "(prefix) something" }),
    ]);

    const out = await filterDeadLetter({ errorPrefix: "ENOENT" });
    expect(out).toHaveLength(2);
    for (const row of out) expect(row.error.startsWith("ENOENT")).toBe(true);

    const meta = await filterDeadLetter({ errorPrefix: "(prefix)" });
    expect(meta).toHaveLength(1);
    expect(meta[0]!.key).toBe("k4");
  });

  it("combines stage + errorPrefix and respects limit + sort", async () => {
    if (!mongoReachable) return;
    const { filterDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({
        key: "k1",
        stage: "ai",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-01T00:00:00.000Z",
      }),
      seed({
        key: "k2",
        stage: "ai",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-08T00:00:00.000Z",
      }),
      seed({
        key: "k3",
        stage: "ai",
        error: "AI: timed out",
        lastFailedAt: "2026-05-07T00:00:00.000Z",
      }),
      seed({
        key: "k4",
        stage: "exif",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-09T00:00:00.000Z",
      }),
    ]);

    const out = await filterDeadLetter({
      stage: "ai",
      errorPrefix: "AI: rate",
    });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.key)).toEqual(["k2", "k1"]); // newest first

    const limited = await filterDeadLetter({
      stage: "ai",
      errorPrefix: "AI:",
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.key).toBe("k2");
  });
});

// ---------------------------------------------------------------------------
// groupDeadLetterByError
// ---------------------------------------------------------------------------

describe("groupDeadLetterByError", () => {
  it("clusters identical errors and orders by count desc", async () => {
    if (!mongoReachable) return;
    const { groupDeadLetterByError } = await import(
      "../src/indexer/indexer.repo.ts"
    );
    await insertAll([
      seed({
        key: "k1",
        stage: "ai",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-01T00:00:00.000Z",
      }),
      seed({
        key: "k2",
        stage: "ai",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-08T00:00:00.000Z",
      }),
      seed({
        key: "k3",
        stage: "ai",
        error: "AI: rate limited",
        lastFailedAt: "2026-05-04T00:00:00.000Z",
      }),
      seed({
        key: "k4",
        stage: "exif",
        error: "ENOENT: missing.dng",
        lastFailedAt: "2026-05-09T00:00:00.000Z",
      }),
    ]);

    const groups = await groupDeadLetterByError();
    expect(groups).toHaveLength(2);

    const top = groups[0]!;
    expect(top.stage).toBe("ai");
    expect(top.errorClass).toBe("AI: rate limited");
    expect(top.count).toBe(3);
    expect(top.latestTs).toBe("2026-05-08T00:00:00.000Z");

    const second = groups[1]!;
    expect(second.stage).toBe("exif");
    expect(second.count).toBe(1);
  });

  it("truncates errorClass at 80 chars so long messages with the same head collapse", async () => {
    if (!mongoReachable) return;
    const { groupDeadLetterByError } = await import(
      "../src/indexer/indexer.repo.ts"
    );
    const head = "AI: rate limited - retry after backoff (";
    expect(head.length).toBeLessThan(80);
    const longA = head + "x".repeat(80) + "_unique_A";
    const longB = head + "x".repeat(80) + "_unique_B";
    await insertAll([
      seed({ key: "k1", stage: "ai", error: longA }),
      seed({ key: "k2", stage: "ai", error: longB }),
    ]);

    const groups = await groupDeadLetterByError();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.errorClass.length).toBe(80);
    expect(longA.startsWith(groups[0]!.errorClass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetDeadLetter
// ---------------------------------------------------------------------------

describe("resetDeadLetter", () => {
  it("deletes by key and returns deletedCount", async () => {
    if (!mongoReachable) return;
    const { resetDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({ key: "asset-1", stage: "ai" }),
      seed({ key: "asset-1", stage: "exif" }),
      seed({ key: "asset-2", stage: "ai" }),
    ]);

    const res = await resetDeadLetter({ key: "asset-1" });
    expect(res.deletedCount).toBe(2);

    const remaining = await db!
      .collection(COLL)
      .find({})
      .toArray();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.key).toBe("asset-2");
  });

  it("deletes by stage and returns deletedCount", async () => {
    if (!mongoReachable) return;
    const { resetDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({ key: "asset-1", stage: "ai" }),
      seed({ key: "asset-2", stage: "ai" }),
      seed({ key: "asset-3", stage: "exif" }),
    ]);

    const res = await resetDeadLetter({ stage: "ai" });
    expect(res.deletedCount).toBe(2);

    const survivors = await db!
      .collection(COLL)
      .find({})
      .toArray();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.stage).toBe("exif");
  });

  it("narrows when both filters are provided", async () => {
    if (!mongoReachable) return;
    const { resetDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([
      seed({ key: "asset-1", stage: "ai" }),
      seed({ key: "asset-1", stage: "exif" }),
      seed({ key: "asset-2", stage: "ai" }),
    ]);

    const res = await resetDeadLetter({ key: "asset-1", stage: "ai" });
    expect(res.deletedCount).toBe(1);

    const remaining = await db!
      .collection(COLL)
      .find({})
      .sort({ key: 1, stage: 1 })
      .toArray();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => `${r.key}/${r.stage}`)).toEqual([
      "asset-1/exif",
      "asset-2/ai",
    ]);
  });

  it("rejects calls with neither filter (refuses to wipe everything)", async () => {
    if (!mongoReachable) return;
    const { resetDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([seed({ key: "asset-1", stage: "ai" })]);

    await expect(resetDeadLetter({})).rejects.toThrow(
      /must provide at least one/i,
    );
    const survivors = await db!
      .collection(COLL)
      .find({})
      .toArray();
    expect(survivors).toHaveLength(1);
  });

  it("returns deletedCount: 0 for filters that match nothing", async () => {
    if (!mongoReachable) return;
    const { resetDeadLetter } = await import("../src/indexer/indexer.repo.ts");
    await insertAll([seed({ key: "asset-1", stage: "ai" })]);

    const res = await resetDeadLetter({ key: "asset-does-not-exist" });
    expect(res.deletedCount).toBe(0);
  });
});
