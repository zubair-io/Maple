/**
 * Verifies that `softDelete()` fires a Meilisearch tombstone after the
 * Mongo update and that a Meilisearch failure does NOT propagate.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import {
  setMeilisearchClientForTests,
  type MeilisearchClient,
} from "../src/enrichment/meilisearch-client.ts";

const TEST_DB = `maple_test_images_repo_meili_${process.pid}`;
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

interface CapturedMeili {
  client: MeilisearchClient;
  tombstones: string[];
  failNext?: boolean;
}

function makeCapturingMeili(): CapturedMeili {
  const tombstones: string[] = [];
  const c: CapturedMeili = {
    tombstones,
    client: {
      isConfigured: () => true,
      health: async () => true,
      ensureIndex: async () => {},
      upsert: async () => {},
      tombstone: async (id) => {
        if (c.failNext) {
          c.failNext = false;
          throw new Error("simulated meili tombstone failure");
        }
        tombstones.push(id);
      },
      search: async () => ({ ids: [], estimatedTotal: 0 }),
    },
  };
  return c;
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log("[images-repo-meilisearch.test] skipping: MongoDB unreachable");
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection("assets").deleteMany({});
  setMeilisearchClientForTests(null);
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import("../src/db/client.ts");
  await closeDb();
  setMeilisearchClientForTests(null);
});

describe("images.repo softDelete — Meilisearch tombstone", () => {
  it("tombstones the maple_id when soft-deleting", async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const folder = new ObjectId();
    await db!.collection("assets").insertOne({
      folder_id: folder,
      maple_id: "maple-tombstone-1",
      abs_path: "/lib/tombstone.dng",
      filename: "tombstone.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import("../src/indexer/images.repo.ts");
    await softDelete("/lib/tombstone.dng");

    expect(meili.tombstones).toEqual(["maple-tombstone-1"]);
    const after = await db!
      .collection("assets")
      .findOne({ abs_path: "/lib/tombstone.dng" });
    expect(after?.deleted_at).not.toBeNull();
  });

  it("Mongo soft-delete still succeeds when Meilisearch tombstone throws", async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    meili.failNext = true;
    setMeilisearchClientForTests(meili.client);

    const folder = new ObjectId();
    await db!.collection("assets").insertOne({
      folder_id: folder,
      maple_id: "maple-tombstone-2",
      abs_path: "/lib/tombstone-fail.dng",
      filename: "tombstone-fail.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import("../src/indexer/images.repo.ts");
    // Must not throw.
    await softDelete("/lib/tombstone-fail.dng");

    const after = await db!
      .collection("assets")
      .findOne({ abs_path: "/lib/tombstone-fail.dng" });
    expect(after?.deleted_at).not.toBeNull();
  });

  it("skips the Meilisearch tombstone when the row has no maple_id", async () => {
    if (!mongoReachable) return;
    const meili = makeCapturingMeili();
    setMeilisearchClientForTests(meili.client);

    const folder = new ObjectId();
    await db!.collection("assets").insertOne({
      folder_id: folder,
      // No maple_id — legacy row.
      abs_path: "/lib/legacy-tombstone.dng",
      filename: "legacy-tombstone.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: null,
    });

    const { softDelete } = await import("../src/indexer/images.repo.ts");
    await softDelete("/lib/legacy-tombstone.dng");

    expect(meili.tombstones).toEqual([]);
    const after = await db!
      .collection("assets")
      .findOne({ abs_path: "/lib/legacy-tombstone.dng" });
    expect(after?.deleted_at).not.toBeNull();
  });
});
