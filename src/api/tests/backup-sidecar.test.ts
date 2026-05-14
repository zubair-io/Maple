import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { foldersCollection, assetsCollection } from "../src/db/client.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const libId = new ObjectId();
const deviceId = "test-device-sidecar";
const phid = "SIDE/L0/001";
const mapleId = "sidecar-maple-id";
const targetRelPath = "2024/Tokyo/03-15/IMG_SIDECAR.HEIC";
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), "maple-sidecar-test-"));
  const f = await foldersCollection();
  await f.insertOne({ _id: libId, path: tmpLib, label: "test", created_at: new Date(), file_count: 0 } as any);

  // Pre-create an AssetDoc that simulates a prior ingest.
  const assetPath = path.join(tmpLib, targetRelPath);
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, Buffer.alloc(64, 1));

  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.device_id": deviceId });
  await a.insertOne({
    _id: new ObjectId(),
    folder_id: libId,
    filename: "IMG_SIDECAR.HEIC",
    abs_path: assetPath,
    size: 64,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: "",
    indexed_at: new Date().toISOString(),
    maple_id: mapleId,
    phasset_links: [{ device_id: deviceId, phasset_local_id: phid, first_seen: new Date() }],
    deleted_from_photos: false,
  } as any);
});

afterAll(async () => {
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function sidecarRequest(
  body: string | Buffer,
  headers: Record<string, string>,
  libOverride?: string,
): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/sidecar`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
}

describe("POST /api/libraries/:id/backup/sidecar", () => {
  test("happy path — writes .xmp next to original", async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>`;
    const res = await app.handle(
      sidecarRequest(xmp, {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe(`${targetRelPath}.xmp`);

    // Verify file exists on disk with correct content.
    const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path), "utf8");
    expect(onDisk).toBe(xmp);
  });

  test("second write — overwrites existing sidecar atomically", async () => {
    const xmp1 = `<x:xmpmeta>v1</x:xmpmeta>`;
    const xmp2 = `<x:xmpmeta>v2</x:xmpmeta>`;

    const r1 = await app.handle(
      sidecarRequest(xmp1, {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(r1.status).toBe(200);

    const r2 = await app.handle(
      sidecarRequest(xmp2, {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(r2.status).toBe(200);

    const onDisk = await fs.readFile(
      path.join(tmpLib, `${targetRelPath}.xmp`),
      "utf8",
    );
    expect(onDisk).toBe(xmp2);
  });

  test("missing required header → 400", async () => {
    const r = await app.handle(
      sidecarRequest("<x/>", {
        "X-Maple-Device-Id": deviceId,
        // no phasset id
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(r.status).toBe(400);
  });

  test("no prior ingest for this device+phasset → 404", async () => {
    const r = await app.handle(
      sidecarRequest("<x/>", {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": "UNKNOWN/L0/999",
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toContain("no prior upload");
  });

  test("library not found → 404", async () => {
    const r = await app.handle(
      sidecarRequest("<x/>", {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": targetRelPath,
      }, new ObjectId().toHexString()),
    );
    expect(r.status).toBe(404);
  });

  test("body exceeds 256 KB → 413", async () => {
    const big = Buffer.alloc(257 * 1024, 0x41); // 257 KB of 'A'
    const r = await app.handle(
      sidecarRequest(big, {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": targetRelPath,
      }),
    );
    expect(r.status).toBe(413);
  });

  test("path traversal in X-Maple-Target-Rel-Path → 400", async () => {
    const r = await app.handle(
      sidecarRequest("<x/>", {
        "X-Maple-Device-Id": deviceId,
        "X-Maple-Phasset-Id": phid,
        "X-Maple-Target-Rel-Path": "../../etc/passwd",
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toContain("unsafe");
  });
});
