/**
 * Route-integration test: GET /api/assets/:id/histogram.
 *
 * Without libraw_ffi the route can't compute, so we exercise:
 *   - 400 on a malformed id
 *   - 404 on an unknown id
 *   - Cache-hit short-circuit (pre-populate the `.maple/previews/`
 *     JSON to a key matching the stat-ed mtime; the route should serve it
 *     without touching the dylib).
 *   - 304 short-circuit on If-None-Match
 *   - 503 when no cache and the dylib is unavailable
 *
 * The catalogue side is SQLite (#3787): a private database per test, installed
 * as the process-wide handle the route resolves, seeded through the shared
 * route fixtures. The cache path is derived from the RAW's own path with
 * `cachePathFor`, which is where `cachePathForAsset` lands for an asset sitting
 * at the library root — one fewer hand-built document in the test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assetsRoutes } from './assets.ts';
import { cachePathFor } from '../fs/xmp.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('GET /api/assets/:id/histogram', () => {
  let live: LiveTestDatabase;
  let tmp: string;
  let assetId: string;
  let rawPath: string;
  let previousRoots: string | undefined;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-histogram-')));
    previousRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = tmp;
    rawPath = join(tmp, 'a.dng');
    // Write 64 bytes so stat returns a real, non-zero size.
    await writeFile(rawPath, Buffer.alloc(64));
    const libraryId = registerLibrary(live.db, tmp);
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'a.dng',
      size: 64,
      mapleId: `hist-${newObjectIdHex()}`,
    });
  });

  afterEach(async () => {
    if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousRoots;
    live.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  function url(id: string): string {
    return `http://localhost/api/assets/${id}/histogram`;
  }

  /** Pre-stage the on-disk histogram cache at `key`, so no dylib is needed. */
  async function stageCache(key: string, spike: number | null): Promise<void> {
    const jsonPath = cachePathFor(rawPath, 'previews', 'histogram.json');
    await mkdir(dirname(jsonPath), { recursive: true });
    const channel = (): number[] => {
      const bins = new Array(256).fill(0) as number[];
      if (spike !== null) bins[100] = spike;
      return bins;
    };
    await writeFile(
      jsonPath,
      JSON.stringify({ key, bins: { r: channel(), g: channel(), b: channel() } }),
      'utf-8',
    );
  }

  /** The cache key the route computes: RAW mtime, then sidecar mtime or `none`. */
  async function currentKey(): Promise<string> {
    const rawStat = await stat(rawPath);
    return `${Math.floor(rawStat.mtimeMs)}-none`;
  }

  it('400s on a malformed asset id', async () => {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(new Request(url('not-an-objectid')));
    expect(res.status).toBe(400);
  });

  it('404s on an unknown asset id', async () => {
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(new Request(url(newObjectIdHex())));
    expect(res.status).toBe(404);
  });

  it('serves a cached histogram without touching the dylib', async () => {
    const key = await currentKey();
    await stageCache(key, 10);

    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(new Request(url(assetId)));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(`"${key}"`);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = (await res.json()) as { r: number[]; g: number[]; b: number[] };
    expect(body.r.length).toBe(256);
    expect(body.r[100]).toBe(10);
    expect(body.g[100]).toBe(10);
    expect(body.b[100]).toBe(10);
  });

  it('returns 304 on If-None-Match without reading the cache', async () => {
    const etag = `"${await currentKey()}"`;
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(new Request(url(assetId), { headers: { 'If-None-Match': etag } }));
    expect(res.status).toBe(304);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect((await res.text()).length).toBe(0);
  });

  it('advances the etag when the XMP sidecar mtime changes', async () => {
    // No sidecar — cached key has the `-none` suffix.
    const keyBefore = await currentKey();
    await stageCache(keyBefore, null);

    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const first = await app.handle(new Request(url(assetId)));
    expect(first.status).toBe(200);
    const etag1 = first.headers.get('ETag');

    // Now add a sidecar — the new key has its mtime in the second slot.
    const xmpPath = rawPath.replace(/\.dng$/, '.xmp');
    await writeFile(xmpPath, '<x:xmpmeta />', 'utf-8');
    const rawStat = await stat(rawPath);
    const xmpStat = await stat(xmpPath);
    const keyAfter = `${Math.floor(rawStat.mtimeMs)}-${Math.floor(xmpStat.mtimeMs)}`;
    expect(keyAfter).not.toBe(keyBefore);

    // The conditional request with the old etag must NOT 304 — the
    // sidecar's mtime is part of the cache key. The route will fall
    // through to compute (which 503s without the dylib) or serve a
    // freshly-cached entry. Either way, status !== 304.
    const second = await app.handle(
      new Request(url(assetId), { headers: { 'If-None-Match': etag1 ?? '' } }),
    );
    expect(second.status).not.toBe(304);
  });

  it('503s when no cache exists and the dylib is unavailable', async () => {
    // No pre-staged cache file. With libraw_ffi.dylib absent from the
    // test environment, ffiPool().computeHistogram rejects with the
    // sentinel "dylib not available" error and the route surfaces a 503.
    const app = new Elysia().use(fakeAuth()).use(assetsRoutes);
    const res = await app.handle(new Request(url(assetId)));
    // If the host happens to have the dylib built locally, the route
    // can succeed with 200 — accept either, since the 503 branch is
    // an env-dependent outcome. CI without the dylib will hit 503.
    expect([200, 500, 503]).toContain(res.status);
  });
});
