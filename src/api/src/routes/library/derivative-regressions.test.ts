import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from '../../fs/mirrored.ts';
import { thumbRoutes } from './thumb.ts';
import { previewRoutes } from './preview.ts';
import { resolveThumbPath, cachePathFor } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { _createFfiPoolForTests, _setFfiPoolForTests } from '../../ffi/ffi-pool.ts';
import * as videoPoster from '../../thumbs/video-poster.ts';
import * as bitmapPool from '../../thumbs/bitmap-pool.ts';

let live: LiveTestDatabase;
let root: string;
let libraryId: string;
const app = new Elysia({ prefix: '/api' }).use(thumbRoutes).use(previewRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-unified-derivative-')));
  libraryId = registerLibrary(live.db, root, 'photos');
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(root, { recursive: true, force: true });
});

function get(tier: 'thumb' | 'preview', name: string, etag?: string) {
  return app.handle(
    new Request(`http://localhost/api/${tier}/photos/${encodeURIComponent(name)}`, {
      headers: etag ? { 'If-None-Match': etag } : undefined,
    }),
  );
}

async function stage(name: string, tier: 'thumb' | 'preview', indexed: boolean) {
  const source = join(root, name);
  await writeFile(source, 'original');
  if (indexed)
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: name,
      mapleId: 'maple-id',
    });
  const output =
    tier === 'thumb' ? resolveThumbPath(source) : cachePathFor(source, 'previews', 'avif');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, 'first-cache-body');
  return { source, output };
}

for (const indexed of [false, true]) {
  test(`thumbnail bytes determine the validator (${indexed ? 'indexed' : 'pre-index'})`, async () => {
    const { output } = await stage('photo.jpg', 'thumb', indexed);
    const first = await get('thumb', 'photo.jpg');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('first-cache-body');
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    const unchanged = await get('thumb', 'photo.jpg', etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('Cache-Control')).toBe(first.headers.get('Cache-Control'));
    expect(await unchanged.text()).toBe('');
    await writeFile(output, 'replacement-cache-body');
    const changed = await get('thumb', 'photo.jpg', etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(etag);
    expect(await changed.text()).toBe('replacement-cache-body');
  });
}

for (const tier of ['thumb', 'preview'] as const) {
  test(`${tier} refuses a symlink planted at the cache file`, async () => {
    const { output } = await stage('photo.jpg', tier, true);
    const secret = join(root, 'private.txt');
    await writeFile(secret, 'SECRET-BYTES');
    await rm(output);
    await symlink(secret, output);
    const render = spyOn(bitmapPool, 'renderImageThumbToFileViaPool').mockResolvedValue({
      ok: false,
    });
    try {
      const response = await get(tier, 'photo.jpg');
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain('SECRET-BYTES');
    } finally {
      render.mockRestore();
    }
  });

  test(`${tier} refuses a symlinked cache directory`, async () => {
    const { output } = await stage('photo.jpg', tier, true);
    const cacheDirectory = dirname(output);
    const displaced = join(root, 'secret-cache');
    await mkdir(displaced);
    await writeFile(join(displaced, output.split('/').at(-1)!), 'SECRET-DIRECTORY-BYTES');
    await rm(cacheDirectory, { recursive: true });
    await symlink(displaced, cacheDirectory);
    const response = await get(tier, 'photo.jpg');
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('SECRET-DIRECTORY-BYTES');
  });

  test(`${tier} rejects unsupported files even with pre-staged cache bytes`, async () => {
    await stage('notes.txt', tier, true);
    const response = await get(tier, 'notes.txt');
    expect(response.status).toBe(415);
  });

  test(`${tier} reports a missing native decoder as an actionable 503`, async () => {
    await stage('photo.jpg', tier, true).then(({ output }) => rm(output));
    const unavailable = _createFfiPoolForTests({
      availableOverride: false,
      workerFactory: () => {
        throw new Error('decoder must not launch');
      },
    });
    const previous = _setFfiPoolForTests(unavailable);
    try {
      const response = await get(tier, 'photo.jpg');
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toContain('build-raw-ffi.sh');
    } finally {
      _setFfiPoolForTests(previous);
    }
  });

  test(`${tier} serves a warm video cache without ffmpeg or the native decoder`, async () => {
    await stage('clip.MOV', tier, true);
    const ffmpeg = spyOn(videoPoster, 'ffmpegBinary').mockResolvedValue(null);
    const unavailable = _createFfiPoolForTests({
      availableOverride: false,
      workerFactory: () => {
        throw new Error('warm cache must not decode');
      },
    });
    const previous = _setFfiPoolForTests(unavailable);
    try {
      const response = await get(tier, 'clip.MOV');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('first-cache-body');
      expect(ffmpeg).not.toHaveBeenCalled();
    } finally {
      _setFfiPoolForTests(previous);
      ffmpeg.mockRestore();
    }
  });

  test(`${tier} reports missing ffmpeg on a cold video request`, async () => {
    await stage('clip.MOV', tier, true).then(({ output }) => rm(output));
    const ffmpeg = spyOn(videoPoster, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const response = await get(tier, 'clip.MOV');
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: string }).error).toMatch(/ffmpeg/i);
    } finally {
      ffmpeg.mockRestore();
    }
  });
}
