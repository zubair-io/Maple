import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId, type Db } from "mongodb";
import { assetsListRoutes } from "./assets-list.ts";
import { getDb, isDbConnected } from "../db/client.ts";

let db: Db | null = null;
let mongoReachable = false;

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection("assets").deleteMany({});
});

afterAll(async () => {
  if (db) await db.collection("assets").deleteMany({});
});

async function seed(d: Db): Promise<void> {
  const folder = new ObjectId();
  const now = new Date("2026-05-10T00:00:00Z");
  const old = new Date("2025-01-01T00:00:00Z");
  await d.collection("assets").insertMany([
    {
      folder_id: folder,
      filename: "a.dng",
      abs_path: "/p/a.dng",
      size: 1,
      mtime: 1,
      rating: 5,
      flag: 0,
      color_label: "",
      has_xmp: true,
      indexed_at: "now",
      exif: { captured_at: now.toISOString() },
    },
    {
      folder_id: folder,
      filename: "b.dng",
      abs_path: "/p/b.dng",
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: "",
      has_xmp: false,
      indexed_at: "now",
      exif: { captured_at: old.toISOString() },
    },
    {
      folder_id: folder,
      filename: "c.dng",
      abs_path: "/p/c.dng",
      size: 1,
      mtime: 1,
      rating: 3,
      flag: 0,
      color_label: "",
      has_xmp: true,
      indexed_at: "now",
      exif: { captured_at: now.toISOString() },
    },
  ] as never);
}

describe("GET /api/assets", () => {
  it("filters by has_xmp=1", async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/assets?has_xmp=1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.assets.map((a: { filename: string }) => a.filename).sort()
    ).toEqual(["a.dng", "c.dng"]);
  });

  it("filters by rating_gte=1", async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/assets?rating_gte=1")
    );
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it("filters by captured_after=ISO", async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const after = new Date("2026-01-01T00:00:00Z").toISOString();
    const res = await app.handle(
      new Request(
        `http://localhost/api/assets?captured_after=${encodeURIComponent(after)}`
      )
    );
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it("returns 400 for invalid captured_after", async () => {
    if (!mongoReachable) return;
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/assets?captured_after=notadate")
    );
    expect(res.status).toBe(400);
  });

  it("returns all assets when no filters are given", async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request("http://localhost/api/assets"));
    const body = await res.json();
    expect(body.assets.length).toBe(3);
  });
});
