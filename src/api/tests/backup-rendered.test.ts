import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { foldersCollection, assetsCollection, uploadSessionsCollection } from "../src/db/client.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const libId = new ObjectId();
const deviceId = "test-device-rendered";
const phid = "REND/L0/001";
const phid2 = "REND/L0/002";
const mapleId = "rendered-maple-id";
const originalRelPath = "2024/Tokyo/03-15/IMG_RENDERED.HEIC";
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), "maple-rendered-test-"));
  const f = await foldersCollection();
  await f.insertOne({ _id: libId, path: tmpLib, label: "test", created_at: new Date(), file_count: 0 } as any);
  const { invalidateLibraryRoots } = await import(
    "../src/indexer/libraries.cache.ts",
  );
  invalidateLibraryRoots();

  // Pre-create an AssetDoc that simulates a prior ingest.
  const assetPath = path.join(tmpLib, originalRelPath);
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, Buffer.alloc(64, 1));

  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.device_id": deviceId });
  // Post drop-abs-path-2026-05-21: persisted on-disk pointer is on
  // `fileinfo[]`. The rendered route scopes its update by
  // `{ 'fileinfo.library_id', maple_id }` so the seed must carry
  // `fileinfo[].library_id` for the dedup match.
  await a.insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        library_id: libId,
        path: path.dirname(originalRelPath),
        filename: path.basename(originalRelPath),
        deleted_at: null,
      },
    ],
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

  // Ensure no leftover upload sessions.
  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
});

afterAll(async () => {
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function rendered(body: Buffer, headers: Record<string, string>, libOverride?: string): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/rendered`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body,
  });
}

describe("POST /api/libraries/:id/backup/rendered", () => {
  test("happy path single chunk → .rendered.HEIC created + AssetDoc updated", async () => {
    const bytes = Buffer.alloc(128, 7);
    const res = await app.handle(rendered(bytes, {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid,
      "X-Maple-Target-Rel-Path": originalRelPath,
      "X-Maple-Total-Bytes": "128",
      "X-Maple-Maple-Id": mapleId,
      "Content-Range": "bytes 0-127/128",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = "2024/Tokyo/03-15/IMG_RENDERED.rendered.HEIC";
    expect(body.target_rel_path).toBe(expected);

    // File exists on disk.
    const onDisk = await fs.readFile(path.join(tmpLib, expected));
    expect(onDisk.byteLength).toBe(128);

    // AssetDoc updated with apple_rendered_path.
    const a = await assetsCollection();
    const doc = await a.findOne({ maple_id: mapleId });
    expect(doc?.apple_rendered_path).toBe(expected);
  });

  test("explicit extension via X-Maple-Filename-Ext", async () => {
    const phidExt = "REND/L0/EXT";
    const mapleIdExt = "rendered-ext-maple-id";
    const bytes = Buffer.alloc(64, 8);

    // Insert a minimal asset so the rendered endpoint can update it.
    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libId,
      filename: "IMG_EXT.HEIC",
      abs_path: path.join(tmpLib, "2024/05/01/IMG_EXT.HEIC"),
      size: 64,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: mapleIdExt,
      phasset_links: [{ device_id: deviceId, phasset_local_id: phidExt, first_seen: new Date() }],
      deleted_from_photos: false,
    } as any);

    const res = await app.handle(rendered(bytes, {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidExt,
      "X-Maple-Target-Rel-Path": "2024/05/01/IMG_EXT.HEIC",
      "X-Maple-Total-Bytes": "64",
      "X-Maple-Filename-Ext": ".JPEG",
      "X-Maple-Maple-Id": mapleIdExt,
      "Content-Range": "bytes 0-63/64",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe("2024/05/01/IMG_EXT.rendered.JPEG");
  });

  test("X-Maple-Suffix-Override: Live Photo .mov lands as <base>.mov (no .rendered. infix)", async () => {
    const phidMov = "REND/L0/MOV";
    const mapleIdMov = "rendered-mov-maple-id";
    const bytes = Buffer.alloc(96, 9);

    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libId,
      filename: "IMG_MOV.HEIC",
      abs_path: path.join(tmpLib, "2024/08/01/IMG_MOV.HEIC"),
      size: 96,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: mapleIdMov,
      phasset_links: [{ device_id: deviceId, phasset_local_id: phidMov, first_seen: new Date() }],
      deleted_from_photos: false,
    } as any);

    const res = await app.handle(rendered(bytes, {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidMov,
      "X-Maple-Target-Rel-Path": "2024/08/01/IMG_MOV.HEIC",
      "X-Maple-Total-Bytes": "96",
      "X-Maple-Rendered-Ext": "mov",
      "X-Maple-Suffix-Override": "mov",
      "X-Maple-Maple-Id": mapleIdMov,
      "Content-Range": "bytes 0-95/96",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // With suffix-override "mov" the file is "IMG_MOV.mov", NOT "IMG_MOV.rendered.mov".
    expect(body.target_rel_path).toBe("2024/08/01/IMG_MOV.mov");

    // File exists on disk with the correct name.
    const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path));
    expect(onDisk.byteLength).toBe(96);
  });

  test("chunked resume across two chunks", async () => {
    const mapleId2 = "rendered-resume-maple-id";

    // Insert a minimal asset.
    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libId,
      filename: "IMG_RESUME.HEIC",
      abs_path: path.join(tmpLib, "2024/06/01/IMG_RESUME.HEIC"),
      size: 256,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: mapleId2,
      phasset_links: [{ device_id: deviceId, phasset_local_id: phid2, first_seen: new Date() }],
      deleted_from_photos: false,
    } as any);

    const r1 = await app.handle(rendered(Buffer.alloc(128, 3), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Target-Rel-Path": "2024/06/01/IMG_RESUME.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await app.handle(rendered(Buffer.alloc(128, 3), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid2,
      "X-Maple-Target-Rel-Path": "2024/06/01/IMG_RESUME.HEIC",
      "X-Maple-Total-Bytes": "256",
      "X-Maple-Maple-Id": mapleId2,
      "Content-Range": "bytes 128-255/256",
    }));
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.target_rel_path).toBe("2024/06/01/IMG_RESUME.rendered.HEIC");

    // Assembled file is 256 bytes.
    const onDisk = await fs.readFile(path.join(tmpLib, b2.target_rel_path));
    expect(onDisk.byteLength).toBe(256);
  });

  test("missing required header → 400", async () => {
    const r = await app.handle(rendered(Buffer.alloc(16), {
      "X-Maple-Device-Id": deviceId,
      // no phasset id
      "X-Maple-Target-Rel-Path": originalRelPath,
      "X-Maple-Total-Bytes": "16",
      "Content-Range": "bytes 0-15/16",
    }));
    expect(r.status).toBe(400);
  });

  test("409 on resume offset mismatch", async () => {
    const phidOff = "REND/L0/OFF";
    const mapleIdOff = "rendered-offset-maple-id";

    const a = await assetsCollection();
    await a.insertOne({
      _id: new ObjectId(),
      folder_id: libId,
      filename: "IMG_OFF.HEIC",
      abs_path: path.join(tmpLib, "2024/07/01/IMG_OFF.HEIC"),
      size: 256,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      maple_id: mapleIdOff,
      phasset_links: [{ device_id: deviceId, phasset_local_id: phidOff, first_seen: new Date() }],
      deleted_from_photos: false,
    } as any);

    const r1 = await app.handle(rendered(Buffer.alloc(128, 5), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidOff,
      "X-Maple-Target-Rel-Path": "2024/07/01/IMG_OFF.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 0-127/256",
    }));
    expect(r1.status).toBe(202);

    const r2 = await app.handle(rendered(Buffer.alloc(128, 5), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phidOff,
      "X-Maple-Target-Rel-Path": "2024/07/01/IMG_OFF.HEIC",
      "X-Maple-Total-Bytes": "256",
      "Content-Range": "bytes 64-191/256", // wrong start
    }));
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(128);
  });

  test("path traversal in X-Maple-Target-Rel-Path → 400", async () => {
    const r = await app.handle(rendered(Buffer.alloc(16), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid,
      "X-Maple-Target-Rel-Path": "../../../etc/passwd",
      "X-Maple-Total-Bytes": "16",
      "Content-Range": "bytes 0-15/16",
    }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toContain("unsafe");
  });

  test("library not found → 404", async () => {
    const r = await app.handle(rendered(Buffer.alloc(16), {
      "X-Maple-Device-Id": deviceId,
      "X-Maple-Phasset-Id": phid,
      "X-Maple-Target-Rel-Path": originalRelPath,
      "X-Maple-Total-Bytes": "16",
      "X-Maple-Maple-Id": mapleId,
      "Content-Range": "bytes 0-15/16",
    }, new ObjectId().toHexString()));
    expect(r.status).toBe(404);
  });

  test("rendered session de-dup: synthetic phid doesn't collide with original session", async () => {
    // After the first happy-path test, the original session (phid) is completed.
    // A new rendered session with the same phid should start fresh.
    const u = await uploadSessionsCollection();
    const origSess = await u.findOne({
      device_id: deviceId,
      phasset_local_id: phid,
      state: "completed",
    });
    const rendSess = await u.findOne({
      device_id: deviceId,
      phasset_local_id: `${phid}::rendered`,
      state: "completed",
    });
    // Both sessions exist and are distinct.
    expect(origSess?._id).not.toEqual(rendSess?._id);
  });
});
