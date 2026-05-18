/**
 * Migration-gate tests. Verify:
 *   - `recordMigration` writes a sentinel doc; `migrationApplied` reads it.
 *   - Duplicate `recordMigration` calls don't throw (E11000 swallowed).
 *   - `ensureIndexes` run twice does NOT re-execute the three backfill
 *     updateMany calls on the second boot — proves the gate stops the
 *     per-boot scan damage that the original code path was causing.
 *
 * Skip-passes when Mongo is unreachable (same pattern as client.test.ts).
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

const TEST_DB = `maple_test_migrations_${process.pid}`;
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
    try { await c.close(); } catch { /* ignore */ }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[migrations.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  for (const name of [
    "users",
    "credentials",
    "invites",
    "refresh_tokens",
    "challenges",
  ]) {
    await db.createCollection(name).catch(() => undefined);
  }
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
  await db!.collection("migrations").deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("./client.ts");
  await closeDb();
});

describe("migrations module", () => {
  it("migrationApplied → false before recordMigration; true after", async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import("./client.ts");
    await closeDb();
    const { migrationApplied, recordMigration } = await import("./migrations.ts");
    expect(await migrationApplied(db!, "exif-captured-year-month-backfill")).toBe(false);
    await recordMigration(db!, "exif-captured-year-month-backfill", 42);
    expect(await migrationApplied(db!, "exif-captured-year-month-backfill")).toBe(true);
    // Stores rows + appliedAt.
    const doc = await db!.collection("migrations").findOne({
      _id: "exif-captured-year-month-backfill",
    } as Parameters<ReturnType<typeof db.collection>["findOne"]>[0]);
    expect(doc).toBeDefined();
    expect((doc as { rows: number }).rows).toBe(42);
  });

  it("recordMigration is idempotent — duplicate calls don't throw", async () => {
    if (!mongoReachable) return;
    const { closeDb } = await import("./client.ts");
    await closeDb();
    const { recordMigration, migrationApplied } = await import("./migrations.ts");
    await recordMigration(db!, "place-search-blob-backfill", 10);
    // Second call must not throw (E11000 duplicate key is swallowed —
    // it just means another boot got there first).
    await recordMigration(db!, "place-search-blob-backfill", 99);
    expect(await migrationApplied(db!, "place-search-blob-backfill")).toBe(true);
    // First write wins; second is a no-op.
    const doc = await db!.collection("migrations").findOne({
      _id: "place-search-blob-backfill",
    } as Parameters<ReturnType<typeof db.collection>["findOne"]>[0]);
    expect((doc as { rows: number }).rows).toBe(10);
  });
});

describe("ensureIndexes — backfills don't re-run on second boot", () => {
  it("second ensureIndexes() does NOT modify the backfill-target row again", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import("./client.ts");
    await closeDb();

    // Insert a row that the captured_year/month backfill would target:
    // has exif.captured_at, missing exif.captured_year.
    await db!.collection("assets").insertOne({
      folder_id: "f",
      filename: "x.jpg",
      abs_path: "/x.jpg",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      exif: { captured_at: "2024-01-15T10:00:00Z" },
    });

    await ensureIndexes();
    const afterFirst = await db!
      .collection("assets")
      .findOne({ filename: "x.jpg" });
    expect((afterFirst as { exif?: { captured_year?: number } } | null)?.exif?.captured_year).toBe(
      2024,
    );

    // Sentinel should now be present.
    const { migrationApplied } = await import("./migrations.ts");
    expect(await migrationApplied(db!, "exif-captured-year-month-backfill")).toBe(true);

    // Stomp the captured_year field. If the gate is broken, the second
    // ensureIndexes() call will re-run the backfill and restore it.
    // If the gate works, the value stays null.
    await db!
      .collection("assets")
      .updateOne(
        { filename: "x.jpg" },
        { $unset: { "exif.captured_year": "", "exif.captured_month": "" } },
      );

    await ensureIndexes();
    const afterSecond = await db!
      .collection("assets")
      .findOne({ filename: "x.jpg" });
    // Gate worked: backfill was skipped, captured_year is still missing.
    expect(
      (afterSecond as { exif?: { captured_year?: number } } | null)?.exif?.captured_year,
    ).toBeUndefined();
  });

  it("place-search-blob backfill is gated by the migrations sentinel", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import("./client.ts");
    await closeDb();

    // First boot — no rows, sentinel gets written for a zero-row run.
    await ensureIndexes();
    const { migrationApplied } = await import("./migrations.ts");
    expect(await migrationApplied(db!, "place-search-blob-backfill")).toBe(true);

    // Insert a row that WOULD be matched by the backfill predicate. If
    // the gate is broken, the second ensureIndexes() will populate the
    // search_blob. If the gate works, the search_blob stays empty.
    await db!.collection("assets").insertOne({
      folder_id: "f",
      filename: "y.jpg",
      abs_path: "/y.jpg",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      place: {
        search_blob: "",
        address: { city: "Tokyo", country: "Japan" },
      },
    });

    await ensureIndexes();
    const after = await db!.collection("assets").findOne({ filename: "y.jpg" });
    expect((after as { place: { search_blob: string } } | null)?.place.search_blob).toBe("");
  });

  it("asset-search-blob backfill is gated by the migrations sentinel", async () => {
    if (!mongoReachable) return;
    const { closeDb, ensureIndexes } = await import("./client.ts");
    await closeDb();

    await ensureIndexes();
    const { migrationApplied } = await import("./migrations.ts");
    expect(await migrationApplied(db!, "asset-search-blob-backfill")).toBe(true);

    // Row that would be matched by the unified-blob predicate:
    // place.search_blob set, no top-level search_blob.
    await db!.collection("assets").insertOne({
      folder_id: "f",
      filename: "z.jpg",
      abs_path: "/z.jpg",
      size: 1,
      mtime: 0,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      place: { search_blob: "tokyo japan" },
    });

    await ensureIndexes();
    const after = await db!.collection("assets").findOne({ filename: "z.jpg" });
    expect((after as { search_blob?: string } | null)?.search_blob).toBeUndefined();
  });
});
