import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { foldersCollection, assetsCollection, uploadSessionsCollection, geocodeCacheCollection } from "../src/db/client.ts";
import { quantizedKey } from "../src/enrichment/coordinate-cache.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const libId = new ObjectId();
const deviceId = "test-device-ingest";
const phid = "ABC/L0/001";
const phid2 = "ABC/L0/002";
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), "maple-ingest-test-"));
  const f = await foldersCollection();
  await f.insertOne({ _id: libId, path: tmpLib, label: "test", created_at: new Date(), file_count: 0 } as any);
  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.device_id": deviceId });
  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
  const g = await geocodeCacheCollection();
  await g.deleteOne({ _id: quantizedKey(35.68, 139.69) });
  await g.insertOne({
    _id: quantizedKey(35.68, 139.69),
    place: {
      address: {} as any,
      pois: [{ name: "Tokyo", category: "place", type: "city" }],
      rollups: { locality: "Tokyo" } as any,
      search_blob: "Tokyo",
    } as any,
    fetched_at: new Date(),
    geocoder_version: 1,
  } as any);
});

afterAll(async () => {
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function ingest(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
}

describe("POST /api/libraries/:id/backup/ingest", () => {
  test("happy path single chunk with GPS → AssetDoc + located path", async () => {
    const bytes = Buffer.alloc(256, 1);
    const res = await app.handle(ingest(bytes, {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Lat": "35.68",
      "X-Maple-Lon": "139.69",
      "X-Maple-Filename": "IMG_0420.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "abc123",
      "Content-Range": "bytes 0-255/256",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe("abc123");
    expect(body.target_rel_path).toBe("2024/Tokyo/03-15/IMG_0420.HEIC");

    const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path));
    expect(onDisk.byteLength).toBe(256);

    const a = await assetsCollection();
    const doc = await a.findOne({ "phasset_links.phasset_local_id": phid });
    expect(doc).toBeTruthy();
    expect(doc?.phasset_links?.[0].device_id).toBe(deviceId);
  });

  test("resume across two chunks", async () => {
    const r1 = await app.handle(ingest(Buffer.alloc(128, 2), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0421.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await app.handle(ingest(Buffer.alloc(128, 2), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0421.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "def456",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(200);
  });

  test("missing required header → 400", async () => {
    const r = await app.handle(ingest(Buffer.alloc(16), {
      "X-Maple-Device-Id": deviceId,
      // no phasset id
      "X-Maple-Total-Bytes": "16",
      "Content-Range": "bytes 0-15/16",
    }));
    expect(r.status).toBe(400);
  });

  test("409 when resume offset doesn't match server's received_bytes", async () => {
    const phid3 = "ABC/L0/003";
    const r1 = await app.handle(ingest(Buffer.alloc(128, 3), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid3,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0422.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await app.handle(ingest(Buffer.alloc(128, 3), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid3,
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_0422.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 64-191/256", // wrong start — server expects 128
    }));
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(128);
  });

  test("second device with same maple_id → $push phasset_link, no new AssetDoc", async () => {
    const sharedMapleId = "shared-id-dedup";
    const deviceA = "device-A-dedup";
    const deviceB = "device-B-dedup";
    const phidA = "ABC/L0/010";
    const phidB = "ABC/L0/011";

    // Device A uploads a complete single-chunk asset.
    const rA = await app.handle(ingest(Buffer.alloc(64, 5), {
      "X-Maple-Device-Id": deviceA,
      "X-Maple-Phasset-Id": phidA,
      "X-Maple-Capture-Date": "2024-06-01T08:00:00Z",
      "X-Maple-Filename": "IMG_SHARED.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": sharedMapleId,
      "Content-Range": "bytes 0-63/64",
    }));
    expect(rA.status).toBe(200);

    // Device B uploads the same asset (same maple_id, different phid).
    const rB = await app.handle(ingest(Buffer.alloc(64, 5), {
      "X-Maple-Device-Id": deviceB,
      "X-Maple-Phasset-Id": phidB,
      "X-Maple-Capture-Date": "2024-06-01T08:00:00Z",
      "X-Maple-Filename": "IMG_SHARED.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": sharedMapleId,
      "Content-Range": "bytes 0-63/64",
    }));
    expect(rB.status).toBe(200);

    // Exactly one AssetDoc with two phasset_links.
    const a = await assetsCollection();
    const docs = await a.find({ maple_id: sharedMapleId }).toArray();
    expect(docs.length).toBe(1);
    expect(docs[0].phasset_links.length).toBe(2);
    const deviceIds = docs[0].phasset_links.map((l: any) => l.device_id);
    expect(deviceIds).toContain(deviceA);
    expect(deviceIds).toContain(deviceB);
  });

  test("Content-Range end < start → 400", async () => {
    const r = await app.handle(ingest(Buffer.alloc(8), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": "range-test-1",
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_range.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 5-3/256",  // end < start
    }));
    expect(r.status).toBe(400);
  });

  test("body shorter than Content-Range claims → 400", async () => {
    const r = await app.handle(ingest(Buffer.alloc(8), {  // only 8 bytes
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": "range-test-2",
      "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
      "X-Maple-Filename": "IMG_range2.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",  // claims 128 bytes
    }));
    expect(r.status).toBe(400);
  });

  test("tmp file deleted between chunks → 409 with expected_offset 0", async () => {
    const phidTmp = "ABC/L0/TMP1";
    const backupTmpDir = process.env.MAPLE_BACKUP_TMP ?? "/tmp/maple-backup-chunks";
    const { uploadSessionsCollection } = await import("../src/db/client.ts");

    // First chunk — establishes session
    const r1 = await app.handle(ingest(Buffer.alloc(128, 9), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidTmp,
      "X-Maple-Capture-Date": "2024-05-01T08:00:00Z",
      "X-Maple-Filename": "IMG_tmp_test.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);

    // Find the session id and delete the .part file
    const u = await uploadSessionsCollection();
    const sess = await u.findOne({ device_id: deviceId, phasset_local_id: phidTmp });
    expect(sess).toBeTruthy();
    const partFile = `${backupTmpDir}/${sess!._id.toHexString()}.part`;
    try { await import("node:fs/promises").then(f => f.unlink(partFile)); } catch { /* already gone */ }

    // Second chunk — server should detect missing tmp file and return 409
    const r2 = await app.handle(ingest(Buffer.alloc(128, 9), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidTmp,
      "X-Maple-Capture-Date": "2024-05-01T08:00:00Z",
      "X-Maple-Filename": "IMG_tmp_test.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "tmp-test-id",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(0);
  });

  test("resume with different filename → 409 session metadata mismatch", async () => {
    const phidResume = "ABC/L0/099";
    // Open session with IMG_a.heic
    const r1 = await app.handle(ingest(Buffer.alloc(128, 7), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_a.heic",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);

    // Resume with different filename (IMG_b.heic) → should 409
    const r2 = await app.handle(ingest(Buffer.alloc(128, 7), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_b.heic",  // different filename
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "resume-hijack-test",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.error).toContain("mismatch");
  });

  test("path collision (file already on disk, no Mongo row) → 500", async () => {
    // Pre-create the file at the destination path before uploading
    const captureDate = "2024-07-04T12:00:00Z";
    const fname = "IMG_COLLISION.HEIC";
    const targetDir = path.join(tmpLib, "2024/07/04");
    await fs.mkdir(targetDir, { recursive: true });
    const preExistingPath = path.join(targetDir, fname);
    await fs.writeFile(preExistingPath, Buffer.alloc(64, 0));

    const rCollide = await app.handle(ingest(Buffer.alloc(64, 11), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": "ABC/L0/COLLIDE",
      "X-Maple-Capture-Date": captureDate,
      "X-Maple-Filename": fname,
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": "collision-maple-id",
      "Content-Range": "bytes 0-63/64",
    }));
    expect(rCollide.status).toBe(500);
    const b = await rCollide.json();
    expect(b.error).toContain("path collision");

    // Clean up
    await fs.unlink(preExistingPath);
  });

  test("library not found → 404", async () => {
    const fake = new ObjectId();
    const r = await app.handle(new Request(`http://localhost/api/libraries/${fake.toHexString()}/backup/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": "PX",
        "X-Maple-Capture-Date": "2024-03-15T10:30:00Z",
        "X-Maple-Filename": "x.heic",
        "X-Maple-Total-Bytes": "1",
        "X-Maple-Maple-Id": "x",
        "Content-Range": "bytes 0-0/1",
      },
      body: Buffer.alloc(1),
    }));
    expect(r.status).toBe(404);
  });
});
