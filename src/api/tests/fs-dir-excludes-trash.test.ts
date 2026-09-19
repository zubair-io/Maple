/**
 * A file whose asset is soft-deleted must disappear from `/api/fs/dir`, even
 * when the bytes are somehow still sitting in the directory.
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

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp3-dirx-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;

describe('GET /api/fs/dir excludes trashed assets', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: ROOT, slug: 'dirx-test' });

    const ghost = path.join(ROOT, 'ghost.ARW');
    await fs.writeFile(path.join(ROOT, 'live.ARW'), 'live');
    await fs.writeFile(ghost, 'ghost');

    seedIndexedAsset(live.db, { libraryId, filename: 'live.ARW', size: 4 });
    seedIndexedAsset(live.db, {
      libraryId,
      filename: 'ghost.ARW',
      size: 5,
      deletedAt: new Date().toISOString(),
      originalPath: ghost,
    });

    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  test('if an indexed file is trashed but somehow still on disk, listing omits it', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const authedApp = new Elysia().use(fakeAuth()).use(fsRoutes);
    const res = await authedApp.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(ROOT)}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: Array<{ name: string }> };
    expect(body.images.map((i) => i.name).sort()).toEqual(['live.ARW']);
  });
});
