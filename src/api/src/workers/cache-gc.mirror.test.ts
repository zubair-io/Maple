/**
 * cache-gc delete propagation to the mirror (#926).
 *
 * Once the `.maple/` cache replicates, reclaiming an orphan on the primary must
 * reclaim it on the mirror too — otherwise the backup accumulates dead files
 * forever. cache-gc gets that for free by unlinking through `fs/mirrored.ts`;
 * this asserts it end-to-end against a real sweep, and asserts the converse:
 * a LIVE cache entry is left alone on both sides.
 *
 * Runs against a per-test SQLite database installed as the process-wide handle,
 * so the sweep resolves its library and live set the way production does.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

// Both registries are process-wide, so neither may survive into the next test.
afterEach(() => {
  clearMirrorRoots();
  invalidateLibraryRoots();
});

/** Register `root` as a library so the sweep can resolve a library id (without
 * one it scans but never deletes). */
function registerLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

function insertLiveAsset(db: Database, libraryId: string, filename: string): void {
  insertLocation(db, { assetId: insertAsset(db), libraryId, path: '', filename });
}

/** Age past the sweep's 60s recency-skip window. */
async function writeAged(p: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, bytes);
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

describe('cache-gc → mirror', () => {
  test('an orphan reclaimed on the primary is reclaimed on the mirror', async () => {
    using live = await createLiveTestDatabase();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-mirror-'));
    const primary = path.join(dir, 'primary');
    const mirror = path.join(dir, 'mirror');
    await mkdir(primary, { recursive: true });
    await mkdir(mirror, { recursive: true });

    try {
      const libraryId = registerLibrary(live.db, primary);
      insertLiveAsset(live.db, libraryId, 'live.dng');

      const { sha256Prefix16 } = await import('../fs/xmp.ts');
      const liveRel = path.join('.maple', 'thumbs', `${sha256Prefix16('live.dng')}.avif`);
      const orphanRel = path.join('.maple', 'thumbs', `${'0'.repeat(16)}.avif`);

      for (const rel of [liveRel, orphanRel]) {
        await writeAged(path.join(primary, rel), 'avif-bytes');
        await writeAged(path.join(mirror, rel), 'avif-bytes');
      }

      setMirrorRoots({ [primary]: [mirror] });

      const { sweepOrphanedCaches } = await import('./cache-gc.ts');
      const result = await sweepOrphanedCaches(primary);
      const { flushPendingMirrorOps } = await import('../fs/mirrored.ts');
      await flushPendingMirrorOps();

      expect(result.deleted).toBe(1);
      // Orphan gone on BOTH sides — the mirror doesn't accumulate dead files.
      await expect(stat(path.join(primary, orphanRel))).rejects.toThrow();
      await expect(stat(path.join(mirror, orphanRel))).rejects.toThrow();
      // The live entry survives on both sides — a delete-propagation bug that
      // over-reached would show up right here.
      expect((await stat(path.join(primary, liveRel))).size).toBeGreaterThan(0);
      expect((await stat(path.join(mirror, liveRel))).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
