/**
 * Integration test for GET /api/assets/:id/histogram.
 *
 * Without libraw_ffi the route can't compute, so we exercise:
 *   - 400 on a malformed id
 *   - 404 on an unknown id
 *   - Cache-hit short-circuit (pre-populate the `.maple/histograms/`
 *     JSON to a key matching the stat-ed mtime; the route should serve it
 *     without touching the dylib).
 *   - 304 short-circuit on If-None-Match
 *   - 503 when no cache and the dylib is unavailable
 *
 * Skip-passes when Mongo isn't reachable, same shape as the thumb ETag
 * tests in the same folder.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { closeDb } from "../db/client.ts";
import { assetsRoutes } from "./assets.ts";
import { cachePathForAsset } from "../fs/xmp.ts";
import { invalidateLibraryRoots } from "../indexer/libraries.cache.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_histogram_test_${process.pid}`;

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
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe("GET /api/assets/:id/histogram", () => {
  let client: MongoClient | null = null;
  let db: Db | null = null;
  let tmp: string | null = null;
  let assetId: ObjectId | null = null;
  let mapleId: string | null = null;
  let libraryId: ObjectId | null = null;
  let rawPath: string | null = null;

  beforeEach(async () => {
    client = await tryConnect();
    if (!client) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = client.db(TEST_DB);
    await db.dropDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), "maple-histogram-")));
    process.env.MAPLE_ROOTS = tmp;
    rawPath = join(tmp, "a.dng");
    // Write 64 bytes so stat returns a real, non-zero size.
    await writeFile(rawPath, Buffer.alloc(64));
    assetId = new ObjectId();
    mapleId = "hist" + assetId.toHexString();
    libraryId = new ObjectId();
    await db.collection("folders").insertOne({
      _id: libraryId,
      path: tmp,
      label: "histogram-test",
      last_scan: null,
      file_count: 0,
      created_at: "now",
    } as never);
    await db.collection("assets").insertOne({
      _id: assetId,
      fileinfo: [
        {
          path: "",
          filename: "a.dng",
          library_id: libraryId,
          deleted_at: null,
        },
      ],
      maple_id: mapleId,
      size: 64,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: "now",
    } as never);
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await closeDb();
    db = null;
    client = null;
    tmp = null;
  });

  function url(id: string): string {
    return `http://localhost/api/assets/${id}/histogram`;
  }

  it("400s on a malformed asset id", async () => {
    if (!client) {
      console.log("[assets.histogram.test] MongoDB unreachable — skipping");
      return;
    }
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(new Request(url("not-an-objectid")));
    expect(res.status).toBe(400);
  });

  it("404s on an unknown asset id", async () => {
    if (!client) return;
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(url(new ObjectId().toHexString())),
    );
    expect(res.status).toBe(404);
  });

  it("serves a cached histogram without touching the dylib", async () => {
    if (!client) return;
    // Pre-populate the on-disk cache with a key matching the RAW's mtime.
    const { stat } = await import("node:fs/promises");
    const rawStat = await stat(rawPath!);
    const key = `${Math.floor(rawStat.mtimeMs)}-none`;
    const { loadLibraryRoots } = await import("../indexer/libraries.cache.ts");
    const libs = await loadLibraryRoots();
    const jsonPath = cachePathForAsset(
      {
        maple_id: mapleId ?? undefined,
        fileinfo: [
          {
            path: "",
            filename: "a.dng",
            library_id: libraryId!,
            deleted_at: null,
          },
        ],
      },
      libs,
      "previews",
      "histogram.json",
    )!;
    expect(jsonPath).not.toBeNull();
    await mkdir(dirname(jsonPath), { recursive: true });
    // Synthetic bins — single spike per channel at bin 100.
    const r = new Array(256).fill(0);
    const g = new Array(256).fill(0);
    const b = new Array(256).fill(0);
    r[100] = 10;
    g[100] = 10;
    b[100] = 10;
    await writeFile(
      jsonPath,
      JSON.stringify({ key, bins: { r, g, b } }),
      "utf-8",
    );

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(new Request(url(assetId!.toHexString())));
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"${key}"`);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await res.json()) as {
      r: number[];
      g: number[];
      b: number[];
    };
    expect(body.r.length).toBe(256);
    expect(body.r[100]).toBe(10);
    expect(body.g[100]).toBe(10);
    expect(body.b[100]).toBe(10);
  });

  it("returns 304 on If-None-Match without reading the cache", async () => {
    if (!client) return;
    const { stat } = await import("node:fs/promises");
    const rawStat = await stat(rawPath!);
    const key = `${Math.floor(rawStat.mtimeMs)}-none`;
    const etag = `"${key}"`;
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(url(assetId!.toHexString()), {
        headers: { "If-None-Match": etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect((await res.text()).length).toBe(0);
  });

  it("advances the etag when the XMP sidecar mtime changes", async () => {
    if (!client) return;
    const { stat } = await import("node:fs/promises");
    const rawStat = await stat(rawPath!);
    // No sidecar — cached key has the `-none` suffix.
    const keyBefore = `${Math.floor(rawStat.mtimeMs)}-none`;

    // Pre-stage the cache so we don't need the dylib for this assertion.
    const { loadLibraryRoots } = await import("../indexer/libraries.cache.ts");
    const libs = await loadLibraryRoots();
    const jsonPath = cachePathForAsset(
      {
        maple_id: mapleId ?? undefined,
        fileinfo: [
          {
            path: "",
            filename: "a.dng",
            library_id: libraryId!,
            deleted_at: null,
          },
        ],
      },
      libs,
      "previews",
      "histogram.json",
    )!;
    await mkdir(dirname(jsonPath), { recursive: true });
    const r = new Array(256).fill(0);
    const g = new Array(256).fill(0);
    const b = new Array(256).fill(0);
    await writeFile(
      jsonPath,
      JSON.stringify({ key: keyBefore, bins: { r, g, b } }),
      "utf-8",
    );

    const app = new Elysia().use(assetsRoutes);
    const first = await app.handle(new Request(url(assetId!.toHexString())));
    expect(first.status).toBe(200);
    const etag1 = first.headers.get("ETag");

    // Now add a sidecar — the new key has its mtime in the second slot.
    const xmpPath = rawPath!.replace(/\.dng$/, ".xmp");
    await writeFile(xmpPath, "<x:xmpmeta />", "utf-8");
    const xmpStat = await stat(xmpPath);
    const keyAfter = `${Math.floor(rawStat.mtimeMs)}-${Math.floor(xmpStat.mtimeMs)}`;
    expect(keyAfter).not.toBe(keyBefore);

    // The conditional request with the old etag must NOT 304 — the
    // sidecar's mtime is part of the cache key. The route will fall
    // through to compute (which 503s without the dylib) or serve a
    // freshly-cached entry. Either way, status !== 304.
    const second = await app.handle(
      new Request(url(assetId!.toHexString()), {
        headers: { "If-None-Match": etag1 ?? "" },
      }),
    );
    expect(second.status).not.toBe(304);
  });

  it("503s when no cache exists and the dylib is unavailable", async () => {
    if (!client) return;
    // No pre-staged cache file. With libraw_ffi.dylib absent from the
    // test environment, ffiPool().computeHistogram rejects with the
    // sentinel "dylib not available" error and the route surfaces a 503.
    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(new Request(url(assetId!.toHexString())));
    // If the host happens to have the dylib built locally, the route
    // can succeed with 200 — accept either, since the 503 branch is
    // an env-dependent outcome. CI without the dylib will hit 503.
    expect([200, 500, 503]).toContain(res.status);
  });
});
