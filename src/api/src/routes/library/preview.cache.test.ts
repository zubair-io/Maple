import { PIPELINE_OUTPUT_VERSION } from '../../generated/adjustment-fields.generated.ts';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';

import { previewRoutes } from './preview.ts';
import { cachePathFor } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import * as videoPosterModule from '../../thumbs/video-poster.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

describe('Unified preview — legacy reader regressions', () => {
  let live: LiveTestDatabase;
  let tmp: string;
  let rawPath: string;
  let libraryId: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-previews-')));
    libraryId = registerLibrary(live.db, tmp, 'photos');
    rawPath = join(tmp, 'a.jpg');
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    live.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    invalidateLibraryRoots();
  });

  const get = (file: string, headers: Record<string, string> = {}) => {
    const rel = relative(tmp, file).split('/').map(encodeURIComponent).join('/');
    return new Elysia()
      .use(previewRoutes)
      .handle(new Request(`http://localhost/preview/photos/${rel}`, { headers }));
  };

  /** Pre-stage the legacy basename-keyed cache entry with distinct bytes. */
  const stagePreview = async (bytes: Buffer) => {
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'a.jpg',
      mapleId: 'original-id',
    });
    const previewPath = cachePathFor(rawPath, 'previews', PREVIEW_CACHE_SUFFIX);
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, bytes);
  };

  it('rejects traversal outside the library jail', async () => {
    const res = await new Elysia()
      .use(previewRoutes)
      .handle(new Request('http://localhost/preview/photos/%2e%2e%2foutside.jpg'));
    expect(res.status).toBe(400);
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
      seedRouteAsset(live.db, {
        libraryId,
        path: '',
        filename: 'no-decoder.mov',
      });
      const res = await get(videoPath);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/ffmpeg/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('serves a fresh pre-staged preview with an ETag, and 304s on If-None-Match', async () => {
    const staged = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    await stagePreview(staged);

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
    seedRouteAsset(live.db, { libraryId, path: '', filename: 'a.jpg' });

    const pathKeyed = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const previewPath = join(
      tmp,
      '.maple',
      'previews',
      `a.jpg.v${PIPELINE_OUTPUT_VERSION}.${PREVIEW_CACHE_SUFFIX}`,
    );
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, pathKeyed);

    const res = await get(rawPath);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pathKeyed);
  });
});
