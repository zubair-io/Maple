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
