// fs-thumbs.cache-hit.test.ts
//
// #2258: a GET /api/fs/thumb cache HIT must cost exactly ONE filesystem
// operation — `readFile(thumbPath)` — down from five (`realpath(reqPath)`,
// `stat(source)`, `stat(thumbPath)`, `readFile(thumb + '.meta')`, plus the
// payload read). On an SMB-mounted library each op is a network round trip
// (~194ms measured before this change, ~12ms after).
//
// This file pins FIVE things the ticket calls out as easy to regress:
//   1. A hit performs exactly one fs read and touches nothing else (no
//      `stat`, no `realpath`) — this is the whole point of the ticket, so a
//      reintroduced `stat` must fail this test.
//   2. A miss (no cached thumb) still falls through to the full render path
//      and produces a correct thumbnail.
//   3. The miss path's `realpath`-based MAPLE_ROOTS jail still rejects a
//      symlink that escapes the jail — proving the fast path's cheaper,
//      non-realpath containment check did NOT weaken the real jail, which
//      stays exclusively on the miss path (it reads arbitrary source bytes).
//   4. A LEAF symlink (different basename than its target) does not cause a
//      permanent re-render loop. `tryServeCachedThumb`'s fast-path key is
//      derived from the raw `?path=` (never realpath-resolved); the render
//      path's key is derived from `real`. For a leaf symlink those two keys
//      hash differently, so without a second cache check after the jail
//      resolves the symlink, EVERY request would re-decode from source —
//      100% miss rate, unbounded CPU, a DoS vector via one symlinked
//      filename. Reviewed and fixed in #2258's follow-up (PR #2275 review).
//   5. The fast path applies the SAME decodable-extension allowlist as the
//      miss path (`resolveJailedFile`), not a weaker one. Without this, an
//      unsupported extension (e.g. `.txt`) would 200 with cached bytes
//      whenever `.maple/thumbs/<sha256(basename)>.avif` happened to already
//      exist at that path — contradicting the route's documented 415
//      contract, and widening what can be served as `image/avif` to
//      anything that can place or symlink a file under `.maple/thumbs/`.
//      Reviewed and fixed in #2258's follow-up (PR #2275 review, finding 3).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import * as fsp from 'node:fs/promises';
import {
  mkdtemp,
  rm,
  writeFile,
  realpath as realpathDirect,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import sharp from 'sharp';
import { fsThumbsRoutes } from './fs-thumbs.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { browseRoots } from '../fs/browse.ts';
import * as imgdecodePool from '../thumbs/imgdecode-pool.ts';

function get(p: string): Promise<Response> {
  const app = new Elysia().use(fsThumbsRoutes);
  return app.handle(new Request(`http://localhost/api/fs/thumb?path=${encodeURIComponent(p)}`));
}

describe('GET /api/fs/thumb — cache hit is ONE fs op (#2258)', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = await realpathDirect(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-hit-')));
    process.env.MAPLE_ROOTS = tmp;
    // Warm the memoized root resolution BEFORE installing spies / issuing
    // the request under test — this one-time `realpath` per configured root
    // is amortised across every request in production (#2219) and is not
    // part of the per-request budget this test pins.
    await browseRoots();
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  it('opens the thumb exactly once and never stats or realpaths on a cache hit', async () => {
    const rawPath = join(tmp!, 'a.jpg');
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const thumbPath = resolveThumbPath(rawPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from([1, 2, 3, 4, 5]));

    // The hit path opens with `O_NOFOLLOW` rather than calling `readFile`
    // (symlink refusal, PR #2275 review finding 3) — so the assertion is on
    // `open`. The property under test is unchanged and is what matters on an
    // SMB mount: ONE filesystem round trip for the bytes, and specifically no
    // `stat` and no `realpath`, each of which cost ~12 ms there uncached.
    const openSpy = spyOn(fsp, 'open');
    const readFileSpy = spyOn(fsp, 'readFile');
    const statSpy = spyOn(fsp, 'stat');
    const realpathSpy = spyOn(fsp, 'realpath');
    const mkdirSpy = spyOn(fsp, 'mkdir');
    try {
      const res = await get(rawPath);
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Thumb-Cache')).toBe('hit');

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(thumbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Nothing else touches the filesystem: no second read of the thumb, and
      // above all no metadata round trips.
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(statSpy).not.toHaveBeenCalled();
      expect(realpathSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      readFileSpy.mockRestore();
      statSpy.mockRestore();
      realpathSpy.mockRestore();
      mkdirSpy.mockRestore();
    }
  });

  it('falls through to the render path when no cached thumb exists', async () => {
    const rawPath = join(tmp!, 'b.jpg');
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 200, g: 40, b: 40 },
      },
    })
      .jpeg()
      .toFile(rawPath);

    const res = await get(rawPath);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumb-Cache')).toBe('miss');
    expect(res.headers.get('Content-Type')).toBe('image/avif');

    // Decode-verified: the render path must have produced a real AVIF.
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('heif');

    // And the thumb is now on disk for the next request's fast path.
    const thumbPath = resolveThumbPath(rawPath);
    const bytes = await fsp.readFile(thumbPath);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it('the miss path still rejects a symlink escaping MAPLE_ROOTS', async () => {
    // Sibling tmp dir OUTSIDE the jailed root, holding the "secret" file a
    // symlink will try to reach.
    const outside = await realpathDirect(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-outside-')));
    const secretPath = join(outside, 'secret.jpg');
    await writeFile(secretPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    // A symlink INSIDE the jailed root pointing at the file outside it. No
    // thumb is cached for either shape, so the fast path misses and this
    // must fall to `resolveJailedFile`'s realpath-based containment check.
    const escapePath = join(tmp!, 'escape.jpg');
    await symlink(secretPath, escapePath);

    const res = await get(escapePath);
    expect(res.status).toBe(403);

    await rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  it('a leaf symlink hits the cache (and does not re-render) on the second request', async () => {
    // Real file and a symlink to it with a DIFFERENT basename, both inside
    // the jail — the exact leaf-symlink shape the bug needs: same directory
    // (so `resolveJailedFile`'s realpath-based jail happily resolves it),
    // different filename (so `resolveThumbPath`'s basename hash differs
    // between the literal request path and the realpath-resolved target).
    const realPath = join(tmp!, 'real.jpg');
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .jpeg()
      .toFile(realPath);
    const linkPath = join(tmp!, 'link.jpg');
    await symlink(realPath, linkPath);

    const renderSpy = spyOn(imgdecodePool, 'renderImageThumbToFileViaPool');
    try {
      // First request: nothing cached under EITHER key, so this renders.
      const first = await get(linkPath);
      expect(first.status).toBe(200);
      expect(first.headers.get('X-Thumb-Cache')).toBe('miss');

      // Second request through the SAME symlink: the fast path's literal-path
      // key (`link.jpg`'s hash) still misses — nothing is ever cached under
      // it — but the miss path's post-jail re-check against `real`'s key
      // must now find the thumb the first request wrote. Without that
      // re-check this would ALSO be "miss" (and would render a third,
      // fourth, ... time forever).
      const second = await get(linkPath);
      expect(second.status).toBe(200);
      expect(second.headers.get('X-Thumb-Cache')).toBe('hit');

      // The render pool must have been invoked exactly once total — the
      // second request served entirely from the on-disk cache.
      expect(renderSpy).toHaveBeenCalledTimes(1);
    } finally {
      renderSpy.mockRestore();
    }
  });

  it('415s a .txt request even when a matching cached .avif exists at that path', async () => {
    // `resolveThumbPath` is pure path math over the basename — it has no
    // opinion on extension, so a cache file can exist at exactly the path
    // the fast path would read for `note.txt` even though `.txt` was never
    // a legitimately-thumbnail-able source. Staged explicitly: this is the
    // whole point of the case, and the test must fail against code that
    // doesn't apply the extension gate on the fast path.
    const txtPath = join(tmp!, 'note.txt');
    await writeFile(txtPath, 'hello');
    const thumbPath = resolveThumbPath(txtPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]));

    const res = await get(txtPath);
    expect(res.status).toBe(415);
  });

  it('refuses a symlink planted AT the thumb path instead of serving its target', async () => {
    // Second half of PR #2275 review finding 3. Anything able to write inside
    // `.maple/thumbs/` — a real concern on an untrusted or shared library
    // mount — could point `<hash>.avif` at any readable file and have this
    // route hand back its bytes as `image/avif`. `readFile` follows symlinks,
    // so the fast path opens with `O_NOFOLLOW`; against a plain `readFile`
    // this test fails with 200 and the secret as the body.
    const secret = join(tmp!, 'not-an-image.txt');
    await writeFile(secret, 'SUPER-SECRET-NOT-AN-IMAGE');

    const src = join(tmp!, 'planted.jpg');
    await writeFile(src, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const thumbPath = resolveThumbPath(src);
    await mkdir(dirname(thumbPath), { recursive: true });
    await symlink(secret, thumbPath);

    // Render is stubbed to fail so the request cannot fall through into a real
    // decode — this asserts the FAST path refused, rather than a re-render
    // happening to overwrite the symlink first.
    const renderSpy = spyOn(imgdecodePool, 'renderImageThumbToFileViaPool').mockResolvedValue({
      ok: false,
      error: 'stubbed',
    });
    try {
      const res = await get(src);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain('SUPER-SECRET');
    } finally {
      renderSpy.mockRestore();
    }
  });
});
