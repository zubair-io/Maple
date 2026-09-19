/**
 * Integration tests for GET /api/folder/:slug/*
 *
 * A real temp directory, so `readdir` walks something, and a real library row,
 * so the slug resolves and the catalog rows have a library to belong to.
 *
 * The handler reaches `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { folderRoutes } from './folder.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots, setLibraryBySlugForTests } from '../../indexer/libraries.cache.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';

const app = new Elysia().use(fakeAuth()).use(folderRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await mkdtemp(path.join(tmpdir(), 'maple-folder-test-'));
  libraryId = insertFolder(live.db, { path: tmpDir, slug: 'testlib' });
  // One read of the folders table populates both halves of the roots cache.
  invalidateLibraryRoots();
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** One indexed asset at `(dir, filename)` in the test library. */
function seedIndexed(
  dir: string,
  filename: string,
  over: { exif?: unknown; mapleId?: string; libraryId?: string } = {},
): string {
  const assetId = insertAsset(live.db, {
    exif: over.exif === undefined ? null : JSON.stringify(over.exif),
  });
  if (over.mapleId !== undefined) {
    run(live.db, `UPDATE assets SET maple_id = ? WHERE id = ?`, over.mapleId, assetId);
  }
  insertLocation(live.db, {
    assetId,
    libraryId: over.libraryId ?? libraryId,
    path: dir,
    filename,
  });
  return assetId;
}

describe('GET /folder/:slug/*', () => {
  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/folder/no-such-slug/'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/slug/i);
  });

  test('matches the library root WITHOUT a trailing slash (regression: no SPA fallback)', async () => {
    // The web client requests `/api/folder/<slug>` (NO trailing slash) for the
    // library root. `/folder/:slug/*` alone does NOT match that, so the request
    // fell through to the SPA static handler and returned index.html (the live
    // "Http failure during parsing" bug). The root route must match it.
    const res = await app.handle(new Request('http://localhost/folder/testlib'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = (await res.json()) as { address: string };
    expect(body.address).toBe('testlib:');
  });

  test('returns empty listing for a root with no files or subdirs', async () => {
    const subDir = path.join(tmpDir, `empty-${Date.now()}`);
    await mkdir(subDir, { recursive: true });
    // A slug the folders table does not carry — stubbed straight into the
    // cache, which is what `setLibraryBySlugForTests` exists for.
    setLibraryBySlugForTests('emptylib', {
      libraryId: new ObjectId(),
      root: subDir,
      label: 'Empty',
    });

    const res = await app.handle(new Request('http://localhost/folder/emptylib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      parent: null;
      folders: unknown[];
      images: unknown[];
    };
    expect(body.address).toBe('emptylib:');
    expect(body.parent).toBeNull();
    expect(body.folders).toEqual([]);
    expect(body.images).toEqual([]);
  });

  test('returns indexed images from catalog', async () => {
    const mapleId = new ObjectId().toHexString();

    seedIndexed('', 'shot.dng', {
      mapleId,
      exif: { width: 3000, height: 2000, captured_at: '2026-06-01T12:00:00Z' },
    });

    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      images: Array<{
        name: string;
        address: string;
        mapleId: string | null;
        indexed: boolean;
        width?: number;
        height?: number;
        capturedAt?: string;
      }>;
    };
    const img = body.images.find((i) => i.name === 'shot.dng');
    expect(img).toBeDefined();
    expect(img!.indexed).toBe(true);
    expect(img!.mapleId).toBe(mapleId);
    expect(img!.width).toBe(3000);
    expect(img!.address).toBe('testlib:shot.dng');
  });

  test('on-disk unindexed files appear with indexed:false', async () => {
    // Write a file to disk that is not in the catalog
    await writeFile(path.join(tmpDir, 'new-file.jpg'), 'fake-jpeg');

    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      images: Array<{ name: string; indexed: boolean; mapleId: null }>;
    };
    const unindexed = body.images.find((i) => i.name === 'new-file.jpg');
    expect(unindexed).toBeDefined();
    expect(unindexed!.indexed).toBe(false);
    expect(unindexed!.mapleId).toBeNull();
  });

  test('Server-Timing header is present', async () => {
    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.headers.get('Server-Timing')).toMatch(/^total;dur=\d+$/);
  });

  test('lists subdirectories', async () => {
    const sub = path.join(tmpDir, 'sub-album');
    await mkdir(sub, { recursive: true });
    const res = await app.handle(new Request('http://localhost/folder/testlib/'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: Array<{ name: string; address: string }> };
    const found = body.folders.find((f) => f.name === 'sub-album');
    expect(found).toBeDefined();
    expect(found!.address).toBe('testlib:sub-album');
  });

  test('does NOT leak a deduplicated asset whose (library,path) live in different fileinfo entries', async () => {
    // Regression: a loose `{'fileinfo.library_id': id, 'fileinfo.path': relPath}`
    // query cross-matches when library_id and path come from DIFFERENT entries.
    // This asset has the test library at folderB and a *different* library at
    // folderA — querying folderA must NOT surface its folderB filename.
    await mkdir(path.join(tmpDir, 'folderA'), { recursive: true });
    await mkdir(path.join(tmpDir, 'folderB'), { recursive: true });
    const otherLibrary = insertFolder(live.db, { path: '/srv/other', slug: 'otherlib' });
    const assetId = seedIndexed('folderB', 'b.jpg', {
      mapleId: new ObjectId().toHexString(),
    });
    insertLocation(live.db, {
      assetId,
      libraryId: otherLibrary,
      ordinal: 1,
      path: 'folderA',
      filename: 'a.jpg',
    });

    const res = await app.handle(new Request('http://localhost/folder/testlib/folderA'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ name: string }> };
    expect(body.images.find((i) => i.name === 'b.jpg')).toBeUndefined();
    expect(body.images.find((i) => i.name === 'a.jpg')).toBeUndefined();
    expect(body.images).toEqual([]);
  });

  test('percent-decodes the wildcard so folders/files with spaces resolve', async () => {
    // Regression: Elysia does not decode path params; without explicit
    // decoding, `My%20Album` never matches the on-disk dir or the catalog path.
    await mkdir(path.join(tmpDir, 'My Album'), { recursive: true });
    seedIndexed('My Album', 'x.jpg', { mapleId: new ObjectId().toHexString() });

    const res = await app.handle(new Request('http://localhost/folder/testlib/My%20Album'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      images: Array<{ name: string; address: string }>;
    };
    expect(body.address).toBe('testlib:My Album');
    const img = body.images.find((i) => i.name === 'x.jpg');
    expect(img).toBeDefined();
    expect(img!.address).toBe('testlib:My Album/x.jpg');
  });
});
