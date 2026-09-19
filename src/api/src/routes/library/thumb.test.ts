/**
 * Integration tests for GET /api/thumb/:slug/*
 *
 * Does NOT exercise actual thumb generation (that requires real image files
 * and the native core). Tests the HTTP logic: slug resolution, 404/202 guards,
 * ETag / Cache-Control, and 304 short-circuit.
 *
 * The catalogue lookup behind the route (`findAssetAtAddress`) runs against
 * SQLite (#3787) — a private in-memory database per test, installed as the
 * process-wide handle, seeded through the shared route fixtures. Nothing skips.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { thumbRoutes } from './thumb.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';

const app = new Elysia().use(thumbRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-thumb-test-')));
  libraryId = registerLibrary(live.db, tmpDir, 'thumblib');
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('GET /thumb/:slug/*', () => {
  test('returns 400 when no filename is provided (empty wildcard)', async () => {
    // A request to /thumb/:slug/ with no filename segment must be rejected
    // with 400, not treated as a library-root browse returning 202.
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/filename/i);
  });

  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/thumb/no-such-slug/photo.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 404 when file does not exist on disk and is not indexed', async () => {
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/ghost.jpg'));
    expect(res.status).toBe(404);
  });

  test('serves an on-the-fly thumb (200, not 202) for an un-indexed on-disk file', async () => {
    const src = path.join(tmpDir, 'pending.jpg');
    await writeFile(src, 'fake-source');
    // Pre-seed the path-keyed thumb so the route serves it without invoking
    // native generation (mirrors the 304 test below). The behavioural contract
    // under test is: un-indexed + on-disk no longer 202s — it renders/serves a
    // real JPEG with a weak, revalidating validator (NOT immutable).
    const thumbPath = resolveThumbPath(src);
    await mkdir(path.dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, 'thumb-bytes');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/pending.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(res.headers.get('Cache-Control')).toContain('must-revalidate');
    expect(res.headers.get('Cache-Control')).not.toContain('immutable');
    expect(res.headers.get('ETag') ?? '').toMatch(/^W\//); // weak validator
  });

  test('on-the-fly thumb honours If-None-Match with a 304', async () => {
    const src = path.join(tmpDir, 'pending2.jpg');
    await writeFile(src, 'fake-source-2');
    const thumbPath = resolveThumbPath(src);
    await mkdir(path.dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, 'thumb-bytes-2');

    const first = await app.handle(new Request('http://localhost/thumb/thumblib/pending2.jpg'));
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^W\//);

    const second = await app.handle(
      new Request('http://localhost/thumb/thumblib/pending2.jpg', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get('ETag')).toBe(etag);
  });

  test('returns 404 (never a 200 image) for an un-indexed video on disk', async () => {
    // Post-#1638 videos are selectable, so the grid will request thumbs for
    // them. A video has no still frame: the route must 404 rather than fall
    // through to generation (which would otherwise copy the raw .MOV bytes to
    // a .avif and serve 200 image/avif garbage → broken <img>).
    const src = path.join(tmpDir, 'clip.mov');
    await writeFile(src, 'fake-video-bytes');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/clip.mov'));
    expect(res.status).toBe(404);
    // Critically: NOT a 200 image with video bytes.
    expect(res.status).not.toBe(200);
    expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
    expect(res.headers.get('Content-Type')).not.toBe('image/avif');
  });

  test('returns 404 (never a 200 image) for an indexed video asset', async () => {
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'indexed-clip.mp4',
      mapleId: newObjectIdHex(),
      mediaKind: 'video',
    });
    const src = path.join(tmpDir, 'indexed-clip.mp4');
    await writeFile(src, 'fake-video-bytes-2');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/indexed-clip.mp4'));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
    expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
    expect(res.headers.get('Content-Type')).not.toBe('image/avif');
  });

  test.each(['scan.eip', 'session.braw', 'project.afphoto', 'logo.ai'])(
    'returns 404 (never a 200 image) for an un-indexed stub image on disk (%s, #1835)',
    async (filename) => {
      // Metadata-only stub images have no decoder: the route must 404 rather
      // than fall through to generation (which would otherwise copy the raw
      // source bytes to a .avif and serve 200 image/avif garbage).
      const src = path.join(tmpDir, filename);
      await writeFile(src, 'fake-stub-bytes');

      const res = await app.handle(new Request(`http://localhost/thumb/thumblib/${filename}`));
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(200);
      expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
      expect(res.headers.get('Content-Type')).not.toBe('image/avif');
    },
  );

  test.each(['track.mp3', 'voice.wav', 'memo.m4a', 'song.aac'])(
    'returns 404 (never a 200 image) for an un-indexed audio file on disk (%s, #1835)',
    async (filename) => {
      const src = path.join(tmpDir, filename);
      await writeFile(src, 'fake-audio-bytes');

      const res = await app.handle(new Request(`http://localhost/thumb/thumblib/${filename}`));
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(200);
      expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
      expect(res.headers.get('Content-Type')).not.toBe('image/avif');
    },
  );

  test('returns 304 when ETag matches If-None-Match', async () => {
    const mapleId = newObjectIdHex();
    seedRouteAsset(live.db, { libraryId, path: '', filename: 'cached.jpg', mapleId });

    // The indexed branch answers the conditional request from `maple_id` alone
    // and returns before it resolves (or generates) the thumb file, so there is
    // nothing to pre-stage on disk here.
    const etag = `"${mapleId}"`;
    const res = await app.handle(
      new Request('http://localhost/thumb/thumblib/cached.jpg', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
  });
});
