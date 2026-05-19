/**
 * Route-integration test: POST /api/folders/:id/mkdir
 *
 * Covers the folder-create hook used by the macOS File Provider
 * extension when Finder fires a folder createItem (either "New
 * Folder" in the FP mount, or the folder-create that precedes a
 * drag-in of a folder containing files).
 *
 * Requires a running MongoDB (skips gracefully if unreachable).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { closeDb } from "../db/client.ts";
import { foldersRoutes } from "./folders.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_folders_mkdir_test_${process.pid}`;

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
    try { await c.close(); } catch {}
    return null;
  }
}

describe("POST /api/folders/:id/mkdir", () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let folderId: ObjectId | null = null;
  let folderPath: string | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), "maple-mkdir-test-"));
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId,
      path: folderPath,
      label: "mkdir-test",
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    if (folderPath) await rm(folderPath, { recursive: true, force: true }).catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
    folderId = null;
    folderPath = null;
  });

  function call(target: string): Promise<Response> {
    const app = new Elysia().use(foldersRoutes);
    const url = `http://localhost/api/folders/${folderId!.toHexString()}/mkdir`;
    return app.handle(
      new Request(url, {
        method: "POST",
        headers: { "X-Maple-Target-Path": target },
      })
    );
  }

  it("creates a single-level subdirectory and returns 201 with abs_path", async () => {
    if (!mongo || !db || !folderId) {
      console.log("[folders.mkdir.test] MongoDB unreachable — skipping");
      return;
    }
    const res = await call("Pictures");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string };
    const expected = nodePath.join(folderPath!, "Pictures");
    expect(body.abs_path).toBe(expected);
    const st = await stat(expected);
    expect(st.isDirectory()).toBe(true);
  });

  it("creates nested directories in one call (mkdir -p)", async () => {
    if (!mongo || !db || !folderId) return;
    const res = await call("2026/Adam/04-02");
    expect(res.status).toBe(201);
    const st = await stat(nodePath.join(folderPath!, "2026/Adam/04-02"));
    expect(st.isDirectory()).toBe(true);
  });

  it("is idempotent when the directory already exists", async () => {
    if (!mongo || !db || !folderId) return;
    const first = await call("Pictures");
    expect(first.status).toBe(201);
    const second = await call("Pictures");
    expect(second.status).toBe(201);
  });

  it("rejects path traversal", async () => {
    if (!mongo || !db || !folderId) return;
    const res = await call("../outside");
    expect(res.status).toBe(400);
  });

  it("rejects leading-dot path components", async () => {
    if (!mongo || !db || !folderId) return;
    const res = await call(".maple/leaked");
    expect(res.status).toBe(400);
  });

  it("rejects absolute paths", async () => {
    if (!mongo || !db || !folderId) return;
    const res = await call("/etc/evil");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown folder id", async () => {
    if (!mongo || !db) return;
    const app = new Elysia().use(foldersRoutes);
    const url = `http://localhost/api/folders/${new ObjectId().toHexString()}/mkdir`;
    const res = await app.handle(
      new Request(url, {
        method: "POST",
        headers: { "X-Maple-Target-Path": "Pictures" },
      })
    );
    expect(res.status).toBe(404);
  });
});
