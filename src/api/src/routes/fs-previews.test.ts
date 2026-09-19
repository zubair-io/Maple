// fs-previews.test.ts
//
// Covers GET /api/fs/preview — the display-resolution tier behind the
// Apple Preview screen's thumbnail → hi-res swap.
//
// Serving is exercised via pre-staged `.maple/previews/` cache files (fresh
// mtime) so the tests never invoke maple/libraw. The catalogue lookup behind
// the path-keyed entry runs against SQLite (#3787): a private database per
// test, installed as the process-wide handle, which is also what makes the
// route's `isSqliteOpen()` guard open the catalogue branch at all.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { fsPreviewsRoutes, libraryAddressFor } from './fs-previews.ts';
import { cachePathFor } from '../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../indexer/previewer.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import * as videoPosterModule from '../thumbs/video-poster.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('libraryAddressFor', () => {
  const roots = new Map([['aaaaaaaaaaaaaaaaaaaaaaaa', '/lib/photos']]);

  it('splits a nested path into (relDir, filename)', () => {
    expect(libraryAddressFor('/lib/photos/2024/trip/a.dng', roots)).toEqual({
      libraryIdHex: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      relDir: '2024/trip',
      filename: 'a.dng',
    });
  });

  it('uses an empty relDir at the library root', () => {
    expect(libraryAddressFor('/lib/photos/a.dng', roots)).toEqual({
      libraryIdHex: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      relDir: '',
      filename: 'a.dng',
    });
  });

  it('returns null for a path outside every root', () => {
    expect(libraryAddressFor('/elsewhere/a.dng', roots)).toBeNull();
  });

  it('tolerates a trailing slash on the configured root', () => {
    const slashed = new Map([['aaaaaaaaaaaaaaaaaaaaaaaa', '/lib/photos/']]);
    expect(libraryAddressFor('/lib/photos/a.dng', slashed)?.filename).toBe('a.dng');
  });
});

describe('GET /api/fs/preview', () => {
  let live: LiveTestDatabase;
  let tmp: string;
  let rawPath: string;
  let previousRoots: string | undefined;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-previews-')));
    previousRoots = process.env.MAPLE_ROOTS;
    process.env.MAPLE_ROOTS = tmp;
    rawPath = join(tmp, 'a.jpg');
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    if (previousRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = previousRoots;
    live.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    invalidateLibraryRoots();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Elysia().use(fsPreviewsRoutes).handle(
      new Request(`http://localhost/api/fs/preview?path=${encodeURIComponent(path)}`, {
        headers,
      }),
    );

  /** Pre-stage the legacy basename-keyed cache entry with distinct bytes. */
  const stageLegacyPreview = async (bytes: Buffer) => {
    const previewPath = cachePathFor(rawPath, 'previews', PREVIEW_CACHE_SUFFIX);
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, bytes);
  };

  it('rejects a relative path', async () => {
    const res = await get('not/absolute.jpg');
    expect(res.status).toBe(400);
  });

  it('rejects a path outside MAPLE_ROOTS', async () => {
    const res = await get('/etc/hosts');
    // realpath succeeds for /etc/hosts, so this must be the jail (403);
    // an unsupported-extension 415 would mean the jail ran too late.
    expect(res.status).toBe(403);
  });

  it('415s an unsupported extension inside the jail', async () => {
    const docPath = join(tmp, 'notes.txt');
    await writeFile(docPath, 'hello');
    const res = await get(docPath);
    expect(res.status).toBe(415);
  });

  // #2132: video shares the jail with /api/fs/thumb, and used to be rejected
  // there by an allowlist that predated poster-frame extraction (#1649).
  it('does not 415 a video at the extension gate', async () => {
    const videoPath = join(tmp, 'clip.mov');
    await writeFile(videoPath, Buffer.from('container bytes'));
    const res = await get(videoPath);
    expect(res.status).not.toBe(415);
  });

  it('503s (not 500) for a video when the host has no ffmpeg', async () => {
    // Without this the request falls through to `generatePreview`, which
    // writes nothing and lands on the generic "Preview generation failed"
    // 500 — indistinguishable from a real server fault.
    const spy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const videoPath = join(tmp, 'no-decoder.mov');
      await writeFile(videoPath, Buffer.from('container bytes'));
      const res = await get(videoPath);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/ffmpeg/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('serves a fresh pre-staged preview with an ETag, and 304s on If-None-Match', async () => {
    const staged = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    await stageLegacyPreview(staged);

    const res = await get(rawPath);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/avif');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(staged);

    const revalidated = await get(rawPath, { 'if-none-match': etag! });
    expect(revalidated.status).toBe(304);
    // Not immutable / long-max-age — the preview is overwritten in place on
    // edit, so clients must revalidate (the file-based ETag then busts) (#2017).
    expect(revalidated.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
  });

  it('serves the indexer-written <filename>.avif when the asset is indexed (no maple_id needed)', async () => {
    const libraryId = registerLibrary(live.db, tmp, 'test-lib');
    seedRouteAsset(live.db, { libraryId, path: '', filename: 'a.jpg' });

    const pathKeyed = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const previewPath = join(tmp, '.maple', 'previews', `a.jpg.${PREVIEW_CACHE_SUFFIX}`);
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, pathKeyed);

    const res = await get(rawPath);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pathKeyed);
  });
});
