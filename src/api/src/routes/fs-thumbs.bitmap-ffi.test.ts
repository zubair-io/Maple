// fs-thumbs.bitmap-ffi.test.ts
//
// GET /api/fs/thumb for a non-RAW bitmap source when the raw-ffi dylib isn't
// built. Since #3499 bitmap thumbnails (JPEG/PNG/WebP/TIFF/AVIF/HEIC/PSD/HDR)
// dispatch through the SAME `ffiPool()` as RAW — the pool's `requestId()`
// throws `ffi-pool: raw-ffi dylib not available` before a request ever
// reaches a child. Left unguarded that throw was caught by the bitmap
// branch's generic catch and reported as a 500 ("FFI bitmap pool error for
// jpg: ffi-pool: raw-ffi dylib not available") — technically true, but not
// the actionable 503 the RAW branch already gives an operator with no
// libraw_ffi build. This pins the bitmap branch to the same 503 + message.
//
// Split from `fs-thumbs.cache-hit.test.ts` rather than appended: that file
// covers ONE-fs-op behaviour on a hit and is not the place for a dylib-
// availability case.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsThumbsRoutes } from './fs-thumbs.ts';
import { _createFfiPoolForTests, _setFfiPoolForTests } from '../ffi/ffi-pool.ts';

function get(p: string): Promise<Response> {
  const app = new Elysia().use(fsThumbsRoutes);
  return app.handle(new Request(`http://localhost/api/fs/thumb?path=${encodeURIComponent(p)}`));
}

describe('GET /api/fs/thumb — bitmap branch, FFI dylib unavailable', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-thumb-bitmap-ffi-')));
    process.env.MAPLE_ROOTS = tmp;
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
  });

  it('503s (not 500) a JPEG thumb request when the dylib is not available', async () => {
    // `availableOverride: false` skips the real dylib probe; the fake worker
    // factory throws if ever called — this case must reject before a worker
    // is even spawned.
    const fakePool = _createFfiPoolForTests({
      workerFactory: () => {
        throw new Error('should not spawn a worker — available() is false');
      },
      availableOverride: false,
    });
    const previous = _setFfiPoolForTests(fakePool);
    try {
      const p = join(tmp!, 'photo.jpg');
      await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const res = await get(p);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/build-raw-ffi\.sh/);
    } finally {
      _setFfiPoolForTests(previous);
    }
  });
});
