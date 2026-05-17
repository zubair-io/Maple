import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { foldersRoutes } from "./folders.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_folders_etag_test_${process.pid}`;
let client: MongoClient | null = null;
let db: Db | null = null;

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

beforeEach(async () => {
  client = await tryConnect();
  if (!client) return;
  process.env.MAPLE_MONGO_URI = MONGO_URI;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  db = client.db(TEST_DB);
  await db.dropDatabase();
  await db.collection("folders").insertOne({
    _id: new ObjectId(),
    path: "/srv/p",
    label: "p",
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  if (client) await client.close();
});

describe("GET /api/folders — ETag", () => {
  it("returns ETag header on 200", async () => {
    if (!client) {
      console.log("[folders.etag.test] MongoDB unreachable — skipping");
      return;
    }
    const app = new Elysia().use(foldersRoutes);
    const res = await app.handle(new Request("http://localhost/api/folders"));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
  });

  it("returns 304 when If-None-Match matches", async () => {
    if (!client) return;
    const app = new Elysia().use(foldersRoutes);
    const first = await app.handle(new Request("http://localhost/api/folders"));
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(
      new Request("http://localhost/api/folders", {
        headers: { "If-None-Match": etag },
      }),
    );
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("returns 200 with a new ETag when folders change", async () => {
    if (!client || !db) return;
    const app = new Elysia().use(foldersRoutes);
    const first = await app.handle(new Request("http://localhost/api/folders"));
    const etag1 = first.headers.get("ETag")!;
    await db.collection("folders").insertOne({
      _id: new ObjectId(),
      path: "/srv/q",
      label: "q",
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    const second = await app.handle(
      new Request("http://localhost/api/folders", {
        headers: { "If-None-Match": etag1 },
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag1);
  });
});
