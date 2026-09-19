/**
 * Integration tests for GET /api/preview/:slug/*
 *
 * Like thumb.test.ts: exercises HTTP logic without invoking actual preview
 * generation (which requires native image files and the core). The one
 * catalogue lookup behind the route (`findAssetAtAddress`) runs against SQLite
 * (#3787) — a private in-memory database per test, installed as the
 * process-wide handle, seeded through the shared route fixtures.
 *
 * Nothing skips: there is no external service to be unreachable, so a pass here
 * means the assertions actually ran.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { previewRoutes } from './preview.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';

const app = new Elysia().use(previewRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  // realpath: `resolveAddress` compares the realpath'd target against the
  // realpath'd root, and on macOS os.tmpdir() sits under /var → /private/var.
  tmpDir = await realpath(await mkdtemp(path.join(tmpdir(), 'maple-preview-test-')));
  // One real `folders` row, so the slug → root and id → root lookups both
  // resolve through the cache production uses rather than a hand-stuffed map.
  libraryId = registerLibrary(live.db, tmpDir, 'prevlib');
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('GET /preview/:slug/*', () => {
  test('returns 400 when no filename is provided (empty wildcard)', async () => {
    // A request to /preview/:slug/ with no filename segment must be rejected
    // with 400, not treated as a library-root browse returning 202.
    const res = await app.handle(new Request('http://localhost/preview/prevlib/'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/filename/i);
  });

  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/preview/no-such-slug/photo.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 404 when file does not exist on disk and is not indexed', async () => {
    const res = await app.handle(new Request('http://localhost/preview/prevlib/ghost.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 202 with Retry-After when file exists on disk but is not indexed', async () => {
    await writeFile(path.join(tmpDir, 'pending.jpg'), 'fake-jpeg');
    const res = await app.handle(new Request('http://localhost/preview/prevlib/pending.jpg'));
    expect(res.status).toBe(202);
    expect(res.headers.get('Retry-After')).toBe('2');
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('indexing');
  });

  test('serves the single <filename>.avif with a file-based ETag and 304s on If-None-Match', async () => {
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'ready.jpg',
      mapleId: newObjectIdHex(),
    });

    // Pre-stage the one preview file so the route serves it without generating.
    // The serving path only stats/reads it (no decode), so arbitrary bytes work.
    const previewPath = path.join(tmpDir, '.maple', 'previews', 'ready.jpg.avif');
    await mkdir(path.dirname(previewPath), { recursive: true });
    await writeFile(previewPath, 'fake-preview-bytes');

    // First request: 200 with an ETag derived from the file's mtime/size, and a
    // revalidate (not immutable) Cache-Control — the preview is a mutable cache.
    const res = await app.handle(new Request('http://localhost/preview/prevlib/ready.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();

    // Conditional request with that ETag: 304.
    const revalidated = await app.handle(
      new Request('http://localhost/preview/prevlib/ready.jpg', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('ETag')).toBe(etag);
  });
});
