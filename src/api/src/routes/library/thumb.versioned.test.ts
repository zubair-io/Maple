import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import { folderRoutes } from './folder.ts';
import { thumbRoutes } from './thumb.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

interface Listing {
  images: { name: string; thumbVersion?: string }[];
}

let live: LiveTestDatabase;
let root: string;
let library: string;
const app = new Elysia().use(fakeAuth()).use(folderRoutes).use(thumbRoutes);

const past = new Date('2026-01-01T00:00:00Z');
const later = new Date('2026-02-01T00:00:00Z');

async function photoWithThumb(name: string, thumbTime = later): Promise<string> {
  const source = join(root, name);
  await fs.writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await fs.utimes(source, past, past);
  const thumbFile = resolveThumbPath(source);
  await fs.mkdir(dirname(thumbFile), { recursive: true });
  await fs.writeFile(thumbFile, Buffer.from([1, 2, 3, 4, 5]));
  await fs.utimes(thumbFile, thumbTime, thumbTime);
  return source;
}

async function versions(): Promise<Map<string, string | undefined>> {
  const response = await app.handle(new Request('http://localhost/folder/photos'));
  expect(response.status).toBe(200);
  const body = (await response.json()) as Listing;
  return new Map(body.images.map((image) => [image.name, image.thumbVersion]));
}

function thumb(name: string, version?: string): Promise<Response> {
  const query = version === undefined ? '' : `?v=${encodeURIComponent(version)}`;
  return app.handle(new Request(`http://localhost/thumb/photos/${name}${query}`));
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-thumb-version-')));
  library = insertFolder(live.db, { path: root, slug: 'photos' });
  invalidateLibraryRoots();
});
afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('versioned thumbnail URLs #6016', () => {
  it('lists a version the route then serves as immutable', async () => {
    await photoWithThumb('a.jpg');
    const version = (await versions()).get('a.jpg');
    expect(version).toBeString();

    const versioned = await thumb('a.jpg', version);
    expect(versioned.status).toBe(200);
    expect(versioned.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(versioned.headers.get('X-Maple-Thumb-Version')).toBe(version!);

    const plain = await thumb('a.jpg');
    expect(plain.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(plain.headers.get('X-Maple-Thumb-Version')).toBe(version!);
  });

  it('a stale version keeps revalidating', async () => {
    await photoWithThumb('a.jpg');
    const response = await thumb('a.jpg', 'not-the-current-version');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
  });

  it('a re-rendered thumb gets a new version', async () => {
    const source = await photoWithThumb('a.jpg');
    const before = (await versions()).get('a.jpg');
    const rerender = new Date('2026-03-01T00:00:00Z');
    await fs.writeFile(resolveThumbPath(source), Buffer.from([9, 9, 9, 9, 9, 9]));
    await fs.utimes(resolveThumbPath(source), rerender, rerender);
    const after = (await versions()).get('a.jpg');
    expect(after).toBeString();
    expect(after).not.toBe(before);
  });

  it('offers no version for a thumb older than its sidecar', async () => {
    const source = await photoWithThumb('a.jpg');
    const sidecar = source.replace(/\.jpg$/, '.xmp');
    await fs.writeFile(sidecar, '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    const edited = new Date('2026-03-01T00:00:00Z');
    await fs.utimes(sidecar, edited, edited);
    expect((await versions()).get('a.jpg')).toBeUndefined();
  });

  it('offers no version for a thumb older than its original', async () => {
    await photoWithThumb('a.jpg', new Date('2025-01-01T00:00:00Z'));
    expect((await versions()).get('a.jpg')).toBeUndefined();
  });

  it('offers no version where the thumb is rendered at another location', async () => {
    await photoWithThumb('copy.jpg');
    const id = insertAsset(live.db, {});
    run(live.db, `UPDATE assets SET maple_id = 'm-1' WHERE id = ?`, id);
    insertLocation(live.db, {
      assetId: id,
      libraryId: library,
      path: 'elsewhere',
      filename: 'x.jpg',
    });
    insertLocation(live.db, {
      assetId: id,
      libraryId: library,
      path: '',
      filename: 'copy.jpg',
      ordinal: 1,
    });
    expect((await versions()).get('copy.jpg')).toBeUndefined();
  });

  it('versions an indexed photo whose primary location is this folder', async () => {
    await photoWithThumb('primary.jpg');
    const id = insertAsset(live.db, {});
    run(live.db, `UPDATE assets SET maple_id = 'm-2' WHERE id = ?`, id);
    insertLocation(live.db, { assetId: id, libraryId: library, path: '', filename: 'primary.jpg' });
    expect((await versions()).get('primary.jpg')).toBeString();
  });
});
