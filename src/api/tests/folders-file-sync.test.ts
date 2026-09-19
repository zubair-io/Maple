/**
 * The File Provider's "sync every file type" surface: files that are not
 * still images have no asset row, so the client reaches them by
 * library-relative path through `/api/folders/:id/file` and `/file-meta`.
 *
 * Real files in a tmp directory, real SQLite installed as the process-wide
 * handle for the file (#3787).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Elysia } from 'elysia';
import { fakeAuth } from './helpers/test-auth.ts';
import { listDirContents } from '../src/fs/browse.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-file-sync-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let folderId: string;

async function get(suffix: string): Promise<Response> {
  const { foldersRoutes } = await import('../src/routes/folders.ts');
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
  return app.handle(new Request(`http://localhost/api/folders/${folderId}${suffix}`));
}

describe('FileProvider: sync all file types', () => {
  beforeAll(async () => {
    // A mix of non-image regular files, an extensionless file, and a subdir.
    await fs.writeFile(path.join(ROOT, 'notes.txt'), 'hello');
    await fs.writeFile(path.join(ROOT, 'clip.mov'), 'fakevideo');
    await fs.writeFile(path.join(ROOT, 'README'), 'readme-bytes');
    await fs.mkdir(path.join(ROOT, 'sub'));

    live = await createLiveTestDatabase();
    folderId = insertFolder(live.db, { path: ROOT, slug: 'file-sync-test' });
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  test('listDirContents surfaces video files in `images` and other non-image files in `files`', async () => {
    const res = await listDirContents(ROOT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { data } = res;
    if (!data) throw new Error('Expected directory response data');

    expect(data.sidecars).toHaveLength(0);
    expect(data.dirs.map((d) => d.name)).toContain('sub');

    // clip.mov is a video — surfaces in images with isVideo=true.
    const videoEntry = data.images.find((i) => i.name === 'clip.mov');
    expect(videoEntry).toBeDefined();
    expect(videoEntry?.isVideo).toBe(true);
    expect(videoEntry?.ext).toBe('mov');

    // Non-video, non-image files land in files.
    const byName = new Map(data.files.map((f) => [f.name, f]));
    expect([...byName.keys()].sort()).toEqual(['README', 'notes.txt']);
    expect(byName.get('notes.txt')!.ext).toBe('txt');
    expect(byName.get('README')!.ext).toBe('');
    for (const f of data.files) {
      expect(typeof f.path).toBe('string');
      expect(f.path.startsWith(ROOT)).toBe(true);
      expect(typeof f.size).toBe('number');
      expect(f.size).toBeGreaterThan(0);
      expect(typeof f.mtime).toBe('string');
    }
  });

  test('GET /:id/file streams the raw bytes of a non-indexed file', async () => {
    const res = await get(`/file?path=${encodeURIComponent('notes.txt')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  test('GET /:id/file-meta returns stat without bytes', async () => {
    const res = await get(`/file-meta?path=${encodeURIComponent('clip.mov')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; size: number; ext: string; mtime: string };
    expect(body.name).toBe('clip.mov');
    expect(body.ext).toBe('mov');
    expect(body.size).toBe('fakevideo'.length);
    expect(typeof body.mtime).toBe('string');
  });

  test('GET /:id/file rejects a path-escape attempt', async () => {
    const res = await get(`/file?path=${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(400);
  });

  test('GET /:id/file 404s for a missing file', async () => {
    const res = await get(`/file?path=${encodeURIComponent('nope.bin')}`);
    expect(res.status).toBe(404);
  });
});
