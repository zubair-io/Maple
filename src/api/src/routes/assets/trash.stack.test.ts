/**
 * Route-integration tests: a RAW+JPEG stack trashed under one trash stem
 * (#5930) with `DELETE /api/assets/:rawId?intent=trash&companion=<jpegId>`,
 * and restored to its own names by the ordinary per-asset restore.
 *
 * Real temp dirs, no fs mocks, and one real SQLite database per test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import * as fs from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { trashRoutes } from './trash.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import {
  assetRow,
  locationRows,
  registerLibrary,
} from '../../../tests/helpers/assets-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertLocation,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

describe('a RAW+JPEG stack in the Trash #5930', () => {
  let live: LiveTestDatabase;
  let libraryId: string;
  let root: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    root = await fs.realpath(await fs.mkdtemp(nodePath.join(tmpdir(), 'trash-stack-route-')));
    libraryId = registerLibrary(live.db, root, 'trash-stack-route-test');
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    invalidateLibraryRoots();
    live.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const at = (rel: string) => nodePath.join(root, rel);
  const read = (rel: string) => fs.readFile(at(rel), 'utf8');
  const exists = (rel: string) =>
    fs.lstat(at(rel)).then(
      () => true,
      () => false,
    );

  async function put(rel: string, bytes = `bytes of ${rel}`): Promise<void> {
    await fs.mkdir(nodePath.dirname(at(rel)), { recursive: true });
    await fs.writeFile(at(rel), bytes);
  }

  async function indexed(rel: string): Promise<string> {
    await put(rel);
    const id = insertAsset(live.db);
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: nodePath.posix.dirname(rel),
      filename: nodePath.posix.basename(rel),
    });
    return id;
  }

  async function seedStack(): Promise<{ raw: string; jpeg: string }> {
    const stack = { raw: await indexed('Trip/IMG_1.CR3'), jpeg: await indexed('Trip/IMG_1.JPG') };
    await put('Trip/IMG_1.xmp', 'the stack edits');
    return stack;
  }

  function app() {
    return new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  }

  function trash(id: string, query: string): Promise<Response> {
    return app().handle(
      new Request(`http://localhost/api/assets/${id}?${query}`, { method: 'DELETE' }),
    );
  }

  function restore(id: string): Promise<Response> {
    return app().handle(
      new Request(`http://localhost/api/assets/${id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
  }

  function locationOf(id: string): string {
    const [row] = locationRows(live.db, id);
    return `${row!.path}/${row!.filename}`;
  }

  it('trashes the RAW, the JPEG and their sidecar under one stem free for all three', async () => {
    const stack = await seedStack();
    await put('.maple/trash/Trip/IMG_1.CR3', 'an older trashed photo');

    const res = await trash(stack.raw, `intent=trash&companion=${stack.jpeg}`);

    expect(res.status).toBe(204);
    expect(await read('.maple/trash/Trip/IMG_1.1.CR3')).toBe('bytes of Trip/IMG_1.CR3');
    expect(await read('.maple/trash/Trip/IMG_1.1.JPG')).toBe('bytes of Trip/IMG_1.JPG');
    expect(await read('.maple/trash/Trip/IMG_1.1.xmp')).toBe('the stack edits');
    expect(await exists('.maple/trash/Trip/IMG_1.JPG')).toBe(false);
    expect(await exists('.maple/trash/Trip/IMG_1.xmp')).toBe(false);
    expect(await read('.maple/trash/Trip/IMG_1.CR3')).toBe('an older trashed photo');
    for (const name of ['IMG_1.CR3', 'IMG_1.JPG', 'IMG_1.xmp']) {
      expect(await exists(`Trip/${name}`)).toBe(false);
    }
    expect(assetRow(live.db, stack.raw)!.deleted_at).not.toBeNull();
    expect(assetRow(live.db, stack.jpeg)!.deleted_at).not.toBeNull();
    expect(assetRow(live.db, stack.jpeg)!.original_path).toBe(at('Trip/IMG_1.JPG'));
    expect(locationOf(stack.jpeg)).toBe('.maple/trash/Trip/IMG_1.1.JPG');
  });

  it('leaves both live when the JPEG cannot follow', async () => {
    const stack = await seedStack();
    await fs.unlink(at('Trip/IMG_1.JPG'));

    const res = await trash(stack.raw, `intent=trash&companion=${stack.jpeg}`);

    expect(res.status).toBe(500);
    expect(await read('Trip/IMG_1.CR3')).toBe('bytes of Trip/IMG_1.CR3');
    expect(await read('Trip/IMG_1.xmp')).toBe('the stack edits');
    expect(await exists('.maple/trash/Trip/IMG_1.CR3')).toBe(false);
    expect(assetRow(live.db, stack.raw)!.deleted_at).toBeNull();
    expect(assetRow(live.db, stack.jpeg)!.deleted_at).toBeNull();
    expect(locationOf(stack.raw)).toBe('Trip/IMG_1.CR3');
  });

  it('answers 404 and trashes nothing when the companion is not beside the RAW', async () => {
    const stack = await seedStack();
    const elsewhere = await indexed('Other/IMG_1.JPG');

    const res = await trash(stack.raw, `intent=trash&companion=${elsewhere}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Companion not found beside the asset',
      missing: 'companion',
    });
    expect(assetRow(live.db, stack.raw)!.deleted_at).toBeNull();
    expect(await exists('Trip/IMG_1.CR3')).toBe(true);
  });

  it('refuses a companion on a purge or naming the RAW itself', async () => {
    const stack = await seedStack();

    expect((await trash(stack.raw, `intent=purge&companion=${stack.jpeg}`)).status).toBe(400);
    expect((await trash(stack.raw, `intent=trash&companion=${stack.raw}`)).status).toBe(400);
    expect((await trash(stack.raw, 'intent=trash&companion=nope')).status).toBe(400);
    expect(assetRow(live.db, stack.raw)!.deleted_at).toBeNull();
  });

  for (const order of [
    ['raw', 'jpeg'],
    ['jpeg', 'raw'],
  ] as const) {
    it(`restoring the ${order[0]} then the ${order[1]} brings the stack back under its own names`, async () => {
      const stack = await seedStack();
      expect((await trash(stack.raw, `intent=trash&companion=${stack.jpeg}`)).status).toBe(204);

      for (const half of order) expect((await restore(stack[half])).status).toBe(200);

      expect(await read('Trip/IMG_1.CR3')).toBe('bytes of Trip/IMG_1.CR3');
      expect(await read('Trip/IMG_1.JPG')).toBe('bytes of Trip/IMG_1.JPG');
      expect(await read('Trip/IMG_1.xmp')).toBe('the stack edits');
      expect(await exists('.maple/trash/Trip/IMG_1.xmp')).toBe(false);
      expect(locationOf(stack.raw)).toBe('Trip/IMG_1.CR3');
      expect(locationOf(stack.jpeg)).toBe('Trip/IMG_1.JPG');
    });
  }

  it('a stack trashed half by half still restores under its own names', async () => {
    const stack = await seedStack();
    expect((await trash(stack.raw, 'intent=trash')).status).toBe(204);
    expect((await trash(stack.jpeg, 'intent=trash')).status).toBe(204);

    expect((await restore(stack.raw)).status).toBe(200);
    expect((await restore(stack.jpeg)).status).toBe(200);

    expect(await read('Trip/IMG_1.JPG')).toBe('bytes of Trip/IMG_1.JPG');
    expect(await exists('Trip/IMG_1.restored.JPG')).toBe(false);
    expect(await read('Trip/IMG_1.xmp')).toBe('the stack edits');
  });

  it('a photo restored beside a stem whose sidecar holds other edits still keeps clear of it', async () => {
    const jpeg = await indexed('Trip/IMG_1.JPG');
    await put('Trip/IMG_1.xmp', 'the jpeg edits');
    expect((await trash(jpeg, 'intent=trash')).status).toBe(204);
    await put('Trip/IMG_1.xmp', 'someone else edits');

    expect((await restore(jpeg)).status).toBe(200);

    expect(await read('Trip/IMG_1.restored.JPG')).toBe('bytes of Trip/IMG_1.JPG');
    expect(await read('Trip/IMG_1.restored.xmp')).toBe('the jpeg edits');
    expect(await read('Trip/IMG_1.xmp')).toBe('someone else edits');
  });
});
