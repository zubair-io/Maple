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
    // Pre-stage the .meta sidecar so the new freshness check (which
    // requires (mtime, size) to match what produced the cached thumb)
    // classifies the pre-staged thumb as fresh and the route returns
    // it without invoking sharp.
    const rawStat = await stat(rawPath);
    await writeFile(
      `${thumbPath}.meta`,
      JSON.stringify({ mtimeMs: rawStat.mtimeMs, size: rawStat.size }),
    );
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

  it("regenerates the cached thumb when RAW size changes but mtime is preserved", async () => {
    // Regression: previous cached-thumb freshness check only compared
    // mtime, so an mtime-preserved overwrite with different size would
    // skip the 304, then serve the stale cached thumb anyway under a
    // brand-new (size-aware) ETag. Fix: freshness also requires the
    // sidecar .meta to match the current (mtime, size).
    //
    // We can't easily prove the BYTES change without actually rendering
    // a new thumb (the sharp render path would do that for us, but the
    // test stages a static .jpg as the cache to avoid pulling sharp).
    // The observable signal we DO have: the X-Thumb-Cache header. A
    // size-different overwrite must produce a "miss" (regenerated),
    // not a "hit" (stale reuse).
    const before = await stat(rawPath!);
    const app = new Elysia().use(fsThumbsRoutes);
    // Pre-staged thumb + meta = fresh hit.
    const first = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Thumb-Cache")).toBe("hit");

    // Overwrite the RAW with different-size content, restore the mtime
    // so an mtime-only freshness check would still say "fresh", and
    // delete the cached thumb so a regenerate doesn't have to invoke
    // sharp (we only need to prove the staleness DETECTION fires).
    // Replace the thumb with a known sentinel that the route would
    // serve back if it incorrectly classified the cached thumb as
    // fresh — but the size-aware check should reject it first.
    await writeFile(
      rawPath!,
      Buffer.from([0xff, 0xd8, 0xff, 0xd8, 0xff, 0xd9]),
    );
    await utimes(rawPath!, before.atime, before.mtime);

    // The .meta still records the ORIGINAL (mtime, size). The new RAW
    // size differs. The route MUST classify the cached thumb as stale
    // and either regen (sharp) or, in this synthetic test, attempt to
    // regen — observable via a non-"hit" cache header.
    //
    // We don't care whether sharp succeeds; the discriminating signal
    // is: NOT "hit". If the size mismatch were ignored the header
    // would be "hit" and we'd serve stale bytes under a new ETag.
    const after = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
      ),
    );
    expect(after.headers.get("X-Thumb-Cache")).not.toBe("hit");
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

    // Use If-None-Match on the follow-up to exercise the early ETag
    // short-circuit without forcing the regenerate branch (which would
    // need sharp in the test env). The response will be 304 IFF the
    // ETag is unchanged — a 200 response (any status not 304) signals
    // the new ETag differs.
    const second = await app.handle(
      new Request(
        `http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`,
        { headers: { "If-None-Match": etag1 } },
      ),
    );
    expect(second.status).not.toBe(304);
  });
});
