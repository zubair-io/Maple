/** Filesystem Browse regressions now exercise the registered-library route (#4008). */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from '../src/fs/mirrored.ts';
import { folderRoutes } from '../src/routes/library/folder.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { fakeAuth } from './helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  insertAsset,
  insertLocation,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let root: string;
let indexedId: string;
const app = new Elysia({ prefix: '/api' }).use(fakeAuth()).use(folderRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-unified-cutover-')));
  const libraryId = insertFolder(live.db, { path: root, slug: 'photos' });
  const assetId = insertAsset(live.db, {});
  indexedId = assetId;
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'IMG_001.CR3' });
  invalidateLibraryRoots();
  for (const directory of ['Trip1', '.hidden']) await mkdir(join(root, directory));
  for (const name of ['IMG_001.CR3', 'IMG_002.dng', 'preview.jpg', 'notes.txt', '.env']) {
    await writeFile(join(root, name), 'original');
  }
  await writeFile(join(root, 'IMG_001.xmp'), '<x:xmpmeta/>');
});
afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await rm(root, { recursive: true, force: true });
});
function get(tail = '', query = '') {
  return app.handle(new Request(`http://localhost/api/folder/photos${tail}${query}`));
}
interface Listing {
  path: string;
  parentPath: string | null;
  folders: { name: string }[];
  images: { name: string; id?: string }[];
  sidecars: { name: string; asset_id: string }[];
  files: { name: string }[];
}

describe('unified filesystem Browse cutover', () => {
  it('lists registered subdirectories, indexed and unindexed photos and ordinary files', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body: Listing = await response.json();
    expect(body.path).toBe(root);
    expect(body.parentPath).toBeNull();
    expect(body.folders.map((entry) => entry.name)).toEqual(['Trip1']);
    expect(body.images.map((entry) => entry.name).sort()).toEqual([
      'IMG_001.CR3',
      'IMG_002.dng',
      'preview.jpg',
    ]);
    expect(body.files.map((entry) => entry.name)).toEqual(['notes.txt']);
  });
  it('pairs actual XMP sidecars rather than classifying them as images', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body: Listing = await response.json();
    expect(body.images.map((entry) => entry.name)).not.toContain('IMG_001.xmp');
    expect(body.sidecars.map((entry) => entry.name)).toEqual(['IMG_001.xmp']);
    expect(body.sidecars[0]?.asset_id).toBe(indexedId);
    expect(body.images.find((entry) => entry.name === 'IMG_001.CR3')?.id).toBe(indexedId);
  });
  it('rejects an original symlink escaping the registered root', async () => {
    const external = await realpath(await mkdtemp(join(tmpdir(), 'maple-outside-cutover-')));
    try {
      await symlink(external, join(root, 'outside'));
      const response = await get('/outside');
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('library jail');
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
  it('rejects traversal supplied as a relative path segment', async () => {
    const response = await get('/%2E%2E%2Foutside');
    expect(response.status).toBe(400);
  });
  it('rejects a non-integer page limit', async () => {
    const response = await get('', '?limit=abc');
    expect(response.status).toBe(400);
  });
});
