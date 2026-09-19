// preview-ondemand-limiter.test.ts (route-level)
//
// Integration coverage for #2012: `GET /api/preview/:slug/*` must route a
// cache-miss regeneration through `previewOndemandLimiter()` so a burst of
// near-simultaneous requests (e.g. opening a large folder in Browse right
// after the #2006 AVIF/path-key migration) never runs more than the
// configured cap's worth of decode+encode jobs concurrently.
//
// The catalogue behind the route runs against SQLite (#3787): a private
// in-memory database per test, installed as the process-wide handle. The route
// only serves a burst at all when every requested file resolves to an indexed
// asset with a `maple_id`, so the seed is what makes the concurrency assertion
// meaningful rather than a row of 404s.
//
// `generatePreview` is faked with a slow, concurrency-tracking implementation
// so this never touches maple/libraw — via `spyOn` on the previewer module
// namespace, NOT `mock.module`. #2032: the previous `mock.module`-based fake
// leaked out of this file on CI's (linux) test-file collection order — the
// `afterAll` restore did not repoint `workers/stages/preview.ts`'s
// already-captured `generatePreview` binding in Bun's shared module registry,
// so the preview STAGE tests later in the run invoked THIS file's fake, which
// wrote literal `generated-<n>` text bytes as their "preview" and made
// the decoder's `.metadata()` call fail with "unsupported image format" (deterministically
// red on CI, green on macOS where collection order differs). `spyOn` patches
// the one export in place and `mockRestore()` reverts it for every importer.
// Kept in its own file so the fake's lifetime stays trivially scoped to this
// file's beforeAll/afterAll.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import {
  previewOndemandLimiter,
  _resetPreviewOndemandLimiterForTests,
} from '../../indexer/preview-ondemand-limiter.ts';
import { registerLibrary, seedRouteAsset } from '../../../tests/helpers/assets-route-fixtures.ts';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let tmpDir = '';
let libraryId = '';

let activeGenerations = 0;
let peakConcurrent = 0;
let completedCount = 0;

const previewerModule = await import('../../indexer/previewer.ts');

/** Simulated decode+AVIF-encode: tracks concurrency, writes a dummy file so
 * the route's subsequent read succeeds, never touches maple/libraw. */
async function fakeGeneratePreview(_absPath: string, previewPath?: string): Promise<void> {
  if (!previewPath) throw new Error('Expected an explicit preview output path');
  activeGenerations++;
  peakConcurrent = Math.max(peakConcurrent, activeGenerations);
  await new Promise((r) => setTimeout(r, 25));
  await mkdir(join(previewPath, '..'), { recursive: true });
  await writeFile(previewPath, `generated-${completedCount}`);
  activeGenerations--;
  completedCount++;
}

// Patch the one export in place — every importer (including `previewRoutes`'s
// own `generatePreview` binding) calls through the namespace slot, and
// `mockRestore()` in `afterAll` reverts it for every importer. See the module
// doc for why this must NOT be `mock.module` (#2032 leak). Installed inside
// `beforeAll`, not at top-level module evaluation: a top-level install would
// patch the shared namespace as a side effect of this file merely being
// COLLECTED, before any hook lifecycle applies — the same
// order-dependent-leak class this change exists to eliminate.
let generatePreviewSpy: { mockRestore(): void } | null = null;

beforeAll(() => {
  generatePreviewSpy = spyOn(previewerModule, 'generatePreview').mockImplementation(
    fakeGeneratePreview,
  );
});

afterAll(() => {
  generatePreviewSpy?.mockRestore(); // restore for sibling test files — see module doc
  generatePreviewSpy = null;
});

const { previewRoutes } = await import('./preview.ts');
const { Elysia } = await import('elysia');
const app = new Elysia().use(previewRoutes);

beforeEach(async () => {
  live = await createLiveTestDatabase();
  tmpDir = await realpath(await mkdtemp(join(tmpdir(), 'maple-preview-ondemand-')));
  // `resolveAddress` (slug → root) AND `cachePathForAsset` (library_id → root,
  // used to resolve where the on-demand miss should write) both resolve via the
  // SAME `folders`-backed cache, so one row populates both.
  libraryId = registerLibrary(live.db, tmpDir, 'ondemandlib');
  activeGenerations = 0;
  peakConcurrent = 0;
  completedCount = 0;
  _resetPreviewOndemandLimiterForTests();
});

afterEach(async () => {
  invalidateLibraryRoots();
  live.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('GET /preview/:slug/* — on-demand regeneration is concurrency-bounded (#2012)', () => {
  it('never runs more concurrent regenerations than the configured cap, across a burst of cache-miss requests', async () => {
    previewOndemandLimiter().setLimit(3);

    const FILE_COUNT = 9;
    const filenames = Array.from({ length: FILE_COUNT }, (_, i) => `burst-${i}.jpg`);
    for (const filename of filenames) {
      seedRouteAsset(live.db, { libraryId, path: '', filename, mapleId: newObjectIdHex() });
    }
    await Promise.all(filenames.map((f) => writeFile(join(tmpDir, f), 'source-bytes')));

    // Fire every request near-simultaneously — a synchronized burst, exactly
    // the migration scenario #2012 is guarding against.
    const responses = await Promise.all(
      filenames.map((f) => app.handle(new Request(`http://localhost/preview/ondemandlib/${f}`))),
    );

    for (const res of responses) expect(res.status).toBe(200);
    expect(completedCount).toBe(FILE_COUNT);
    expect(peakConcurrent).toBeLessThanOrEqual(3);
    // Sanity: real overlap happened, not accidental full serialization.
    expect(peakConcurrent).toBeGreaterThan(1);
  });

  it('does not gate a warm cache read through the limiter (no generation call at all)', async () => {
    previewOndemandLimiter().setLimit(1);
    seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'warm.jpg',
      mapleId: newObjectIdHex(),
    });
    await writeFile(join(tmpDir, 'warm.jpg'), 'source-bytes');
    const previewPath = join(tmpDir, '.maple', 'previews', 'warm.jpg.avif');
    await mkdir(join(previewPath, '..'), { recursive: true });
    await writeFile(previewPath, 'already-cached-bytes');

    const res = await app.handle(new Request('http://localhost/preview/ondemandlib/warm.jpg'));
    expect(res.status).toBe(200);
    expect(completedCount).toBe(0); // generatePreview never invoked — file already present
  });
});
