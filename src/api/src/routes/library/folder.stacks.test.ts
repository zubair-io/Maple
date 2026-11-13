/**
 * RAW+JPEG stacks in the folder listing (#5050). Folding is opt-in per request (`stack=1`):
 * the Apple File Provider, Android and other consumers that sync files from this listing send
 * nothing and must keep seeing every JPEG. Real files in a temp library, real SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from '../../fs/mirrored.ts';
import { folderRoutes } from './folder.ts';
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

interface Entry {
  name: string;
  id?: string;
  stack?: { companion: Entry & { address: string; ext: string; size: number } };
}
interface Listing {
  folders: Entry[];
  images: Entry[];
  next_cursor?: string;
}

let live: LiveTestDatabase;
let root: string;
let library: string;
const app = new Elysia().use(fakeAuth()).use(folderRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'maple-stack-folder-')));
  library = insertFolder(live.db, { path: root, slug: 'photos' });
  invalidateLibraryRoots();
});
afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});

function seed(name: string, deletedAt: string | null = null): string {
  const id = insertAsset(live.db, { deletedAt });
  insertLocation(live.db, { assetId: id, libraryId: library, path: '', filename: name });
  return id;
}
async function put(name: string, size = 4): Promise<void> {
  await fs.writeFile(path.join(root, name), 'x'.repeat(size));
}
async function listing(query = '?stack=1'): Promise<Listing> {
  const response = await app.handle(new Request(`http://localhost/folder/photos${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as Listing;
}
const names = (entries: Entry[]) => entries.map((entry) => entry.name);

describe('RAW+JPEG stacks in the folder listing #5050', () => {
  test('stack=1 lists a same-stem RAW and JPEG as one image carrying both files', async () => {
    await put('IMG_1.CR3', 10);
    await put('IMG_1.JPG', 3);
    await put('IMG_2.JPG');
    const raw = seed('IMG_1.CR3');
    const jpeg = seed('IMG_1.JPG');

    const { images } = await listing();

    expect(names(images)).toEqual(['IMG_1.CR3', 'IMG_2.JPG']);
    expect(images[0]?.stack?.companion).toMatchObject({
      name: 'IMG_1.JPG',
      address: 'photos:IMG_1.JPG',
      ext: 'jpg',
      size: 3,
      id: jpeg,
    });
    expect(images[0]?.id).toBe(raw);
    expect(images[1]?.stack).toBeUndefined();
  });

  test('without stack=1 every JPEG is listed, whatever the display setting says', async () => {
    await put('IMG_1.CR3');
    await put('IMG_1.JPG');
    run(
      live.db,
      `INSERT INTO app_settings (id, doc) VALUES ('display', ?)`,
      JSON.stringify({ stack_raw_jpeg: true }),
    );

    for (const query of ['', '?stack=0', '?limit=10']) {
      const { images } = await listing(query);
      expect(names(images)).toEqual(['IMG_1.CR3', 'IMG_1.JPG']);
      expect(images.some((entry) => entry.stack)).toBe(false);
    }
  });

  test('a stack value other than 0 or 1 is refused', async () => {
    const response = await app.handle(new Request('http://localhost/folder/photos?stack=true'));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  test('the stem match ignores case, and a lone JPEG, or an ambiguous group, stays alone', async () => {
    for (const name of ['a.cr3', 'A.JPEG', 'b.CR3', 'b.jpg', 'b.jpeg', 'c.JPG', 'c.HEIC']) {
      await put(name);
    }

    const { images } = await listing();

    expect(names(images)).toEqual(['a.cr3', 'b.CR3', 'b.jpeg', 'b.jpg', 'c.HEIC', 'c.JPG']);
  });

  test('pages count stacks as one, so the folded JPEG never takes a slot', async () => {
    for (const stem of ['a', 'b', 'c']) {
      await put(`${stem}.CR3`);
      await put(`${stem}.JPG`);
    }

    const first = await listing('?stack=1&limit=2');
    expect(names(first.images)).toEqual(['a.CR3', 'b.CR3']);
    const second = await listing(`?stack=1&limit=2&cursor=${first.next_cursor}`);
    expect(names(second.images)).toEqual(['c.CR3']);
    expect(second.next_cursor).toBeUndefined();
  });

  test('a trashed JPEG leaves the RAW unstacked', async () => {
    await put('IMG_1.CR3');
    await put('IMG_1.JPG');
    seed('IMG_1.JPG', new Date().toISOString());

    const { images } = await listing();

    expect(names(images)).toEqual(['IMG_1.CR3']);
    expect(images[0]?.stack).toBeUndefined();
  });

  test('a RAW the listing cannot show does not take its JPEG with it', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'maple-stack-escape-'));
    try {
      await fs.writeFile(path.join(outside, 'IMG_1.CR3'), 'raw');
      await fs.symlink(path.join(outside, 'IMG_1.CR3'), path.join(root, 'IMG_1.CR3'));
      await put('IMG_1.JPG');

      const { images } = await listing();

      expect(names(images)).toEqual(['IMG_1.JPG']);
      expect(images[0]?.stack).toBeUndefined();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a directory named like the JPEG is a folder, not a stack companion', async () => {
    await put('IMG_1.CR3');
    await fs.mkdir(path.join(root, 'IMG_1.JPG'));

    const { folders, images } = await listing();

    expect(names(folders)).toEqual(['IMG_1.JPG']);
    expect(names(images)).toEqual(['IMG_1.CR3']);
    expect(images[0]?.stack).toBeUndefined();
  });

  test('an unindexed JPEG folded into an indexed RAW still queues discover', async () => {
    await put('IMG_1.CR3');
    await put('IMG_1.JPG');
    seed('IMG_1.CR3');

    const { images } = await listing();

    expect(images[0]?.stack?.companion.id).toBeUndefined();
    expect(live.db.query('SELECT COUNT(*) AS n FROM discover_frontier').get()).toEqual({ n: 1 });
  });
});
