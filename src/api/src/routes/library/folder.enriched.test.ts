import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../../fs/mirrored.ts';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { folderRoutes } from './folder.ts';
import { encodeCursor } from '../../fs/browse.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  insertAsset,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { requestContext } from '../../middleware/request-context.ts';
import { securityHeaders } from '../../middleware/security-headers.ts';

interface Entry {
  name: string;
  address: string;
  path: string;
  size: number;
  mtime: string;
  ext: string;
  id?: string;
  asset_id?: string;
  exif?: { camera_make: string };
  isVideo?: boolean;
  isStub?: boolean;
  isAudio?: boolean;
}
interface Listing {
  address: string;
  parent: string | null;
  path: string;
  parentPath: string | null;
  folders: Entry[];
  images: Entry[];
  files: Entry[];
  sidecars: Entry[];
  next_cursor?: string;
}
let live: LiveTestDatabase;
let root: string;
let library: string;
const app = new Elysia().use(fakeAuth()).use(folderRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'maple-enriched-folder-')));
  library = insertFolder(live.db, { path: root, slug: 'photos' });
  invalidateLibraryRoots();
});
afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});
function seed(name: string, directory = '', deletedAt: string | null = null): string {
  const id = insertAsset(live.db, {
    exif: JSON.stringify({ camera_make: 'Hasselblad', width: 100 }),
    deletedAt,
  });
  insertLocation(live.db, { assetId: id, libraryId: library, path: directory, filename: name });
  return id;
}
async function listing(tail = '', query = ''): Promise<Listing> {
  const response = await app.handle(new Request(`http://localhost/folder/photos${tail}${query}`));
  expect(response.status).toBe(200);
  return response.json();
}

describe('unified enriched folder listing #4001', () => {
  test('keeps entry paths under the registered spelling of a symlinked root', async () => {
    const alias = `${root}-alias`;
    try {
      await fs.symlink(root, alias);
      run(live.db, 'UPDATE folders SET path = ? WHERE id = ?', alias, library);
      invalidateLibraryRoots();
      seed('photo.dng');
      await fs.writeFile(path.join(root, 'photo.dng'), 'original bytes');
      await fs.writeFile(path.join(root, 'photo.xmp'), '<x:xmpmeta/>');
      await fs.mkdir(path.join(root, 'album'));
      const body = await listing();
      expect(body.path).toBe(alias);
      expect(body.images[0]?.path).toBe(path.join(alias, 'photo.dng'));
      expect(body.sidecars[0]?.path).toBe(path.join(alias, 'photo.xmp'));
      expect(body.folders[0]?.path).toBe(path.join(alias, 'album'));
    } finally {
      await fs.unlink(alias);
    }
  });
  test('keeps an in-library link address and logical path aligned', async () => {
    await fs.mkdir(path.join(root, 'actual'));
    await fs.symlink(path.join(root, 'actual'), path.join(root, 'alias'));
    const body = await listing();
    expect(body.folders.find((entry) => entry.name === 'alias')).toMatchObject({
      address: 'photos:alias',
      path: path.join(root, 'alias'),
    });
  });
  test('reports actual file metadata and indexed EXIF/identity', async () => {
    const id = seed('frame.dng');
    await fs.writeFile(path.join(root, 'frame.dng'), 'original bytes');
    await fs.utimes(path.join(root, 'frame.dng'), 1700000000, 1700000000);
    const body = await listing();
    expect(body.path).toBe(root);
    expect(body.parent).toBeNull();
    expect(body.parentPath).toBeNull();
    expect(body.images[0]).toMatchObject({
      name: 'frame.dng',
      address: 'photos:frame.dng',
      path: path.join(root, 'frame.dng'),
      size: 14,
      mtime: new Date(1700000000000).toISOString(),
      ext: 'dng',
      id,
      exif: { camera_make: 'Hasselblad', width: 100 },
    });
  });
  test('lists documents, extensionless files and video/stub/audio flags', async () => {
    for (const name of ['notes.txt', 'README', 'clip.MOV', 'sound.wav', 'design.afphoto']) {
      await fs.writeFile(path.join(root, name), name);
    }
    const body = await listing();
    expect(body.files.map((entry) => entry.name)).toEqual(['README', 'notes.txt']);
    expect(body.files.find((entry) => entry.name === 'README')?.ext).toBe('');
    expect(body.images.find((entry) => entry.name === 'clip.MOV')?.isVideo).toBe(true);
    expect(body.images.find((entry) => entry.name === 'sound.wav')?.isAudio).toBe(true);
    expect(body.images.find((entry) => entry.name === 'design.afphoto')?.isStub).toBe(true);
  });
  test('pairs canonical, conflict and full-name video XMP across pages', async () => {
    const photo = seed('photo.dng');
    const video = seed('video.mov');
    for (const name of [
      'photo.dng',
      'photo.xmp',
      'photo (conflict from Mac).xmp',
      'video.mov',
      'video.mov.xmp',
      'orphan.xmp',
    ]) {
      await fs.writeFile(path.join(root, name), name.endsWith('.xmp') ? '<x:xmpmeta/>' : name);
    }
    const entries: Entry[] = [];
    let cursor: string | undefined;
    do {
      const page = await listing('', `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(
        page.images.length + page.folders.length + page.files.length + page.sidecars.length,
      ).toBeLessThanOrEqual(1);
      entries.push(...page.sidecars);
      cursor = page.next_cursor;
    } while (cursor);
    expect(entries.map((entry) => [entry.name, entry.asset_id])).toEqual([
      ['photo (conflict from Mac).xmp', photo],
      ['photo.xmp', photo],
      ['video.mov.xmp', video],
    ]);
  });
  test('paginates the sorted disk/catalog union without duplicates', async () => {
    seed('catalog.dng');
    seed('on-disk.jpg');
    await fs.writeFile(path.join(root, 'on-disk.jpg'), 'jpg');
    await fs.mkdir(path.join(root, 'album'));
    await fs.writeFile(path.join(root, 'z.txt'), 'z');
    const first = await listing('', '?limit=2');
    expect(first.next_cursor).toBeDefined();
    const second = await listing('', `?limit=2&cursor=${first.next_cursor}`);
    expect(second.next_cursor).toBeUndefined();
    const names = [
      ...first.folders,
      ...first.images,
      ...first.files,
      ...second.folders,
      ...second.images,
      ...second.files,
    ].map((entry) => entry.name);
    expect(names).toEqual(['album', 'catalog.dng', 'on-disk.jpg', 'z.txt']);
  });
  test('catalog-only metadata remains available without an on-disk file', async () => {
    seed('missing.dng');
    run(live.db, 'UPDATE assets SET size = 123, mtime = 1700000000000');
    const body = await listing();
    expect(body.images[0]).toMatchObject({
      size: 123,
      mtime: new Date(1700000000000).toISOString(),
      ext: 'dng',
    });
  });
  test('never exposes dotfiles, marker files or trashed images/sidecars', async () => {
    seed('trashed.dng', '', new Date().toISOString());
    for (const name of ['.secret.jpg', 'photo.dng.hidden', 'trashed.dng', 'trashed.xmp']) {
      await fs.writeFile(path.join(root, name), name);
    }
    await fs.mkdir(path.join(root, '.maple'));
    const body = await listing();
    expect(body.images).toEqual([]);
    expect(body.sidecars).toEqual([]);
    expect(body.files).toEqual([]);
    expect(body.folders).toEqual([]);
  });
  test('child symlinks cannot escape into another registered library', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'maple-other-library-'));
    try {
      insertFolder(live.db, { path: outside, slug: 'other' });
      invalidateLibraryRoots();
      await fs.writeFile(path.join(outside, 'secret.jpg'), 'secret');
      await fs.symlink(path.join(outside, 'secret.jpg'), path.join(root, 'escape.jpg'));
      await fs.symlink(outside, path.join(root, 'escape-folder'));
      seed('escape.jpg');
      const body = await listing();
      expect(body.images).toEqual([]);
      expect(body.folders).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  test('valid inside-library links and nested parent addresses remain usable', async () => {
    await fs.mkdir(path.join(root, 'My Album'));
    await fs.writeFile(path.join(root, 'My Album', 'real.jpg'), 'jpeg');
    await fs.symlink(
      path.join(root, 'My Album', 'real.jpg'),
      path.join(root, 'My Album', 'linked.jpg'),
    );
    const body = await listing('/My%20Album');
    expect(body.address).toBe('photos:My Album');
    expect(body.parent).toBe('photos:');
    expect(body.parentPath).toBe(root);
    expect(body.images.map((entry) => entry.name)).toEqual(['linked.jpg', 'real.jpg']);
    expect(body.images[0]?.path).toBe(path.join(root, 'My Album', 'linked.jpg'));
  });
  test('rejects malformed cursor and partially numeric page sizes', async () => {
    for (const query of [
      '?cursor=bad',
      '?cursor=' + encodeCursor(-1),
      '?limit=2bad',
      '?limit=-2',
    ]) {
      const response = await app.handle(new Request(`http://localhost/folder/photos${query}`));
      expect(response.status).toBe(400);
    }
  });
  test('supports conditional refresh and invalidates on original metadata changes', async () => {
    seed('photo.jpg');
    await fs.writeFile(path.join(root, 'photo.jpg'), 'one');
    const first = await app.handle(new Request('http://localhost/folder/photos'));
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const unchanged = await app.handle(
      new Request('http://localhost/folder/photos', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(unchanged.status).toBe(304);
    await fs.writeFile(path.join(root, 'photo.jpg'), 'longer original');
    const changed = await app.handle(
      new Request('http://localhost/folder/photos', {
        headers: { 'If-None-Match': etag! },
      }),
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });
  test('queues real discover work without hashing originals during the request', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'new.jpg'), 'new original');
    await listing('/nested');
    const frontier = live.db
      .query('SELECT folder_id, dir_path, sweep_gen FROM discover_frontier')
      .all();
    expect(frontier).toEqual([{ folder_id: library, dir_path: root, sweep_gen: 1 }]);
    expect(live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 0 });
    await listing('/nested');
    expect(live.db.query('SELECT COUNT(*) AS n FROM discover_frontier').get()).toEqual({ n: 1 });
  });
  test('sidecars cannot expose escaped links or an escaped original identity', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'maple-sidecar-escape-'));
    try {
      seed('good.dng');
      seed('bad.dng');
      await fs.writeFile(path.join(root, 'good.dng'), 'good');
      await fs.writeFile(path.join(outside, 'bad.dng'), 'bad');
      await fs.writeFile(path.join(outside, 'good.xmp'), '<x:xmpmeta/>');
      await fs.symlink(path.join(outside, 'bad.dng'), path.join(root, 'bad.dng'));
      await fs.symlink(path.join(outside, 'good.xmp'), path.join(root, 'good.xmp'));
      await fs.writeFile(path.join(root, 'bad.xmp'), '<x:xmpmeta/>');
      const body = await listing();
      expect(body.images.map((entry) => entry.name)).toEqual(['good.dng']);
      expect(body.sidecars).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  test('enriched identity remains specific to this library and location', async () => {
    const id = seed('photo.dng');
    const other = insertFolder(live.db, { path: path.join(root, 'other'), slug: 'other' });
    const otherAsset = insertAsset(live.db, { exif: JSON.stringify({ camera_make: 'Other' }) });
    insertLocation(live.db, {
      assetId: otherAsset,
      libraryId: other,
      path: '',
      filename: 'photo.dng',
    });
    const body = await listing();
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.id).toBe(id);
    expect(body.images[0]?.exif?.camera_make).toBe('Hasselblad');
  });
  test('honors the active discover generation from the checkpoint', async () => {
    run(
      live.db,
      `INSERT INTO indexer_checkpoints (folder_id, path, sweep_gen, updated_at)
      VALUES (?, ?, 7, 1)`,
      library,
      root,
    );
    await fs.writeFile(path.join(root, 'fresh.jpg'), 'fresh');
    await listing();
    expect(live.db.query('SELECT sweep_gen FROM discover_frontier').get()).toEqual({
      sweep_gen: 7,
    });
  });
  test('empty and past-end pages terminate without returning catalog rows again', async () => {
    seed('last.jpg');
    const body = await listing('', `?limit=1&cursor=${encodeCursor(2)}`);
    expect(body.images).toEqual([]);
    expect(body.next_cursor).toBeUndefined();
  });
  test('rejects traversal on the enriched route', async () => {
    const response = await app.handle(
      new Request('http://localhost/folder/photos/%2e%2e%2foutside?limit=1'),
    );
    expect(response.status).toBe(400);
  });
  test('enriched metadata and 304 survive real HTTP and production middleware', async () => {
    seed('photo.jpg');
    await fs.writeFile(path.join(root, 'photo.jpg'), 'bytes');
    const wrapped = new Elysia()
      .use(requestContext)
      .use(securityHeaders)
      .use(fakeAuth())
      .group('/api', (api) => api.use(folderRoutes));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: wrapped.fetch });
    try {
      const url = new URL('/api/folder/photos?limit=1', server.url);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toBeTruthy();
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      const body = (await response.json()) as Listing;
      expect(body.images[0]?.size).toBe(5);
      const cached = await fetch(url, {
        headers: { 'If-None-Match': response.headers.get('etag')! },
      });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe('');
    } finally {
      await server.stop(true);
    }
  });
  test('preserves the file-access gate', async () => {
    const denied = new Elysia().use(fakeAuth({ file_access: false })).use(folderRoutes);
    const response = await denied.handle(new Request('http://localhost/folder/photos?limit=1'));
    expect(response.status).toBe(403);
  });
});
