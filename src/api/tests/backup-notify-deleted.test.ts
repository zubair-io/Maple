import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { foldersCollection, assetsCollection } from "../src/db/client.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const libId = new ObjectId();
const deviceId = "test-device-notify-deleted";
const phid1 = "DEL/L0/001";
const phid2 = "DEL/L0/002";
const phid3 = "DEL/L0/003";
let tmpLib: string;
let assetId1: ObjectId;
let assetId2: ObjectId;
let assetId3: ObjectId;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), "maple-notify-del-test-"));
  const f = await foldersCollection();
  await f.insertOne({ _id: libId, path: tmpLib, label: "test", created_at: new Date(), file_count: 0 } as any);

  const a = await assetsCollection();
  await a.deleteMany({ folder_id: libId });

  assetId1 = new ObjectId();
  assetId2 = new ObjectId();
  assetId3 = new ObjectId();

  const base = { folder_id: libId, size: 64, mtime: Date.now(), rating: 0, flag: 0, color_label: "", indexed_at: new Date().toISOString(), deleted_from_photos: false };

  await a.insertMany([
    {
      _id: assetId1,
      ...base,
      filename: "IMG_DEL_1.HEIC",
      abs_path: path.join(tmpLib, "IMG_DEL_1.HEIC"),
      maple_id: "del-maple-1",
      phasset_links: [{ device_id: deviceId, phasset_local_id: phid1, first_seen: new Date() }],
    },
    {
      _id: assetId2,
      ...base,
      filename: "IMG_DEL_2.HEIC",
      abs_path: path.join(tmpLib, "IMG_DEL_2.HEIC"),
      maple_id: "del-maple-2",
      phasset_links: [{ device_id: deviceId, phasset_local_id: phid2, first_seen: new Date() }],
    },
    {
      _id: assetId3,
      ...base,
      filename: "IMG_DEL_3.HEIC",
      abs_path: path.join(tmpLib, "IMG_DEL_3.HEIC"),
      maple_id: "del-maple-3",
      // Linked to a DIFFERENT device only — should NOT be updated.
      phasset_links: [{ device_id: "other-device", phasset_local_id: phid3, first_seen: new Date() }],
    },
  ] as any[]);
});

afterAll(async () => {
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function notifyDeleted(body: object, headers: Record<string, string>, libOverride?: string): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/notify-deleted`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/libraries/:id/backup/notify-deleted", () => {
  test("happy path — marks matching assets deleted", async () => {
    const res = await app.handle(
      notifyDeleted(
        { phasset_local_ids: [phid1, phid2] },
        { "X-Maple-Device-Id": deviceId },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);

    const a = await assetsCollection();
    const doc1 = await a.findOne({ _id: assetId1 });
    const doc2 = await a.findOne({ _id: assetId2 });
    expect(doc1?.deleted_from_photos).toBe(true);
    expect(doc2?.deleted_from_photos).toBe(true);
  });

  test("does not affect assets linked only to a different device", async () => {
    const a = await assetsCollection();
    const doc3 = await a.findOne({ _id: assetId3 });
    // assetId3 is linked to "other-device", not to deviceId.
    expect(doc3?.deleted_from_photos).toBe(false);
  });

  test("empty phasset_local_ids → 200 with updated:0", async () => {
    const res = await app.handle(
      notifyDeleted(
        { phasset_local_ids: [] },
        { "X-Maple-Device-Id": deviceId },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
  });

  test("unknown phid → 200 with updated:0 (no match, not an error)", async () => {
    const res = await app.handle(
      notifyDeleted(
        { phasset_local_ids: ["UNKNOWN/L0/999"] },
        { "X-Maple-Device-Id": deviceId },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
  });

  test("missing X-Maple-Device-Id header → 400", async () => {
    const res = await app.handle(
      notifyDeleted({ phasset_local_ids: [phid1] }, {}),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("X-Maple-Device-Id");
  });

  test("missing phasset_local_ids field → 400", async () => {
    const res = await app.handle(
      notifyDeleted({ ids: [phid1] } as any, { "X-Maple-Device-Id": deviceId }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("phasset_local_ids");
  });

  test("phasset_local_ids is not an array → 400", async () => {
    const res = await app.handle(
      notifyDeleted({ phasset_local_ids: "not-an-array" } as any, { "X-Maple-Device-Id": deviceId }),
    );
    expect(res.status).toBe(400);
  });

  test("library not found → 404", async () => {
    const res = await app.handle(
      notifyDeleted(
        { phasset_local_ids: [phid1] },
        { "X-Maple-Device-Id": deviceId },
        new ObjectId().toHexString(),
      ),
    );
    expect(res.status).toBe(404);
  });
});
