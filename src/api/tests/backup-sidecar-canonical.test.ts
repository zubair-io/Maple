/**
 * A backed-up photo's sidecar lands under the canonical name the server reads
 * (`IMG_1234.HEIC` → `IMG_1234.xmp`; videos keep `IMG_1234.MOV.xmp`), and a
 * `<stem>.xmp` shared by a same-stem pair is never overwritten by the other
 * photo's send (#5021, #4692). Real temp library files and a private SQLite
 * database.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObjectId } from "../src/db/object-id.ts";
import { authedHandle } from "./helpers/authed-handle.ts";
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from "../src/db/sqlite/test-sqlite.test-helpers.ts";
import { seedBackupAsset, seedLibrary } from "./helpers/sqlite-fixtures.ts";
import { invalidateLibraryRoots } from "../src/indexer/libraries.cache.ts";

const deviceId = "test-device-canonical";

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const xmp = (label: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/">${label}</x:xmpmeta>`;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(
    path.join(os.tmpdir(), "maple-sidecar-canonical-test-"),
  );
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, {
    path: tmpLib,
    label: "sidecar-canonical-test",
  });
  invalidateLibraryRoots();
});

afterAll(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

interface Upload {
  relPath: string;
  phid: string;
  assetId: ObjectId;
}

async function seedUpload(relPath: string): Promise<Upload> {
  const phid = `CANON/${relPath}/L0/001`;
  const abs = path.join(tmpLib, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.alloc(64, 1));
  const assetId = seedBackupAsset(live.db, {
    mapleId: createHash("md5").update(relPath).digest("hex"),
    size: 64,
    locations: [{ libraryId: libId, relPath }],
    links: [{ deviceId, phassetLocalId: phid }],
  });
  return { relPath, phid, assetId };
}

function post(
  target: Upload,
  body: string,
  base: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Maple-Device-Id": deviceId,
    "X-Maple-Phasset-Id": target.phid,
    "X-Maple-Target-Rel-Path": target.relPath,
  };
  if (base !== undefined) headers["X-Maple-Sidecar-Base"] = base;
  return authedHandle(
    new Request(
      `http://localhost/api/libraries/${libId.toHexString()}/backup/sidecar`,
      {
        method: "POST",
        headers,
        body,
      },
    ),
  );
}

const read = (relPath: string) =>
  fs.readFile(path.join(tmpLib, relPath), "utf8").catch(() => null);

function keptAside(sidecarRelPath: string) {
  return live.db
    .query(
      `SELECT displaced_xmp, displaced_sha256, incoming_sha256 FROM sidecar_divergences
        WHERE sidecar_rel_path = ? ORDER BY rowid`,
    )
    .all(sidecarRelPath);
}

describe("backup sidecar canonical name (#5021)", () => {
  test("an uploaded photo edit is what the server reads back for that photo", async () => {
    const photo = await seedUpload("2024/03/15/IMG_1234.HEIC");

    const res = await post(photo, xmp("device edit"), "none");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target_rel_path: "2024/03/15/IMG_1234.xmp",
    });
    const served = await authedHandle(
      new Request(
        `http://localhost/api/assets/${photo.assetId.toHexString()}/xmp`,
      ),
    );
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("device edit");
    expect(await read("2024/03/15/IMG_1234.HEIC.xmp")).toBeNull();
  });

  test("a first send without a base also uses the canonical name", async () => {
    const photo = await seedUpload("2024/03/16/IMG_2000.JPG");

    const res = await post(photo, xmp("legacy client"), undefined);

    expect(await res.json()).toEqual({
      target_rel_path: "2024/03/16/IMG_2000.xmp",
    });
    expect(await read("2024/03/16/IMG_2000.xmp")).toBe(xmp("legacy client"));
  });

  test("a video keeps its full-name sidecar", async () => {
    const clip = await seedUpload("2024/03/17/IMG_3000.MOV");

    const res = await post(clip, xmp("clip edit"), "none");

    expect(await res.json()).toEqual({
      target_rel_path: "2024/03/17/IMG_3000.MOV.xmp",
    });
    expect(await read("2024/03/17/IMG_3000.MOV.xmp")).toBe(xmp("clip edit"));
  });
});

describe("a same-stem pair shares one sidecar (#4692)", () => {
  test("one photo's send never overwrites the sidecar the other photo wrote", async () => {
    const jpeg = await seedUpload("2024/04/01/IMG_9.jpg");
    const raw = await seedUpload("2024/04/01/IMG_9.cr2");
    expect((await post(jpeg, xmp("jpeg edit"), "none")).status).toBe(200);

    const res = await post(raw, xmp("raw edit"), "none");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target_rel_path: "2024/04/01/IMG_9.xmp",
      shared: true,
    });
    expect(await read("2024/04/01/IMG_9.xmp")).toBe(xmp("jpeg edit"));
    expect(keptAside("2024/04/01/IMG_9.xmp")).toEqual([
      {
        displaced_xmp: xmp("raw edit"),
        displaced_sha256: sha256(xmp("raw edit")),
        incoming_sha256: sha256(xmp("raw edit")),
      },
    ]);
  });

  test("the other photo sending the same edit joins the shared sidecar", async () => {
    const jpeg = await seedUpload("2024/04/02/IMG_8.jpg");
    const raw = await seedUpload("2024/04/02/IMG_8.cr2");
    await post(jpeg, xmp("pair edit"), "none");

    const res = await post(raw, xmp("pair edit"), "none");

    expect(await res.json()).toEqual({
      target_rel_path: "2024/04/02/IMG_8.xmp",
      unchanged: true,
    });
    expect(keptAside("2024/04/02/IMG_8.xmp")).toEqual([]);
  });

  test("the photo that wrote the shared sidecar can still update it", async () => {
    const jpeg = await seedUpload("2024/04/03/IMG_7.jpg");
    await seedUpload("2024/04/03/IMG_7.cr2");
    await post(jpeg, xmp("v1"), "none");

    const res = await post(jpeg, xmp("v2"), sha256(xmp("v1")));

    expect(await res.json()).toEqual({
      target_rel_path: "2024/04/03/IMG_7.xmp",
    });
    expect(await read("2024/04/03/IMG_7.xmp")).toBe(xmp("v2"));
  });

  test("without a base the other photo cannot replace the shared sidecar either", async () => {
    const jpeg = await seedUpload("2024/04/04/IMG_6.jpg");
    const raw = await seedUpload("2024/04/04/IMG_6.cr2");
    await post(jpeg, xmp("jpeg edit"), "none");

    const res = await post(raw, xmp("raw edit"), undefined);

    expect(await res.json()).toEqual({
      target_rel_path: "2024/04/04/IMG_6.xmp",
      skipped: true,
    });
    expect(await read("2024/04/04/IMG_6.xmp")).toBe(xmp("jpeg edit"));
  });
});
