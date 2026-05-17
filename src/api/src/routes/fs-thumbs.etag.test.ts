// fs-thumbs.etag.test.ts
//
// Covers the GET /api/fs/thumb ETag contract. ETag composes mtime + size,
// so an mtime-preserved overwrite that changes content (and therefore
// size) produces a fresh validator. The previous mtime-only ETag would
// have served a stale thumb.
//
// The route is exercised via its own pre-staged thumb cache file so the
// test does not require sharp/heic/libraw to be available.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import {
  mkdtemp,
  rm,
  writeFile,
  realpath,
  mkdir,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fsThumbsRoutes } from "./fs-thumbs.ts";
import { resolveThumbPath } from "../fs/xmp.ts";

describe("GET /api/fs/thumb — ETag", () => {
  let tmp: string | null = null;
  let rawPath: string | null = null;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "maple-fs-thumb-etag-")));
    process.env.MAPLE_ROOTS = tmp;
    // Use a .jpg so the route takes the SHARP branch — but we pre-stage
    // the cache thumb to avoid actually invoking sharp. The route's
    // "fresh thumb" short-circuit returns the staged bytes directly.
    rawPath = join(tmp, "a.jpg");
    // Minimal-but-valid JPEG SOI bytes; exact content doesn't matter for
    // the ETag path, only the file stat.
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const thumbPath = resolveThumbPath(rawPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    // Make the thumb newer than the raw so the route serves it fresh.
    await writeFile(thumbPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("returns ETag containing mtime AND size on 200", async () => {
    const app = new Elysia().use(fsThumbsRoutes);
    const res = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    expect(res.status).toBe(200);
    // Shape: "<mtime>-<size>" — the size component is the critical bit
    // this test guards.
    expect(res.headers.get("ETag")).toMatch(/^"\d+-\d+"$/);
  });

  it("returns 304 with Cache-Control echoed when If-None-Match matches", async () => {
    // RFC 9110 §15.4.5: a 304 SHOULD carry the same Cache-Control the
    // 200 would, so URLSession's HTTP cache doesn't downgrade its
    // freshness on every revalidation.
    const app = new Elysia().use(fsThumbsRoutes);
    const first = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    const etag = first.headers.get("ETag")!;
    const cacheControl200 = first.headers.get("Cache-Control");
    expect(cacheControl200).toBe("private, max-age=3600");

    const second = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
        { headers: { "If-None-Match": etag } },
      ),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("ETag")).toBe(etag);
    expect(second.headers.get("Cache-Control")).toBe(cacheControl200);
  });

  it("produces a different ETag when content changes but mtime is preserved", async () => {
    // Capture the original times so we can restore them after overwriting.
    const before = await stat(rawPath!);
    const app = new Elysia().use(fsThumbsRoutes);
    const first = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    expect(first.status).toBe(200);
    const etag1 = first.headers.get("ETag")!;

    // Overwrite with DIFFERENT content (different size), then restore the
    // mtime so an mtime-only ETag would not change. The size-aware ETag
    // must still change.
    await writeFile(rawPath!, Buffer.from([0xff, 0xd8, 0xff, 0xd8, 0xff, 0xd9]));
    await utimes(rawPath!, before.atime, before.mtime);

    const second = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    expect(second.status).toBe(200);
    const etag2 = second.headers.get("ETag")!;
    expect(etag2).not.toBe(etag1);
  });
});
