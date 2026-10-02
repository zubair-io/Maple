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
import { join, dirname, relative } from 'node:path';
import { maple } from 'maple';
import { thumbRoutes } from './thumb.ts';
import { registerLibrary } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import * as bitmapPool from '../../thumbs/bitmap-pool.ts';
import { solidRgb } from '../../test-support/synth-image.ts';

let tmp: string;
let live: LiveTestDatabase;
function get(p: string): Promise<Response> {
  const rel = relative(tmp, p).split('/').map(encodeURIComponent).join('/');
  return new Elysia().use(thumbRoutes).handle(new Request(`http://localhost/thumb/photos/${rel}`));
}

describe('Unified thumbnail cache — render and jail regressions', () => {
  beforeEach(async () => {
    tmp = await realpathDirect(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-hit-')));
    live = await createLiveTestDatabase();
    registerLibrary(live.db, tmp, 'photos');
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    invalidateLibraryRoots();
    live.close();
  });

  it('opens a warm cached derivative once without decoding', async () => {
    const source = join(tmp, 'a.jpg');
    await writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const cached = resolveThumbPath(source);
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, Buffer.from([1, 2, 3, 4, 5]));
    const openSpy = spyOn(fsp, 'open');
    const renderSpy = spyOn(bitmapPool, 'renderImageThumbToFileViaPool');
    try {
      const response = await get(source);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Thumb-Cache')).toBe('hit');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(openSpy).toHaveBeenCalledWith(cached, constants.O_RDONLY | constants.O_NOFOLLOW);
      expect(renderSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it('falls through to the render path when no cached thumb exists', async () => {
    const rawPath = join(tmp!, 'b.jpg');
    await maple(solidRgb(8, 8, [200, 40, 40]))
      .toFormat('jpeg')
      .toFile(rawPath);

    const res = await get(rawPath);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Thumb-Cache')).toBe('miss');
    expect(res.headers.get('Content-Type')).toBe('image/avif');

    // Decode-verified: the render path must have produced a real AVIF.
    const meta = await maple(Buffer.from(await res.arrayBuffer())).metadata();
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
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('library jail');

    await rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  it('a leaf symlink hits the cache (and does not re-render) on the second request', async () => {
    // Real file and a symlink to it with a DIFFERENT basename, both inside
    // the jail — the exact leaf-symlink shape the bug needs: same directory
    // (so `resolveJailedFile`'s realpath-based jail happily resolves it),
    // different filename (so `resolveThumbPath`'s basename hash differs
    // between the literal request path and the realpath-resolved target).
    const realPath = join(tmp!, 'real.jpg');
    await maple(solidRgb(8, 8, [10, 200, 10]))
      .toFormat('jpeg')
      .toFile(realPath);
    const linkPath = join(tmp!, 'link.jpg');
    await symlink(realPath, linkPath);

    const renderSpy = spyOn(bitmapPool, 'renderImageThumbToFileViaPool');
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
    const renderSpy = spyOn(bitmapPool, 'renderImageThumbToFileViaPool').mockResolvedValue({
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
