/**
 * mirror-scan detector tests. Each drives a real pass against a live test
 * database and two temp directories standing in for a library root and its
 * backup mirror. Covers: enqueue of a missing original AND its canonical
 * sidecar, the `.maple/` cache backlog, the offline-mirror-root skip (no flood),
 * and the up-to-date no-op.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { clearMirrorRoots, setMirrorRoots } from '../../fs/mirror-registry.ts';
import { cachePathFor, resolveThumbPath } from '../../fs/xmp.ts';
import { PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { copyFileToMirror } from './replicate.ts';
import { runMirrorScanOnce } from './scan.ts';

let live: LiveTestDatabase;
let primaryRoot: string;
let mirrorRoot: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  primaryRoot = mkdtempSync(join(tmpdir(), 'mirror-scan-primary-'));
  mirrorRoot = mkdtempSync(join(tmpdir(), 'mirror-scan-mirror-'));
  // Both caches are process-wide and outlive the database they were built from.
  invalidateLibraryRoots();
  clearMirrorRoots();
});

afterEach(() => {
  live.close();
  rmSync(primaryRoot, { recursive: true, force: true });
  rmSync(mirrorRoot, { recursive: true, force: true });
});

/** A live asset for `<primaryRoot>/<filename>`, in its own library. */
function seedAsset(db: Database, filename: string): void {
  const libraryId = insertFolder(db, { path: primaryRoot, slug: `mirror-scan-${Date.now()}` });
  const assetId = insertAsset(db);
  insertLocation(db, { assetId, libraryId, path: '', filename });
  invalidateLibraryRoots();
}

/** Every mirror path the pass enqueued. */
function queuedMirrorPaths(db: Database): string[] {
  return (db.query(`SELECT mirror_path FROM mirror_queue`).all() as { mirror_path: string }[]).map(
    (row) => row.mirror_path,
  );
}

describe('mirror-scan detector', () => {
  it('enqueues a missing original and its canonical sidecar', async () => {
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    writeFileSync(join(primaryRoot, 'IMG.xmp'), '<xmp/>');
    seedAsset(live.db, 'IMG.dng');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });

    const progressPaths: string[] = [];
    const summary = await runMirrorScanOnce({
      onProgress: (p) => progressPaths.push(p.currentPath),
    });

    expect(summary.enqueued).toBe(2);
    // The progress hook fired for the walked original (proves the walk is live).
    expect(progressPaths).toContain(join(primaryRoot, 'IMG.dng'));
    expect(queuedMirrorPaths(live.db).sort()).toEqual(
      [join(mirrorRoot, 'IMG.dng'), join(mirrorRoot, 'IMG.xmp')].sort(),
    );
  });

  it("enqueues the asset's .maple thumb and preview so the cache backlog reaches the mirror", async () => {
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    // Cache rendered before the mirror was configured — the inline
    // `replicatePath` hook never ran for it, so the detector is what carries it.
    const thumbPath = resolveThumbPath(join(primaryRoot, 'IMG.dng'));
    const previewPath = cachePathFor(
      join(primaryRoot, 'IMG.dng'),
      'previews',
      PREVIEW_CACHE_SUFFIX,
    );
    mkdirSync(dirname(thumbPath), { recursive: true });
    mkdirSync(dirname(previewPath), { recursive: true });
    writeFileSync(thumbPath, 'avif-thumb');
    writeFileSync(previewPath, 'avif-preview');
    seedAsset(live.db, 'IMG.dng');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });

    const summary = await runMirrorScanOnce();

    expect(summary.enqueued).toBe(3); // original + thumb + preview (no sidecar)
    const queued = queuedMirrorPaths(live.db);
    const rel = (p: string) => join(mirrorRoot, relative(primaryRoot, p));
    expect(queued).toContain(rel(thumbPath));
    expect(queued).toContain(rel(previewPath));
  });

  it('skips an offline mirror root instead of flooding the queue', async () => {
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    seedAsset(live.db, 'IMG.dng');
    const offline = join(tmpdir(), `mirror-scan-offline-${process.pid}-does-not-exist`);
    setMirrorRoots({ [primaryRoot]: [offline] });

    const summary = await runMirrorScanOnce();

    expect(summary.enqueued).toBe(0);
    expect(summary.skippedOffline).toBeGreaterThan(0);
    expect(queuedMirrorPaths(live.db)).toEqual([]);
  });

  it('does not enqueue when the mirror is already up to date', async () => {
    writeFileSync(join(primaryRoot, 'IMG.dng'), 'raw');
    seedAsset(live.db, 'IMG.dng');
    setMirrorRoots({ [primaryRoot]: [mirrorRoot] });
    // Pre-replicate the original (mtime-preserving) so it's current.
    await copyFileToMirror(join(primaryRoot, 'IMG.dng'), join(mirrorRoot, 'IMG.dng'));

    const summary = await runMirrorScanOnce();

    expect(summary.enqueued).toBe(0);
    expect(summary.upToDate).toBeGreaterThan(0);
  });
});
