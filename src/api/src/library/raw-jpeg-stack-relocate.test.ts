/**
 * A RAW+JPEG stack relocated as one unit (#5929): RAW, JPEG and their shared
 * sidecar land together under one stem and both rows repoint together, and a
 * JPEG that cannot follow puts back everything the RAW's Replace displaced.
 * Real files, real SQLite.
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
import { relocateFile, sidecarRenameTarget } from '../fs/relocate.ts';
import { relocateAsset, type RelocateAssetInput } from './relocate-asset.ts';

let live: LiveTestDatabase;
let root: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stack-relocate-')));
  libraryId = insertFolder(live.db, { path: root, slug: 'stack-relocate' });
  invalidateLibraryRoots();
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});

const at = (rel: string) => path.join(root, rel);
const read = (rel: string) => fs.readFile(at(rel), 'utf8');
const exists = (rel: string) =>
  fs.lstat(at(rel)).then(
    () => true,
    () => false,
  );

async function put(rel: string, bytes = `bytes of ${rel}`): Promise<void> {
  await fs.mkdir(path.dirname(at(rel)), { recursive: true });
  await fs.writeFile(at(rel), bytes);
}

async function indexed(rel: string): Promise<ObjectId> {
  await put(rel);
  const id = insertAsset(live.db);
  const dir = path.posix.dirname(rel);
  insertLocation(live.db, {
    assetId: id,
    libraryId,
    path: dir === '.' ? '' : dir,
    filename: path.posix.basename(rel),
  });
  return new ObjectId(id);
}

/** `a/IMG_1.CR3` + `a/IMG_1.JPG` + their shared `a/IMG_1.xmp`, paired. */
async function seedStack(): Promise<{ raw: ObjectId; jpeg: ObjectId }> {
  const pair = { raw: await indexed('a/IMG_1.CR3'), jpeg: await indexed('a/IMG_1.JPG') };
  await put('a/IMG_1.xmp', 'the stack edits');
  await reconcileRawJpegStacks(new ObjectId(libraryId), 'a');
  return pair;
}

function locationOf(id: ObjectId): string {
  const row = live.db
    .query('SELECT path, filename FROM asset_locations WHERE asset_id = ?')
    .get(id.toHexString()) as { path: string; filename: string };
  return `${row.path}/${row.filename}`;
}

function stackPrimaryOf(id: ObjectId): string | null {
  const row = live.db
    .query('SELECT stack_primary_id FROM assets WHERE id = ?')
    .get(id.toHexString()) as { stack_primary_id: string | null };
  return row.stack_primary_id;
}

function moveStack(
  stack: { raw: ObjectId; jpeg: ObjectId },
  overrides: Partial<RelocateAssetInput> & { companionCollision?: 'skip' | 'replace' },
) {
  const { companionCollision = 'skip', ...input } = overrides;
  return relocateAsset({
    id: stack.raw,
    mode: 'move',
    collision: 'skip',
    destinationPath: 'b',
    stackCompanion: { id: stack.jpeg, collision: companionCollision },
    ...input,
  });
}

async function expectStackUntouched(stack: { raw: ObjectId; jpeg: ObjectId }): Promise<void> {
  expect(await read('a/IMG_1.CR3')).toBe('bytes of a/IMG_1.CR3');
  expect(await read('a/IMG_1.JPG')).toBe('bytes of a/IMG_1.JPG');
  expect(await read('a/IMG_1.xmp')).toBe('the stack edits');
  expect(locationOf(stack.raw)).toBe('a/IMG_1.CR3');
  expect(locationOf(stack.jpeg)).toBe('a/IMG_1.JPG');
}

describe('a RAW+JPEG stack relocated as one unit #5929', () => {
  test('a move carries the JPEG and the sidecar, repoints both rows and re-pairs them', async () => {
    const stack = await seedStack();

    const moved = await moveStack(stack, {});

    expect(moved).toMatchObject({
      kind: 'relocated',
      newPath: 'b',
      newFilename: 'IMG_1.CR3',
      companion: { id: stack.jpeg, newPath: 'b', newFilename: 'IMG_1.JPG' },
    });
    expect(await read('b/IMG_1.JPG')).toBe('bytes of a/IMG_1.JPG');
    expect(await read('b/IMG_1.xmp')).toBe('the stack edits');
    expect(await exists('a/IMG_1.CR3')).toBe(false);
    expect(await exists('a/IMG_1.JPG')).toBe(false);
    expect(await exists('a/IMG_1.xmp')).toBe(false);
    expect(locationOf(stack.raw)).toBe('b/IMG_1.CR3');
    expect(locationOf(stack.jpeg)).toBe('b/IMG_1.JPG');
    expect(stackPrimaryOf(stack.jpeg)).toBe(stack.raw.toHexString());
  });

  test('a rename gives the JPEG and the sidecar the new stem', async () => {
    const stack = await seedStack();

    const renamed = await moveStack(stack, {
      destinationPath: 'a',
      destinationFilename: 'Trip.CR3',
    });

    expect(renamed).toMatchObject({ kind: 'relocated', companion: { newFilename: 'Trip.JPG' } });
    expect(await read('a/Trip.JPG')).toBe('bytes of a/IMG_1.JPG');
    expect(await read('a/Trip.xmp')).toBe('the stack edits');
    expect(locationOf(stack.jpeg)).toBe('a/Trip.JPG');
  });

  test('Replace on both names replaces both occupants and lands the pair', async () => {
    const stack = await seedStack();
    await put('b/IMG_1.CR3', 'unindexed raw');
    await put('b/IMG_1.JPG', 'unindexed jpeg');

    const moved = await moveStack(stack, { collision: 'replace', companionCollision: 'replace' });

    expect(moved.kind).toBe('relocated');
    expect(await read('b/IMG_1.CR3')).toBe('bytes of a/IMG_1.CR3');
    expect(await read('b/IMG_1.JPG')).toBe('bytes of a/IMG_1.JPG');
    expect(await read('b/IMG_1.xmp')).toBe('the stack edits');
  });

  test('Keep Both picks one stem free for the RAW, the JPEG and the sidecar', async () => {
    const stack = await seedStack();
    await put('b/IMG_1.JPG', 'unindexed jpeg');

    const moved = await moveStack(stack, { collision: 'keep-both' });

    expect(moved).toMatchObject({
      kind: 'relocated',
      newFilename: 'IMG_1.1.CR3',
      renamedOnCollision: true,
      companion: { newFilename: 'IMG_1.1.JPG' },
    });
    expect(await read('b/IMG_1.1.xmp')).toBe('the stack edits');
    expect(await read('b/IMG_1.JPG')).toBe('unindexed jpeg');
  });

  test("a taken JPEG name skips the pair under the RAW's Replace, naming the JPEG", async () => {
    const stack = await seedStack();
    await put('b/IMG_1.CR3', 'unindexed raw');
    await put('b/IMG_1.JPG', 'unindexed jpeg');

    const moved = await moveStack(stack, { collision: 'replace' });

    expect(moved).toEqual({ kind: 'skipped', reason: 'collision', collisionFilename: 'IMG_1.JPG' });
    expect(await read('b/IMG_1.CR3')).toBe('unindexed raw');
    expect(await read('b/IMG_1.JPG')).toBe('unindexed jpeg');
    await expectStackUntouched(stack);
  });

  test("an indexed JPEG-name occupant refuses the pair before the RAW's Replace displaces anything", async () => {
    const stack = await seedStack();
    await put('b/IMG_1.CR3', 'unindexed raw');
    const occupant = await indexed('b/IMG_1.JPG');

    const moved = await moveStack(stack, { collision: 'replace', companionCollision: 'replace' });

    expect(moved).toEqual({
      kind: 'occupied',
      occupiedByAssetId: occupant.toHexString(),
      occupiedFilename: 'IMG_1.JPG',
    });
    expect(await read('b/IMG_1.CR3')).toBe('unindexed raw');
    await expectStackUntouched(stack);
  });

  test("a JPEG gone from disk puts back the unindexed file the RAW's Replace displaced", async () => {
    const stack = await seedStack();
    await put('b/IMG_1.CR3', 'unindexed raw');
    await fs.unlink(at('a/IMG_1.JPG'));

    const moved = await moveStack(stack, { collision: 'replace' });

    expect(moved.kind).toBe('error');
    expect(await read('b/IMG_1.CR3')).toBe('unindexed raw');
    expect(await read('a/IMG_1.CR3')).toBe('bytes of a/IMG_1.CR3');
    expect(await read('a/IMG_1.xmp')).toBe('the stack edits');
    expect(await exists('b/IMG_1.JPG')).toBe(false);
    expect(locationOf(stack.raw)).toBe('a/IMG_1.CR3');
    expect(locationOf(stack.jpeg)).toBe('a/IMG_1.JPG');
  });

  test('a JPEG that is not beside the RAW moves nothing', async () => {
    const stack = await seedStack();
    const elsewhere = await indexed('c/IMG_1.JPG');

    const moved = await moveStack({ raw: stack.raw, jpeg: elsewhere }, { collision: 'replace' });

    expect(moved).toEqual({ kind: 'companion-missing' });
    await expectStackUntouched(stack);
  });

  test("a JPEG name another writer takes mid-move puts back what the RAW's Replace displaced", async () => {
    await seedStack();
    await put('b/IMG_1.CR3', 'unindexed raw');

    const outcome = await relocateFile({
      sourceAbsPath: at('a/IMG_1.CR3'),
      destAbsPath: at('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'replace',
      stackCompanion: { sourceAbsPath: at('a/IMG_1.JPG'), replace: false },
      onDestinationPrepared: () => put('b/IMG_1.JPG', 'another writer'),
    });

    expect(outcome).toEqual({
      kind: 'skipped',
      reason: 'collision',
      collidedAt: at('b/IMG_1.JPG'),
    });
    expect(await read('b/IMG_1.CR3')).toBe('unindexed raw');
    expect(await read('b/IMG_1.JPG')).toBe('another writer');
    expect(await read('a/IMG_1.CR3')).toBe('bytes of a/IMG_1.CR3');
    expect(await read('a/IMG_1.JPG')).toBe('bytes of a/IMG_1.JPG');
    expect(await exists('b/IMG_1.xmp')).toBe(false);
  });

  const maple = (label: string) =>
    `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;
  const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';

  test("carries the JPEG's pre-migration backup sidecar on move and rename, even when a sibling keeps the stem", async () => {
    const stack = await seedStack();
    await put('a/IMG_1.JPG.xmp', maple('jpeg backup edit'));
    await put('a/IMG_1.HEIC', 'staying sibling');

    const moved = await moveStack(stack, {});

    expect(moved.kind).toBe('relocated');
    expect(await read('b/IMG_1.JPG.xmp')).toBe(maple('jpeg backup edit'));
    expect(await exists('a/IMG_1.JPG.xmp')).toBe(false);
    expect(await read('a/IMG_1.xmp')).toBe('the stack edits');

    const renamed = await moveStack(stack, {
      destinationPath: 'b',
      destinationFilename: 'Trip.CR3',
    });

    expect(renamed.kind).toBe('relocated');
    expect(await read('b/Trip.JPG.xmp')).toBe(maple('jpeg backup edit'));
    expect(await exists('b/IMG_1.JPG.xmp')).toBe(false);
  });

  test('a taken or stranded JPEG old-name sidecar slot skips under Skip and suffixes under Keep Both', async () => {
    const stack = await seedStack();
    await put('a/IMG_1.JPG.xmp', maple('jpeg backup edit'));
    await put('b/IMG_1.JPG.xmp', darktable);

    const skipped = await moveStack(stack, { collision: 'replace', companionCollision: 'skip' });

    expect(skipped).toEqual({
      kind: 'skipped',
      reason: 'collision',
      collisionFilename: 'IMG_1.JPG',
    });
    expect(await read('a/IMG_1.JPG.xmp')).toBe(maple('jpeg backup edit'));

    const suffixed = await moveStack(stack, { collision: 'keep-both' });

    expect(suffixed).toMatchObject({
      kind: 'relocated',
      newFilename: 'IMG_1.1.CR3',
      companion: { newFilename: 'IMG_1.1.JPG' },
    });
    expect(await read('b/IMG_1.1.JPG.xmp')).toBe(maple('jpeg backup edit'));
    expect(await read('b/IMG_1.JPG.xmp')).toBe(darktable);
    expect(await exists('a/IMG_1.JPG.xmp')).toBe(false);
  });

  test('Replace on the JPEG retires its displaced old-name edit and restores it on rollback', async () => {
    const stack = await seedStack();
    await put('a/IMG_1.JPG.xmp', maple('incoming jpeg edit'));
    await put('b/IMG_1.CR3', 'unindexed raw');
    await put('b/IMG_1.JPG', 'unindexed jpeg');
    await put('b/IMG_1.JPG.xmp', maple('displaced jpeg edit'));

    const failed = await relocateFile({
      sourceAbsPath: at('a/IMG_1.CR3'),
      destAbsPath: at('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'replace',
      stackCompanion: { sourceAbsPath: at('a/IMG_1.JPG'), replace: true },
      onVerified: () => Promise.reject(new Error('db failed')),
    });

    expect(failed.kind).toBe('error');
    expect(await read('b/IMG_1.JPG')).toBe('unindexed jpeg');
    expect(await read('b/IMG_1.JPG.xmp')).toBe(maple('displaced jpeg edit'));
    expect(await read('a/IMG_1.JPG.xmp')).toBe(maple('incoming jpeg edit'));

    const moved = await moveStack(stack, { collision: 'replace', companionCollision: 'replace' });

    expect(moved.kind).toBe('relocated');
    expect(await read('b/IMG_1.JPG.xmp')).toBe(maple('incoming jpeg edit'));
    expect(await exists('a/IMG_1.JPG.xmp')).toBe(false);
  });

  test("Replace on the JPEG keeps another tool's file at the old-name slot and carries the JPEG's edit as a conflict copy", async () => {
    const stack = await seedStack();
    await put('a/IMG_1.JPG.xmp', maple('incoming jpeg edit'));
    await put('b/IMG_1.JPG', 'unindexed jpeg');
    await put('b/IMG_1.JPG.xmp', darktable);

    const moved = await moveStack(stack, { collision: 'replace', companionCollision: 'replace' });

    expect(moved.kind).toBe('relocated');
    expect(await read('b/IMG_1.JPG.xmp')).toBe(darktable);
    expect(await read('b/IMG_1 (conflict from move).xmp')).toBe(maple('incoming jpeg edit'));
    expect(await exists('a/IMG_1.JPG.xmp')).toBe(false);
    expect(await exists('a/IMG_1.JPG')).toBe(false);
  });

  test('a late JPEG old-name backup edit arriving mid-move follows the stack', async () => {
    await seedStack();

    const outcome = await relocateFile({
      sourceAbsPath: at('a/IMG_1.CR3'),
      destAbsPath: at('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      stackCompanion: { sourceAbsPath: at('a/IMG_1.JPG'), replace: false },
      onVerified: () => put('a/IMG_1.JPG.xmp', maple('late jpeg edit')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('b/IMG_1.JPG.xmp')).toBe(maple('late jpeg edit'));
    expect(await exists('a/IMG_1.JPG.xmp')).toBe(false);
    expect(await exists('a/IMG_1.JPG')).toBe(false);
  });

  test("carries a sidecar whose stem uses the JPEG's NFD spelling when the RAW's stem is NFC", async () => {
    const nfcRaw = 'a/caf\u00e9.CR3';
    const nfdJpeg = 'a/cafe\u0301.JPG';
    const nfdSidecar = 'a/cafe\u0301 (conflict from Mac).xmp';
    expect(sidecarRenameTarget(at(nfcRaw), at('b/Trip.CR3'), at(nfdSidecar))).toBe(
      at('b/Trip (conflict from Mac).xmp'),
    );
    const stack = { raw: await indexed(nfcRaw), jpeg: await indexed(nfdJpeg) };
    await put(nfdSidecar, 'nfd conflict edit');
    await reconcileRawJpegStacks(new ObjectId(libraryId), 'a');

    const moved = await moveStack(stack, { destinationFilename: 'Trip.CR3' });

    expect(moved.kind).toBe('relocated');
    expect(await read('b/Trip (conflict from Mac).xmp')).toBe('nfd conflict edit');
    expect(await exists(nfdSidecar)).toBe(false);
  });
});
