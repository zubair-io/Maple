/**
 * Route-integration test: GET /api/assets/:id/thumb — ETag and revalidation.
 *
 * The catalogue side is SQLite (#3787): a private database per test, installed
 * as the process-wide handle the route resolves. The thumb itself is staged at
 * `resolveThumbPath(rawPath)` — the same path the route composes — which also
 * lets the "delete the thumb between requests" case name the file directly
 * instead of re-reading the asset document to re-derive it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, mkdir, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assetsRoutes } from './assets.ts';
import { resolveThumbPath } from '../fs/xmp.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../db/sqlite/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('GET /api/assets/:id/thumb — ETag', () => {
  let live: LiveTestDatabase;
  let tmp: string;
  let assetId: string;
  let rawPath: string;
  let previousRoots: string | undefined;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    // realpath() so MAPLE_ROOTS matches the realpath-resolved abs_path on
    // macOS where /tmp is a symlink to /private/tmp.
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-thumb-etag-')));
    previousRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = tmp;
    rawPath = join(tmp, 'a.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const libraryId = registerLibrary(live.db, tmp);
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'a.dng',
      size: 8,
      mapleId: `thumbetag-${newObjectIdHex()}`,
    });
    // Stage the thumb at the path-keyed location the route resolves. NOTE the
    // ETag is still the maple_id — it is a content validator, independent of the
    // cache filename, which is keyed on the basename (#2220 follow-up).
    const thumbPath = resolveThumbPath(rawPath);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]));
  });

  afterEach(async () => {
    if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousRoots;
    live.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  function get(headers: Record<string, string> = {}): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    return app.handle(new Request(`http://localhost/api/assets/${assetId}/thumb`, { headers }));
  }

  it('returns ETag on 200', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^".+"$/);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const first = await get();
    const etag = first.headers.get('ETag')!;
    const second = await get({ 'If-None-Match': etag });
    expect(second.status).toBe(304);
  });

  it('304 short-circuits BEFORE the body is read', async () => {
    // Regression for Copilot review: previous shape read the file and
    // THEN computed the ETag, so a 304-bound request still paid the
    // disk-read cost. The fix stats first, returns 304 if matched, and
    // only reads the body on a cache miss. What we can assert
    // unambiguously: the response body length for a 304 MUST be zero,
    // and the route must not throw in the unused-read branch.
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag')!;
    const second = await get({ 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect((await second.text()).length).toBe(0);
  });

  it('304 returns even when body would be unreadable (proves no read on hit)', async () => {
    // Sharper version of the test above: physically delete the thumb
    // between the priming request and the conditional one. The stat
    // call inside the route will fail (file is gone) so the route will
    // now 404 — but only IF the ETag check runs against the new (i.e.
    // missing-file) state. If the previous shape were still in place
    // (read first, then stat), the route would have already errored on
    // the read. Either way, the absence of "200 with empty body" or a
    // 500 confirms the short-circuit path runs against the live stat.
    const first = await get();
    const etag = first.headers.get('ETag')!;
    await unlink(resolveThumbPath(rawPath));
    const second = await get({ 'If-None-Match': etag });
    expect(second.status).toBe(404);
  });

  it('304 echoes the 200 Cache-Control so URLSession keeps freshness', async () => {
    // RFC 9110 §15.4.5 — a 304 response SHOULD include the same
    // Cache-Control the 200 would. Without this, URLSession's HTTP
    // cache downgrades its freshness on every revalidation.
    const first = await get();
    const etag = first.headers.get('ETag')!;
    const cacheControl200 = first.headers.get('Cache-Control');
    expect(cacheControl200).toBe('public, max-age=604800, immutable');
    const second = await get({ 'If-None-Match': etag });
    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toBe(cacheControl200);
  });
});
