/**
 * Issue #6 of PR #66 review: paged `/api/fs/dir` responses must pair sidecars
 * to their indexed image even when the image and the sidecar land on different
 * pages of the slice.
 *
 * Setup: N images + N paired sidecars in one directory. At `limit=1` every
 * sidecar lands on a page whose `images[]` is empty, so a per-slice
 * `imageBaseToAsset` map would drop it — only the global, whole-directory map
 * resolves it.
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

// Small N so `limit=1` — the only page size that separates every pair — does
// not turn into hundreds of requests.
const N = 20;

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp-paging-sidecars-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let assetIdsByBase: Map<string, string>;

describe('GET /api/fs/dir — paged sidecar pairing across page boundaries', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: ROOT, slug: 'paging-test' });

    assetIdsByBase = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      const base = `IMG_${String(i).padStart(4, '0')}`;
      const rawName = `${base}.ARW`;
      await fs.writeFile(path.join(ROOT, rawName), new Uint8Array([0xff, 0xd8, 0xff]));
      await fs.writeFile(path.join(ROOT, `${base}.xmp`), '<x:xmpmeta/>');
      assetIdsByBase.set(base, seedIndexedAsset(live.db, { libraryId, filename: rawName }));
    }

    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('every sidecar across paged responses resolves its asset_id', async () => {
    const { fsRoutes } = await import('../src/routes/fs.ts');
    const authedApp = new Elysia().use(fakeAuth()).use(fsRoutes);

    // localeCompare interleaves names: IMG_0000.ARW < IMG_0000.xmp <
    // IMG_0001.ARW < … so any limit ≥ 2 keeps each RAW/sidecar pair on the same
    // page and the per-slice map alone would resolve them — defeating the test.
    const seen = new Map<string, string>(); // sidecar name → asset_id
    let cursor: string | undefined = undefined;
    let pageCount = 0;
    const maxPages = N * 2 + 5;
    do {
      const qs = new URLSearchParams({ path: ROOT, limit: '1' });
      if (cursor) qs.set('cursor', cursor);
      const res = await authedApp.handle(new Request(`http://localhost/api/fs/dir?${qs}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        images: Array<{ name: string }>;
        sidecars: Array<{ name: string; asset_id: string }>;
        next_cursor?: string;
      };
      // Critical structural assertion: a sidecar-only page must still resolve
      // its sidecar. Pre-fix, `images.length === 0` ⇒ empty map ⇒ sidecar
      // dropped, so `seen.size` would stay 0.
      for (const s of body.sidecars) seen.set(s.name, s.asset_id);
      cursor = body.next_cursor;
      pageCount++;
      if (pageCount > maxPages) throw new Error("paging didn't terminate");
    } while (cursor);

    // 2N pages total — N image-only and N sidecar-only — which is what proves
    // pagination really did split every pair.
    expect(pageCount).toBe(2 * N);
    expect(seen.size).toBe(N);
    for (let i = 0; i < N; i++) {
      const base = `IMG_${String(i).padStart(4, '0')}`;
      const expected = assetIdsByBase.get(base);
      expect(expected).toBeDefined();
      expect(seen.get(`${base}.xmp`)).toBe(expected!);
    }
  });
});
