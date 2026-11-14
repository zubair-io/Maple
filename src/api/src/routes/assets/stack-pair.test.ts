/**
 * Route wiring for moving a RAW+JPEG stack as one unit (#5929): `companion_id`
 * / `companion_collision` on relocate and rename, `companion_ids` on batch
 * rename, and the fields the responses add. The relocate guarantee itself is
 * covered in `library/raw-jpeg-stack-relocate.test.ts`. Real SQLite, real files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateRoutes } from './relocate.ts';
import { renameRoutes } from './rename.ts';
import { batchRenameRoutes } from './batch-rename.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

// Rename validates names and batch rename renders them with the native engine,
// which the API CI job does not build (see `batch-rename.test.ts`).
const maybeTest = tryGetRawFfi() !== null ? test : test.skip;

const app = new Elysia({ prefix: '/api/assets' })
  .use(fakeAuth())
  .use(relocateRoutes)
  .use(renameRoutes)
  .use(batchRenameRoutes);

async function post(urlPath: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/assets${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

let live: LiveTestDatabase;
let root: string;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stack-pair-route-')));
  libraryId = insertFolder(live.db, { path: root, slug: 'stack-pair-route' });
  invalidateLibraryRoots();
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  await fs.rm(root, { recursive: true, force: true });
});

const exists = (rel: string) =>
  fs.lstat(path.join(root, rel)).then(
    () => true,
    () => false,
  );

async function indexed(rel: string): Promise<string> {
  await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), `bytes of ${rel}`);
  const id = insertAsset(live.db);
  insertLocation(live.db, {
    assetId: id,
    libraryId,
    path: path.posix.dirname(rel),
    filename: path.posix.basename(rel),
  });
  return id;
}

async function seedStack(): Promise<{ raw: string; jpeg: string }> {
  const stack = { raw: await indexed('a/IMG_1.CR3'), jpeg: await indexed('a/IMG_1.JPG') };
  await fs.writeFile(path.join(root, 'a/IMG_1.xmp'), 'the stack edits');
  return stack;
}

describe('POST /api/assets/:id/relocate with companion_id', () => {
  test('moves the pair and reports where the JPEG landed', async () => {
    const stack = await seedStack();

    const res = await post(`/${stack.raw}/relocate`, {
      mode: 'move',
      collision: 'skip',
      destination_path: 'b',
      companion_id: stack.jpeg,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      new_path: 'b',
      new_filename: 'IMG_1.CR3',
      companion: {
        new_abs_path: path.join(root, 'b/IMG_1.JPG'),
        new_path: 'b',
        new_filename: 'IMG_1.JPG',
      },
    });
    expect(await exists('b/IMG_1.xmp')).toBe(true);
  });

  test('names the JPEG when its name is taken and moves nothing', async () => {
    const stack = await seedStack();
    await fs.mkdir(path.join(root, 'b'));
    await fs.writeFile(path.join(root, 'b/IMG_1.JPG'), 'unindexed');

    const res = await post(`/${stack.raw}/relocate`, {
      mode: 'move',
      collision: 'replace',
      destination_path: 'b',
      companion_id: stack.jpeg,
      companion_collision: 'skip',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: true,
      reason: 'collision',
      collision_filename: 'IMG_1.JPG',
    });
    expect(await exists('a/IMG_1.CR3')).toBe(true);
  });

  test('answers 404 naming the companion when the JPEG is not beside the RAW', async () => {
    const stack = await seedStack();
    const elsewhere = await indexed('c/IMG_1.JPG');

    const res = await post(`/${stack.raw}/relocate`, {
      mode: 'move',
      collision: 'skip',
      destination_path: 'b',
      companion_id: elsewhere,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Companion not found beside the asset',
      missing: 'companion',
    });
  });

  test('rejects a malformed companion_id or the RAW naming itself', async () => {
    const stack = await seedStack();
    for (const companion_id of ['nope', stack.raw]) {
      const res = await post(`/${stack.raw}/relocate`, {
        mode: 'move',
        collision: 'skip',
        destination_path: 'b',
        companion_id,
      });
      expect(res.status).toBe(400);
    }
    expect(await exists('a/IMG_1.CR3')).toBe(true);
  });
});

describe('POST /api/assets/:id/rename with companion_id', () => {
  maybeTest('renames the pair to one stem', async () => {
    const stack = await seedStack();

    const res = await post(`/${stack.raw}/rename`, {
      new_filename: 'Trip.CR3',
      collision: 'skip',
      companion_id: stack.jpeg,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      new_filename: 'Trip.CR3',
      companion: { new_filename: 'Trip.JPG' },
    });
    expect(await exists('a/Trip.xmp')).toBe(true);
  });
});

describe('POST /api/assets/batch-rename with companion_ids', () => {
  test('rejects companion_ids that are not parallel to ids', async () => {
    const stack = await seedStack();

    const res = await post('/batch-rename', {
      ids: [stack.raw],
      template: '{original}_x.{ext}',
      collision: 'skip',
      companion_ids: [stack.jpeg, null],
    });

    expect(res.status).toBe(400);
  });

  maybeTest('renames each stack as a pair and skips one whose JPEG name is taken', async () => {
    const first = await seedStack();
    const second = {
      raw: await indexed('a/IMG_2.CR3'),
      jpeg: await indexed('a/IMG_2.JPG'),
    };
    await fs.writeFile(path.join(root, 'a/IMG_2_x.JPG'), 'unindexed');

    const res = await post('/batch-rename', {
      ids: [first.raw, second.raw],
      template: '{original}_x.{ext}',
      collision: 'replace',
      companion_ids: [first.jpeg, second.jpeg],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, unknown>[] };
    expect(body.results[0]).toMatchObject({
      kind: 'relocated',
      new_filename: 'IMG_1_x.CR3',
      companion_new_filename: 'IMG_1_x.JPG',
    });
    expect(body.results[1]).toMatchObject({ kind: 'skipped', collision_filename: 'IMG_2_x.JPG' });
    expect(await exists('a/IMG_1_x.xmp')).toBe(true);
    expect(await exists('a/IMG_2.CR3')).toBe(true);
  });
});
