/**
 * A RAW+JPEG stack moved, renamed or restored through Maple folds again as soon as its second
 * half lands (#5849). Migration 0044's triggers unpair a half the moment its location changes,
 * and clients act on a stack as two per-asset calls, so the folder is re-paired after each
 * commit rather than at the discover sweep's next visit. Real files, real SQLite.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { reconcileRawJpegStacks } from '../db/repos/assets.raw-jpeg-stacks.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { restoreAssetById, trashAssetById } from './asset-trash.ts';
import { relocateAsset } from './relocate-asset.ts';

let live: LiveTestDatabase;
let root: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stack-moves-')));
  libraryId = insertFolder(live.db, { path: root, slug: 'stack-moves' });
  invalidateLibraryRoots();
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** A RAW and a JPEG in `dir`, on disk and in the catalog, paired as the sweep pairs them. */
async function seedPair(dir: string): Promise<{ raw: ObjectId; jpeg: ObjectId }> {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  const seed = async (filename: string) => {
    await fs.writeFile(path.join(root, dir, filename), `bytes of ${filename}`);
    const id = insertAsset(live.db);
    insertLocation(live.db, { assetId: id, libraryId, path: dir, filename });
    return new ObjectId(id);
  };
  const pair = { raw: await seed('IMG_1.CR3'), jpeg: await seed('IMG_1.JPG') };
  await reconcileRawJpegStacks(new ObjectId(libraryId), dir);
  expect(stackPrimaryOf(pair.jpeg)).toBe(pair.raw.toHexString());
  return pair;
}

function stackPrimaryOf(id: ObjectId): string | null {
  const row = live.db
    .query('SELECT stack_primary_id FROM assets WHERE id = ?')
    .get(id.toHexString()) as { stack_primary_id: string | null };
  return row.stack_primary_id;
}

describe('RAW+JPEG stacks across in-app file operations #5849', () => {
  test('a stack moved half by half is paired again at its destination', async () => {
    const { raw, jpeg } = await seedPair('a');

    const moveRaw = await relocateAsset({
      id: raw,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });
    expect(moveRaw.kind).toBe('relocated');
    expect(stackPrimaryOf(jpeg)).toBeNull();

    const moveJpeg = await relocateAsset({
      id: jpeg,
      mode: 'move',
      collision: 'skip',
      destinationPath: 'b',
    });
    expect(moveJpeg.kind).toBe('relocated');
    expect(stackPrimaryOf(jpeg)).toBe(raw.toHexString());
  });

  test('a stack renamed half by half is paired again under its new stem', async () => {
    const { raw, jpeg } = await seedPair('a');

    for (const [id, filename] of [
      [raw, 'IMG_9.CR3'],
      [jpeg, 'IMG_9.JPG'],
    ] as const) {
      const renamed = await relocateAsset({
        id,
        mode: 'move',
        collision: 'skip',
        destinationFilename: filename,
      });
      expect(renamed.kind).toBe('relocated');
    }

    expect(stackPrimaryOf(jpeg)).toBe(raw.toHexString());
  });

  test('a stack trashed and restored half by half is paired again', async () => {
    const { raw, jpeg } = await seedPair('a');

    expect((await trashAssetById(raw)).kind).toBe('ok');
    expect((await trashAssetById(jpeg)).kind).toBe('ok');
    expect(stackPrimaryOf(jpeg)).toBeNull();

    expect((await restoreAssetById(raw)).kind).toBe('ok');
    expect((await restoreAssetById(jpeg)).kind).toBe('ok');
    expect(stackPrimaryOf(jpeg)).toBe(raw.toHexString());
  });
});
