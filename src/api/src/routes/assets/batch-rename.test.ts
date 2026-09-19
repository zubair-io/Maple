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
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { tryGetRawFfi } from '../../ffi/raw_ffi.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';
import { newObjectIdHex } from '../../db/object-id.ts';
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
  return ids;
}

describe('POST /api/assets/batch-rename — end to end', () => {
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
