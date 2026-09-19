/**
 * `GET /api/folders/:id/trash` — the File Provider's Trash listing: one page of
 * a library's soft-deleted assets, newest-deleted first.
 *
 * Real files in a tmp directory, real SQLite installed as the process-wide
 * handle for the file (#3787).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Elysia } from 'elysia';
import { fakeAuth } from './helpers/test-auth.ts';
import { seedIndexedAsset } from './helpers/fs-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp3-tlist-')));
withTestEnv('MAPLE_ROOTS', ROOT);

interface TrashItem {
  filename: string;
  original_relative_path: string;
  deleted_at: string;
  mtime: string;
}

interface TrashPage {
  items: TrashItem[];
  next_cursor: string | null;
}

let live: LiveTestDatabase;
let folderId: string;

async function trash(qs = ''): Promise<{ status: number; body: TrashPage }> {
  const { foldersRoutes } = await import('../src/routes/folders.ts');
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
  const res = await app.handle(new Request(`http://localhost/api/folders/${folderId}/trash${qs}`));
  return { status: res.status, body: (await res.json()) as TrashPage };
}

describe('GET /api/folders/:id/trash', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    folderId = insertFolder(live.db, { path: ROOT, slug: 'trash-list-test' });
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    // Three trashed assets at different times. The on-disk pointer is the
    // asset's location row — here `.maple/trash` under the library root —
    // while `original_path` retains the absolute path the file was trashed
    // from, because the route still exposes it on the wire shape.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const filename = `T${i}.ARW`;
      const trashed = path.join(ROOT, '.maple', 'trash', filename);
      await fs.mkdir(path.dirname(trashed), { recursive: true });
      await fs.writeFile(trashed, `r${i}`);
      seedIndexedAsset(live.db, {
        libraryId: folderId,
        path: '.maple/trash',
        filename,
        size: 2,
        mtime: now,
        deletedAt: new Date(now - i * 1000).toISOString(),
        originalPath: path.join(ROOT, filename),
      });
    }

    // One vanished (watcher-removed) asset — deleted_at set, original_path
    // absent, and not a reaped row, so Trash must not offer it.
    seedIndexedAsset(live.db, {
      libraryId: folderId,
      filename: 'vanished.ARW',
      size: 0,
      mtime: now,
      deletedAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  test('returns trashed assets newest-first, excludes vanished (no original_path)', async () => {
    const { status, body } = await trash();
    expect(status).toBe(200);
    expect(body.items).toHaveLength(3);
    expect(body.items[0].filename).toBe('T0.ARW');
    expect(body.items[2].filename).toBe('T2.ARW');
    expect(body.items[0].original_relative_path).toBe('T0.ARW');
    // mtime must be emitted as ISO-8601 (not an epoch-ms float) — the Swift
    // Date decoder cannot otherwise consume it.
    expect(typeof body.items[0].mtime).toBe('string');
    expect(body.items[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('400 on non-numeric limit (regression: NaN→500 via .limit())', async () => {
    expect((await trash('?limit=abc')).status).toBe(400);
  });

  test('400 on negative limit', async () => {
    expect((await trash('?limit=-1')).status).toBe(400);
  });

  test('pagination via limit + cursor returns subsequent page', async () => {
    const first = await trash('?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await trash(`?limit=2&cursor=${encodeURIComponent(first.body.next_cursor!)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].filename).toBe('T2.ARW');
    expect(second.body.next_cursor).toBeNull();
  });
});
