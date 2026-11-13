/**
 * Integration tests for POST /api/assets/batch-rename(/preview) (#2636).
 *
 * Route-level wiring on top of `library/batch-rename.test.ts`'s
 * already-thorough coverage of the sequential-apply/preview semantics —
 * this file checks the HTTP surface: body validation, status/shape
 * mapping, and one end-to-end pass to prove the route is actually wired to
 * the library functions.
 *
 * End-to-end runs against a real SQLite database (#3787) installed as the
 * process-wide handle, plus real temp-dir files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { batchRenameRoutes } from './batch-rename.ts';
import {
  setLibraryBySlugForTests,
  setLibraryRootsForTests,
} from '../../indexer/libraries.cache.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { newObjectIdHex, ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

// The two "end to end" tests below need a real rendered filename, which
// requires the native `raw-core` engine — unavailable in this repo's CI
// (`.github/workflows/api.yml` never builds `libraw_ffi`). Skip-gated the
// same way `library/batch-rename.test.ts` gates its render-dependent
// suites; see that file's module doc for the full rationale.
const ffiAvailable = tryGetRawFfi() !== null;
const maybeTest = ffiAvailable ? test : test.skip;

const app = new Elysia({ prefix: '/api/assets' }).use(fakeAuth()).use(batchRenameRoutes);

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

beforeEach(async () => {
  live = await createLiveTestDatabase();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-rename-route-'));
});

afterEach(async () => {
  live.close();
  await fs.rm(root, { recursive: true, force: true });
  setLibraryRootsForTests(null);
});

describe('POST /api/assets/batch-rename — wiring', () => {
  test('returns 4xx for an empty ids array', async () => {
    const res = await post('/batch-rename', {
      ids: [],
      template: '{original}.{ext}',
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 400 for a malformed id in the list', async () => {
    const res = await post('/batch-rename', {
      ids: [newObjectIdHex(), 'not-an-object-id'],
      template: '{original}.{ext}',
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(400);
  });

  test('returns 4xx for an invalid collision policy', async () => {
    const res = await post('/batch-rename', {
      ids: [newObjectIdHex()],
      template: '{original}.{ext}',
      collision: 'yolo',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('returns 4xx for a missing template', async () => {
    const res = await post('/batch-rename', {
      ids: [newObjectIdHex()],
      collision: 'auto-suffix',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe('POST /api/assets/batch-rename/preview — wiring', () => {
  test('rejects source addresses that do not match the ids array length', async () => {
    const res = await post('/batch-rename/preview', {
      ids: [newObjectIdHex(), newObjectIdHex()],
      source_addresses: ['batch-rename-route-test:a/one.jpg'],
      template: '{original}.{ext}',
    });
    expect(res.status).toBe(400);
  });

  test('does not require a collision policy', async () => {
    const res = await post('/batch-rename/preview', {
      ids: [newObjectIdHex()],
      template: '{original}.{ext}',
    });
    // Not-found item, but the request shape itself is valid — 200 with a
    // per-item error, not a 4xx.
    expect(res.status).toBe(200);
  });

  test('returns 400 for a malformed id in the list', async () => {
    const res = await post('/batch-rename/preview', {
      ids: ['not-an-object-id'],
      template: '{original}.{ext}',
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — real catalogue + real temp-dir files.
// ---------------------------------------------------------------------------

async function seedAssets(db: Database, names: string[]): Promise<string[]> {
  const libraryId = insertFolder(db, { path: root, slug: 'batch-rename-route-test' });
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const ids: string[] = [];
  for (const filename of names) {
    await fs.writeFile(path.join(root, 'a', filename), 'pixels');
    const id = insertAsset(db);
    insertLocation(db, { assetId: id, libraryId, path: 'a', filename });
    run(db, `UPDATE assets SET size = 6, mtime = 1700000000000 WHERE id = ?`, id);
    ids.push(id);
  }
  setLibraryRootsForTests(new Map([[libraryId, root]]));
  setLibraryBySlugForTests('batch-rename-route-test', {
    libraryId: new ObjectId(libraryId),
    root,
    label: 'Test library',
  });
  return ids;
}

describe('POST /api/assets/batch-rename — end to end', () => {
  maybeTest(
    'rejects an address belonging to another asset without moving either file',
    async () => {
      const [firstId] = await seedAssets(live.db, ['first.jpg', 'second.jpg']);
      const res = await post('/batch-rename', {
        ids: [firstId],
        source_addresses: ['batch-rename-route-test:a/second.jpg'],
        template: 'renamed.jpg',
        collision: 'skip',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).summary.failed).toBe(1);
      expect(await fs.readFile(path.join(root, 'a', 'first.jpg'), 'utf8')).toBe('pixels');
      expect(await fs.readFile(path.join(root, 'a', 'second.jpg'), 'utf8')).toBe('pixels');
    },
  );

  maybeTest(
    'renames two selected locations of one asset without touching its canonical copy',
    async () => {
      const [id] = await seedAssets(live.db, ['canonical.jpg']);
      const libraryId = live.db
        .query("SELECT id FROM folders WHERE slug = 'batch-rename-route-test'")
        .get() as { id: string };
      for (const [index, filename] of ['first.jpg', 'second.jpg'].entries()) {
        await fs.writeFile(path.join(root, 'a', filename), 'pixels');
        await fs.writeFile(path.join(root, 'a', filename.replace('.jpg', '.xmp')), filename);
        insertLocation(live.db, {
          assetId: id!,
          libraryId: libraryId.id,
          ordinal: index + 1,
          path: 'a',
          filename,
        });
      }

      const request = {
        ids: [id, id],
        source_addresses: [
          'batch-rename-route-test:a/first.jpg',
          'batch-rename-route-test:a/second.jpg',
        ],
        template: 'renamed_{n}.{ext}',
        sequence_start: 1,
        collision: 'skip',
      };
      const preview = await post('/batch-rename/preview', request);
      expect(preview.status).toBe(200);
      expect(
        (await preview.json()).items.map((item: { old_filename: string; new_filename: string }) => [
          item.old_filename,
          item.new_filename,
        ]),
      ).toEqual([
        ['first.jpg', 'renamed_1.jpg'],
        ['second.jpg', 'renamed_2.jpg'],
      ]);

      const applied = await post('/batch-rename', request);
      expect(applied.status).toBe(200);
      expect((await applied.json()).summary).toEqual({
        total: 2,
        relocated: 2,
        skipped: 0,
        failed: 0,
      });
      expect(await fs.readFile(path.join(root, 'a', 'canonical.jpg'), 'utf8')).toBe('pixels');
      expect(await fs.readFile(path.join(root, 'a', 'renamed_1.xmp'), 'utf8')).toBe('first.jpg');
      expect(await fs.readFile(path.join(root, 'a', 'renamed_2.xmp'), 'utf8')).toBe('second.jpg');
      await expect(fs.readFile(path.join(root, 'a', 'first.jpg'))).rejects.toThrow();
      await expect(fs.readFile(path.join(root, 'a', 'second.jpg'))).rejects.toThrow();
    },
  );

  maybeTest('rejects ambiguous ID-only batch items without moving files', async () => {
    const [id] = await seedAssets(live.db, ['canonical.jpg']);
    const libraryId = live.db
      .query("SELECT id FROM folders WHERE slug = 'batch-rename-route-test'")
      .get() as { id: string };
    await fs.writeFile(path.join(root, 'a', 'other.jpg'), 'pixels');
    insertLocation(live.db, {
      assetId: id!,
      libraryId: libraryId.id,
      ordinal: 1,
      path: 'a',
      filename: 'other.jpg',
    });

    const res = await post('/batch-rename', {
      ids: [id],
      template: 'renamed.jpg',
      collision: 'skip',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).summary.failed).toBe(1);
    expect(await fs.readFile(path.join(root, 'a', 'canonical.jpg'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(root, 'a', 'other.jpg'), 'utf8')).toBe('pixels');
  });

  maybeTest('applies the template sequentially and returns a summary', async () => {
    const ids = await seedAssets(live.db, ['IMG_1.dng', 'IMG_2.dng']);

    const res = await post('/batch-rename', {
      ids,
      template: '{original}_{n}.{ext}',
      sequence_start: 1,
      sequence_pad_width: 2,
      collision: 'auto-suffix',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ total: 2, relocated: 2, skipped: 0, failed: 0 });
    expect(body.results[0]).toMatchObject({ kind: 'relocated', new_filename: 'IMG_1_01.dng' });
    expect(body.results[1]).toMatchObject({ kind: 'relocated', new_filename: 'IMG_2_02.dng' });

    expect(await fs.readFile(path.join(root, 'a', 'IMG_1_01.dng'), 'utf8')).toBe('pixels');
  });
});

describe('POST /api/assets/batch-rename/preview — end to end', () => {
  maybeTest('renders names without applying anything', async () => {
    const ids = await seedAssets(live.db, ['IMG_1.dng']);

    const res = await post('/batch-rename/preview', {
      ids,
      template: '{original}_preview.{ext}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({
      old_filename: 'IMG_1.dng',
      new_filename: 'IMG_1_preview.dng',
      duplicate: false,
    });

    // Unmoved.
    expect(await fs.readFile(path.join(root, 'a', 'IMG_1.dng'), 'utf8')).toBe('pixels');
  });
});
