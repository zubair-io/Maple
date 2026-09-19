/**
 * `/api/fs/dir` attaches the asset id (24-char hex) to each image entry whose
 * resolved absolute path matches an indexed asset. The client uses this id to
 * call `/api/assets/:id` for the enriched detail payload — without it, FS-walk
 * assets never resolve to a catalog id and the detail panel's enrichment
 * sections stay empty.
 *
 * Real files in a tmp directory, real SQLite installed as the process-wide
 * handle for the file (#3787).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Elysia } from 'elysia';
import { fakeAuth } from './helpers/test-auth.ts';
import { seedIndexedAsset } from './helpers/fs-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';

// The jail root has to be known before `withTestEnv` registers its hook, and a
// `beforeAll` runs too late for that — so the directory is minted here.
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fsdir-link-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let indexedAssetId: string;

describe('GET /api/fs/dir — asset id link', () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(ROOT, 'indexed.dng'), 'raw');
    await fs.writeFile(path.join(ROOT, 'unindexed.dng'), 'raw');

    live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: ROOT, slug: 'fsdir-link-test' });
    indexedAssetId = seedIndexedAsset(live.db, { libraryId, filename: 'indexed.dng' });

    // The browse listing resolves each asset's absolute path through the
    // library-roots cache, so it has to see the root this suite just seeded.
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('sets `id` (hex) on entries whose abs_path matches an asset row; leaves it unset otherwise', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const authedApp = new Elysia().use(fakeAuth()).use(fsRoutes);
    const res = await authedApp.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(ROOT)}`),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { images: Array<{ name: string; id?: string }> };

    const indexed = json.images.find((i) => i.name === 'indexed.dng');
    const unindexed = json.images.find((i) => i.name === 'unindexed.dng');
    expect(indexed).toBeDefined();
    expect(unindexed).toBeDefined();

    // Indexed file → `id` is the seeded asset's id.
    expect(indexed!.id).toBe(indexedAssetId);

    // Un-indexed file → `id` is absent. The discover-on-browse fire-and-forget
    // may have already enqueued an index job; assert it isn't set in this
    // synchronous response.
    expect(unindexed!.id).toBeUndefined();
  });
});
