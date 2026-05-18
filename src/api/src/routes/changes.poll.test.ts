import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId, type Db } from "mongodb";
import { changesRoutes } from "./changes.ts";
import { recordAssetChange } from "../db/changes.repo.ts";
import { getDb, isDbConnected } from "../db/client.ts";

let db: Db | null = null;
let app: Elysia | null = null;
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
  // Clean only the collections this test touches — sharing the cached
  // singleton DB with other route tests means we must not dropDatabase.
  await db.collection("asset_changes").deleteMany({});
  await db.collection("server_state").deleteMany({});
  app = new Elysia().use(changesRoutes);
});

afterAll(async () => {
  if (db) {
    await db.collection("asset_changes").deleteMany({});
    await db.collection("server_state").deleteMany({});
  }
});

describe("GET /api/changes", () => {
  it("returns rows with cursor > since", async () => {
    if (!mongoReachable || !db || !app) return;
    for (let i = 0; i < 3; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(
      new Request("http://localhost/api/changes?since=0")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(3);
    expect(body.next_cursor).toBeGreaterThan(0);
  });

  it("returns empty list with no next_cursor when no changes", async () => {
    if (!mongoReachable || !app) return;
    const res = await app.handle(
      new Request("http://localhost/api/changes?since=0")
    );
    const body = await res.json();
    expect(body.changes).toEqual([]);
    expect(body.next_cursor).toBeUndefined();
  });

  it("returns 400 for non-integer limit (regression — used to 500)", async () => {
    if (!mongoReachable || !app) return;
    const res = await app.handle(
      new Request("http://localhost/api/changes?since=0&limit=abc")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit/i);
  });

  it("respects limit parameter", async () => {
    if (!mongoReachable || !db || !app) return;
    for (let i = 0; i < 10; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/p/${i}.dng`,
      });
    }
    const res = await app.handle(
      new Request("http://localhost/api/changes?since=0&limit=3")
    );
    const body = await res.json();
    expect(body.changes.length).toBe(3);
  });

  it("emits relative_path: null (explicit) for legacy rows lacking the field", async () => {
    // Regression — Phase 6 wire format: explicit null is the contract.
    // Apple's decoder uses `decodeIfPresent` so it tolerates the key
    // being missing, but the wire format guarantees the key is present
    // (with `?? null`) so downstream consumers can rely on its
    // existence — asserting the explicit-null shape protects against
    // accidental drift in `asPayload`.
    if (!mongoReachable || !db || !app) return;
    // Insert directly so the BSON lacks `relative_path` entirely,
    // mimicking a row written before Phase 6.
    await db.collection("asset_changes").insertOne({
      cursor: 1,
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      kind: "update",
      abs_path: "/p/legacy.dng",
      at: new Date(),
    } as never);
    const res = await app.handle(
      new Request("http://localhost/api/changes?since=0")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes.length).toBe(1);
    const row = body.changes[0];
    // The key must be present AND its value must be `null` — not
    // `undefined` (which would be elided by JSON.stringify).
    expect(Object.prototype.hasOwnProperty.call(row, "relative_path")).toBe(
      true
    );
    expect(row.relative_path).toBeNull();
  });
});
