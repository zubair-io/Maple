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

  test("backup upload with spec-form maple_id matching pre-seeded AssetDoc → dedup, no second file", async () => {
    // End-to-end dedup proof for the device-side spec-form maple_id fix:
    // an indexer-style AssetDoc exists on disk + in Mongo, and the device
    // backs up the same content with the matching spec-form id. The server
    // must short-circuit on `findOne({ maple_id })` and not write a second
    // copy.
    const { deriveId } = await import("../src/indexer/id.ts");

    // Simulate "indexer scanned this file" — write the file to the library
    // folder directly, derive a spec-form id from its head, insert the
    // AssetDoc with that id.
    const indexerRelPath = "indexed/IMG_INDEXED.HEIC";
    const indexerAbsPath = path.join(tmpLib, indexerRelPath);
    await fs.mkdir(path.dirname(indexerAbsPath), { recursive: true });
    const sharedBytes = Buffer.alloc(1024, 0xab);
    await fs.writeFile(indexerAbsPath, sharedBytes);

    const capturedAt = "2024-09-01T10:00:00.000Z";
    const id = deriveId(new Uint8Array(sharedBytes), capturedAt, null, null);
    // Sanity: id is the 32-char spec form (tag 0x01 primary).
    expect(id.hex.length).toBe(32);
    expect(id.kind).toBe("primary");

    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libId,
      filename: "IMG_INDEXED.HEIC",
      abs_path: indexerAbsPath,
      size: sharedBytes.byteLength,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: id.hex,
      phasset_links: [],
      deleted_from_photos: false,
    } as any);

    // Now the device sends a backup with the same content + same spec-form id.
    const devicePhid = "ABC/L0/SPEC-FORM";
    const deviceForId = "device-spec-form";
    const res = await app.handle(ingest(sharedBytes, {
      "X-Maple-Device-Id": deviceForId,
      "X-Maple-Phasset-Id": devicePhid,
      "X-Maple-Capture-Date": capturedAt,
      "X-Maple-Filename": "IMG_INDEXED.HEIC",
      "X-Maple-Total-Bytes": String(sharedBytes.byteLength),
      "X-Maple-Maple-Id": id.hex,
      "Content-Range": `bytes 0-${sharedBytes.byteLength - 1}/${sharedBytes.byteLength}`,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maple_id).toBe(id.hex);
    // Response references the pre-seeded asset's path — proves the server
    // resolved to the existing row, not a fresh upload destination.
    expect(body.target_rel_path).toBe(indexerRelPath);

    // Exactly one AssetDoc; phasset_links got the device link pushed onto it.
    const rows = await a.find({ maple_id: id.hex }).toArray();
    expect(rows.length).toBe(1);
    expect(rows[0].phasset_links.length).toBe(1);
    expect(rows[0].phasset_links[0].device_id).toBe(deviceForId);
    expect(rows[0].phasset_links[0].phasset_local_id).toBe(devicePhid);

    // Only the indexer's file exists on disk under the library folder —
    // no second copy was written under the device's would-be target path.
    // The "phid-routing" target path would have been derived from
    // capture_date + filename → e.g. `2024/2024/09-01/IMG_INDEXED.HEIC` —
    // walk the folder tree and assert exactly one IMG_INDEXED.HEIC exists.
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      const ents = await fs.readdir(dir, { withFileTypes: true });
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else out.push(full);
      }
      return out;
    }
    const allFiles = await walk(tmpLib);
    const sharedNameMatches = allFiles.filter((p) => p.endsWith("IMG_INDEXED.HEIC"));
    expect(sharedNameMatches.length).toBe(1);
    expect(sharedNameMatches[0]).toBe(indexerAbsPath);
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

  test("resume with different filename self-heals — server resets, asks client to restart from 0", async () => {
    const phidResume = "ABC/L0/099";
    // Open session with IMG_a.heic.
    const r1 = await app.handle(ingest(Buffer.alloc(128, 7), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_a.heic",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);

    // Same phid, different filename — the metadata mismatch is self-healed
    // server-side (session reset to offset 0 in place). The client's request
    // still has start=128, so it gets a normal 409 with expected_offset=0
    // telling it to restart from the top.
    const r2 = await app.handle(ingest(Buffer.alloc(128, 7), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_b.heic",  // different filename → new target_rel_path
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(0);

    // Client follows the expected_offset and restarts at 0 with the new
    // filename — should now succeed end-to-end.
    const r3 = await app.handle(ingest(Buffer.alloc(128, 8), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_b.heic",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r3.status).toBe(202);

    const r4 = await app.handle(ingest(Buffer.alloc(128, 8), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidResume,
      "X-Maple-Capture-Date": "2024-04-01T08:00:00Z",
      "X-Maple-Filename": "IMG_b.heic",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": "self-heal-restart-test",
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r4.status).toBe(200);
  });

  test("cross-device: second device gets 423 while peer is actively uploading", async () => {
    const sharedCloudId = "icloud-BUSY-PHOTO";
    // Phone starts a multi-chunk upload but doesn't finish yet.
    const phoneR1 = await app.handle(ingest(Buffer.alloc(128, 9), {
      "X-Maple-Device-Id": "phone-busy",
      "X-Maple-Phasset-Id": "phone-local-busy",
      "X-Maple-PHAsset-Cloud-Id": sharedCloudId,
      "X-Maple-Capture-Date": "2024-10-01T08:00:00Z",
      "X-Maple-Filename": "IMG_BUSY.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(phoneR1.status).toBe(202);

    // Desktop tries the same iCloud asset concurrently — should be told to back off.
    const desktopR = await app.handle(ingest(Buffer.alloc(128, 10), {
      "X-Maple-Device-Id": "desktop-busy",
      "X-Maple-Phasset-Id": "desktop-local-busy",
      "X-Maple-PHAsset-Cloud-Id": sharedCloudId,
      "X-Maple-Capture-Date": "2024-10-01T08:00:00Z",
      "X-Maple-Filename": "IMG_BUSY.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(desktopR.status).toBe(423);
    const body = await desktopR.json();
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(body.defer_positions).toBe(10);
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

  test("X-Maple-PHAsset-Cloud-Id is persisted into phasset_links", async () => {
    const phidCloud = "ABC/L0/CLOUD1";
    const cloudId = "icloud-XYZ-stable-across-devices";
    const res = await app.handle(ingest(Buffer.alloc(64, 13), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidCloud,
      "X-Maple-PHAsset-Cloud-Id": cloudId,
      "X-Maple-Capture-Date": "2024-08-01T08:00:00Z",
      "X-Maple-Filename": "IMG_CLOUD.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": "cloud-id-maple-id",
      "Content-Range": "bytes 0-63/64",
    }));
    expect(res.status).toBe(200);

    const a = await assetsCollection();
    const doc = await a.findOne({ "phasset_links.phasset_local_id": phidCloud });
    expect(doc).toBeTruthy();
    const link = doc!.phasset_links!.find((l) => l.phasset_local_id === phidCloud);
    expect(link).toBeTruthy();
    expect(link!.phasset_cloud_id).toBe(cloudId);
  });

  test("absent X-Maple-PHAsset-Cloud-Id leaves phasset_cloud_id unset", async () => {
    const phidNoCloud = "ABC/L0/NOCLOUD";
    const res = await app.handle(ingest(Buffer.alloc(64, 14), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidNoCloud,
      // No X-Maple-PHAsset-Cloud-Id header — simulates iCloud Photos off.
      "X-Maple-Capture-Date": "2024-08-01T08:00:00Z",
      "X-Maple-Filename": "IMG_NOCLOUD.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": "no-cloud-maple-id",
      "Content-Range": "bytes 0-63/64",
    }));
    expect(res.status).toBe(200);

    const a = await assetsCollection();
    const doc = await a.findOne({ "phasset_links.phasset_local_id": phidNoCloud });
    expect(doc).toBeTruthy();
    const link = doc!.phasset_links!.find((l) => l.phasset_local_id === phidNoCloud);
    expect(link).toBeTruthy();
    expect(link!.phasset_cloud_id).toBeUndefined();
  });

  test("second device with same maple_id $push's the link including its cloud id", async () => {
    const sharedMapleId = "shared-maple-id-cloud-test";
    const deviceA = "device-A-cloud";
    const deviceB = "device-B-cloud";
    const phidA = "ABC/L0/CLOUD-A";
    const phidB = "ABC/L0/CLOUD-B";
    const sharedCloudId = "icloud-shared-asset";

    // Device A uploads with its own (phid, cloud_id) pair.
    const rA = await app.handle(ingest(Buffer.alloc(64, 5), {
      "X-Maple-Device-Id": deviceA,
      "X-Maple-Phasset-Id": phidA,
      "X-Maple-PHAsset-Cloud-Id": sharedCloudId,
      "X-Maple-Capture-Date": "2024-09-01T08:00:00Z",
      "X-Maple-Filename": "IMG_DEDUP_CLOUD.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": sharedMapleId,
      "Content-Range": "bytes 0-63/64",
    }));
    expect(rA.status).toBe(200);

    // Device B uploads the same content (same maple_id) with its own phid
    // but the same cloud id (because both devices see the same iCloud asset).
    const rB = await app.handle(ingest(Buffer.alloc(64, 5), {
      "X-Maple-Device-Id": deviceB,
      "X-Maple-Phasset-Id": phidB,
      "X-Maple-PHAsset-Cloud-Id": sharedCloudId,
      "X-Maple-Capture-Date": "2024-09-01T08:00:00Z",
      "X-Maple-Filename": "IMG_DEDUP_CLOUD.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Maple-Id": sharedMapleId,
      "Content-Range": "bytes 0-63/64",
    }));
    expect(rB.status).toBe(200);

    const a = await assetsCollection();
    const docs = await a.find({ maple_id: sharedMapleId }).toArray();
    expect(docs.length).toBe(1);
    const links = docs[0].phasset_links ?? [];
    expect(links.length).toBe(2);
    const byPhid = new Map(links.map((l: any) => [l.phasset_local_id, l]));
    expect(byPhid.get(phidA)?.phasset_cloud_id).toBe(sharedCloudId);
    expect(byPhid.get(phidB)?.phasset_cloud_id).toBe(sharedCloudId);
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
