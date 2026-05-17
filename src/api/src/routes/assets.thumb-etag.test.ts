import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { closeDb } from "../db/client.ts";
import { assetsRoutes } from "./assets.ts";
import { resolveThumbPath } from "../fs/xmp.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
// Shared DB name across all etag tests in this process so the
// module-cached MongoClient (which is keyed on the env var read at first
// connect) never points at a stale DB when tests interleave.
const TEST_DB = `maple_etag_test_${process.pid}`;
async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
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

describe("GET /api/assets/:id/thumb — ETag", () => {
  let client: MongoClient | null = null;
  let db: Db | null = null;
  let tmp: string | null = null;
  let assetId: ObjectId | null = null;

  beforeEach(async () => {
    client = await tryConnect();
    if (!client) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    // Reset the API's module-cached MongoClient so the next route call
    // picks up MAPLE_MONGO_DB fresh.
    await closeDb();
    db = client.db(TEST_DB);
    await db.dropDatabase();
    // realpath() so MAPLE_ROOTS matches the realpath-resolved abs_path on
    // macOS where /tmp is a symlink to /private/tmp.
    tmp = await realpath(await mkdtemp(join(tmpdir(), "maple-thumb-etag-")));
    process.env.MAPLE_ROOTS = tmp;
    const rawPath = join(tmp, "a.dng");
    await writeFile(rawPath, Buffer.alloc(8));
    const thumbPath = resolveThumbPath(rawPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from([0xff, 0xd8, 0xff]));
    assetId = new ObjectId();
    await db.collection("assets").insertOne({
      _id: assetId,
      folder_id: new ObjectId(),
      filename: "a.dng",
      abs_path: rawPath,
      size: 8,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "now",
    } as never);
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });


  it("returns ETag on 200", async () => {
    if (!client) {
      console.log("[assets.thumb-etag.test] MongoDB unreachable — skipping");
      return;
    }
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(
        `http://localhost/api/assets/${assetId!.toHexString()}/thumb`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^".+"$/);
  });

  it("returns 304 when If-None-Match matches", async () => {
    if (!client) return;
    const app = new Elysia().use(assetsRoutes);
    const first = await app.handle(
      new Request(
        `http://localhost/api/assets/${assetId!.toHexString()}/thumb`,
      ),
    );
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(
      new Request(
        `http://localhost/api/assets/${assetId!.toHexString()}/thumb`,
        { headers: { "If-None-Match": etag } },
      ),
    );
    expect(second.status).toBe(304);
  });
});
