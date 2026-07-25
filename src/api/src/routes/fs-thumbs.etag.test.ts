// fs-thumbs.etag.test.ts
//
// Covers the GET /api/fs/thumb ETag + Cache-Control contract post-#2258: the
// ETag is derived from the cached thumb's BYTES (a body hash), not from
// `stat(source)` — computing it needs no extra syscall since the bytes are
// already in hand from the one read a cache hit performs. Consequences
// pinned here:
//   - the ETag is stable across repeated hits of the same unchanged thumb
//     (the observable proxy for "a client refetches once after the byte-hash
//     switch, then stays stable" — there's no prior server build to diff
//     against in-process, so stability under repeat is what's testable);
//   - a matching If-None-Match still short-circuits to 304, just AFTER the
//     read now (the validator can't be known before the bytes are);
//   - Cache-Control is unchanged from before #2258: `private, max-age=3600`
//     on every response, unconditionally. There is no revision token and no
//     `immutable` — the URL (`?path=…`) is stable across a re-render, so an
//     `immutable` response against it would risk pinning stale bytes in a
//     client's HTTP cache for a year.
//
// The route is exercised via its own pre-staged thumb cache file so the
// test does not require sharp/heic/libraw to be available.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fsThumbsRoutes } from './fs-thumbs.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { browseRoots } from '../fs/browse.ts';

describe('GET /api/fs/thumb — ETag + Cache-Control', () => {
  let tmp: string | null = null;
  let rawPath: string | null = null;
  let thumbPath: string | null = null;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-etag-')));
    process.env.MAPLE_ROOTS = tmp;
    // Warm the memoized root resolution before staging anything — matches
    // steady-state production behaviour, where `browseRoots()` has already
    // resolved once by the time real request traffic arrives.
    await browseRoots();

    // Use a .jpg so a MISS would take the sharp branch — but every test
    // here pre-stages the cache thumb directly, so sharp is never invoked.
    rawPath = join(tmp, 'a.jpg');
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    thumbPath = resolveThumbPath(rawPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from([1, 2, 3, 4, 5]));
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  function get(ifNoneMatch?: string): Promise<Response> {
    const app = new Elysia().use(fsThumbsRoutes);
    const headers = ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : undefined;
    return app.handle(
      new Request(`http://localhost/api/fs/thumb?path=${encodeURIComponent(rawPath!)}`, {
        headers,
      }),
    );
  }

  it('returns a quoted ETag and the one-hour, private Cache-Control on 200', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumb-Cache')).toBe('hit');
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]+"$/);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=3600');
  });

  it('is stable across repeated hits of the same unchanged thumb', async () => {
    const first = await get();
    const second = await get();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
  });

  it('returns 304 with Cache-Control echoed when If-None-Match matches', async () => {
    // RFC 9110 §15.4.5: a 304 SHOULD carry the same Cache-Control the 200
    // would, so a client's HTTP cache doesn't downgrade its freshness on
    // every revalidation.
    const first = await get();
    const etag = first.headers.get('ETag')!;
    const cacheControl200 = first.headers.get('Cache-Control');

    const second = await get(etag);
    expect(second.status).toBe(304);
    expect(second.headers.get('ETag')).toBe(etag);
    expect(second.headers.get('Cache-Control')).toBe(cacheControl200);
  });

  it('produces a different ETag when the cached thumb bytes change', async () => {
    const first = await get();
    const etag1 = first.headers.get('ETag')!;

    // Overwrite the CACHED THUMB (not the source) with different bytes —
    // the ETag is a hash of exactly these, so it must change even though
    // nothing about the source file was touched.
    await writeFile(thumbPath!, Buffer.from([9, 9, 9]));

    const second = await get();
    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(etag1);

    // The stale validator must not still 304 against the new content.
    const third = await get(etag1);
    expect(third.status).not.toBe(304);
  });
});
