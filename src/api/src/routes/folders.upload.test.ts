/**
 * Route-integration test: POST /api/folders/:id/upload
 *
 * Verifies the upload route emits an `asset_changes` row with
 * `kind: "create"` so File Provider clients on the SSE feed see the
 * new asset in their working set immediately, without waiting for the
 * discover watcher to notice the file. This was wired up in
 * `feat(api): emit change event on folder upload` and Copilot asked
 * for explicit coverage.
 *
 * Requires a running MongoDB (skips gracefully if unreachable).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { closeDb } from "../db/client.ts";
import { foldersRoutes } from "./folders.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_folders_upload_test_${process.pid}`;

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

describe("POST /api/folders/:id/upload → asset_changes emit", () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let folderId: ObjectId | null = null;
  let folderPath: string | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    // Reset module-cached client so MAPLE_MONGO_DB takes effect.
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), "maple-upload-test-"));
    folderId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: folderId,
      path: folderPath,
      label: "upload-test",
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

  it("inserts an asset_changes row with kind=create matching the uploaded asset", async () => {
    if (!mongo || !db || !folderId) {
      console.log("[folders.upload.test] MongoDB unreachable — skipping");
      return;
    }

    const app = new Elysia().use(foldersRoutes);
    const fileBytes = new Uint8Array([0x49, 0x49, 0x2A, 0x00]);  // TIFF magic; harmless body
    const target = "uploaded.dng";
    const url = `http://localhost/api/folders/${folderId.toHexString()}/upload`;
    const res = await app.handle(
      new Request(url, {
        method: "POST",
        headers: {
          "X-Maple-Target-Path": target,
          "Content-Type": "application/octet-stream",
        },
        body: fileBytes,
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id: string; abs_path: string };
    expect(body.asset_id).toMatch(/^[a-f0-9]{24}$/);
    const expectedAbsPath = nodePath.join(folderPath!, target);
    expect(body.abs_path).toBe(expectedAbsPath);

    // The change emit is awaited inside the route (best-effort, but
    // sequential) so by the time the route returns 201 the row should
    // be present. No polling needed.
    const changes = await db
      .collection("asset_changes")
      .find({})
      .toArray();
    expect(changes.length).toBe(1);
    const change = changes[0]!;
    expect(change.kind).toBe("create");
    expect((change.asset_id as ObjectId).toHexString()).toBe(body.asset_id);
    expect((change.folder_id as ObjectId).toHexString()).toBe(folderId.toHexString());
    expect(change.abs_path).toBe(expectedAbsPath);
    // `relative_path` is computed by `recordAndPublishAssetChange`
    // from `folder.path + abs_path`. For a top-level upload it equals
    // the target path with no leading slash.
    expect(change.relative_path).toBe(target);
  });
});
