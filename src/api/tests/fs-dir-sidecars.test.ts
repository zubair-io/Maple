/**
 * `/api/fs/dir` returns a `sidecars[]` array containing every `.xmp` file whose
 * canonical base (with an optional "(conflict from …)" suffix stripped) pairs
 * to an indexed image in the same directory.
 *
 * Real files in a tmp directory, real SQLite installed as the process-wide
 * handle for the file (#3787). Same pattern as `fs-dir-asset-link.test.ts`.
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

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp2-fsdir-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let assetId: string;

async function listing(): Promise<{
  sidecars: Array<{ name: string; asset_id: string }>;
}> {
  const { fsRoutes } = await import('../src/routes/fs.ts');
  const authedApp = new Elysia().use(fakeAuth()).use(fsRoutes);
  const res = await authedApp.handle(
    new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(ROOT)}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { sidecars: Array<{ name: string; asset_id: string }> };
}

describe('GET /api/fs/dir — sidecars[] pairing', () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(ROOT, 'IMG_1.ARW'), new Uint8Array([0xff, 0xd8, 0xff]));
    for (const name of [
      'IMG_1.xmp',
      'IMG_1 (conflict from MacBook).xmp',
      'IMG_1 (conflict from MacBook) (2).xmp',
      // Orphan — no image of this base in the directory.
      'DSCF0001.xmp',
    ]) {
      await fs.writeFile(path.join(ROOT, name), '<x:xmpmeta/>');
    }

    live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: ROOT, slug: 'fsdir-test' });
    assetId = seedIndexedAsset(live.db, { libraryId, filename: 'IMG_1.ARW' });

    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('pairs canonical + conflict sidecars to the same asset', async () => {
    const body = await listing();
    const names = body.sidecars.map((s) => s.name).sort();
    expect(names).toEqual([
      'IMG_1 (conflict from MacBook) (2).xmp',
      'IMG_1 (conflict from MacBook).xmp',
      'IMG_1.xmp',
    ]);
    for (const s of body.sidecars) {
      expect(s.asset_id).toBe(assetId);
    }
  });

  it('drops orphan sidecars (no paired indexed asset)', async () => {
    const body = await listing();
    expect(body.sidecars.find((s) => s.name === 'DSCF0001.xmp')).toBeUndefined();
  });
});
