/**
 * Regression tests for `sweepOrphanedCaches`' recognition of the pano
 * stitcher's pre-seed derivative scheme. Split out of `cache-gc.test.ts` to
 * stay under the file-size budget; like that suite it runs against a per-test
 * SQLite database installed as the process-wide handle, so the two files can
 * run standalone or together without sharing any state.
 *
 * The pano stitcher pre-seeds a `<filename>.avif` thumb immediately after
 * stitching, before the pano is indexed (maple-pano/src/stitch/io.rs
 * write_display_sidecars, #1365): it is live iff that filename is live in
 * this exact directory. The older `sha256_prefix16(basename)` pre-seed name is
 * a #4793-retired name the sweep leaves untouched (#4928).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { sha256Prefix16 } from '../fs/xmp.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { sweepOrphanedCaches } from './cache-gc.ts';

// The library-roots cache is process-wide and must not outlive its database.
afterEach(() => {
  invalidateLibraryRoots();
});

async function mkTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-preseed-'));
  return root;
}

/** Register `root` as a library and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. */
function registerLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

/** Insert a live (non-tombstoned) asset at one location. */
function insertLiveAsset(db: Database, libraryId: string, relPath: string, filename: string): void {
  insertLocation(db, { assetId: insertAsset(db), libraryId, path: relPath, filename });
}

async function writeJpg(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny JPEG-ish bytes
}

async function writeAvif(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0x00, 0x00, 0x00, 0x1c])); // tiny AVIF-ish bytes
}

/**
 * Age `p` past the recency-skip window so the sweep will consider it for
 * deletion. The sweep skips files whose mtime is within 60s of `Date.now()`
 * (TOCTOU defense). Tests that want a file to be eligible for unlink must
 * call this. 5 minutes back is generous and stable across slow CI clocks.
 */
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

describe('sweepOrphanedCaches — pano pre-seed derivatives', () => {
  test('keeps a pano pre-seed thumb (<filename>.avif) matching a live filename', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'panorama-test.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', 'panorama-test.png.avif');
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      const s = await stat(preSeedThumb);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a legacy hashed pano pre-seed thumb untouched (#4928)', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'panorama-test.png');
      const hashed = path.join(
        root,
        '.maple',
        'thumbs',
        `${sha256Prefix16('panorama-test.png')}.avif`,
      );
      await writeAvif(hashed);
      await agePast(hashed);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 0, deleted: 0, skipped_recent: 0 });

      expect((await stat(hashed)).size).toBeGreaterThan(0);
      await expect(
        stat(path.join(root, '.maple', 'thumbs', 'panorama-test.png.avif')),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not delete a pano pre-seed thumb when the library cannot be resolved (safe degradation)', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      // A library exists, but not this root — `resolveLibraryId` returns null,
      // so no known-live set can be built. Mirrors the previews-side
      // "safe degradation" test — a transient/failed library lookup must
      // never mass-delete a pano's pre-seed thumb either (jules review,
      // PR #2008 round 2).
      registerLibrary(live.db, path.join(root, 'elsewhere'));
      const preSeedKey = sha256Prefix16('panorama-test.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', `${preSeedKey}.avif`);
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      const s = await stat(preSeedThumb);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a legacy hashed pano pre-seed thumb matching NO live filename untouched (#4928)', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      const preSeedKey = sha256Prefix16('never-indexed.png');
      const preSeedThumb = path.join(root, '.maple', 'thumbs', `${preSeedKey}.avif`);
      await writeAvif(preSeedThumb);
      await agePast(preSeedThumb);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);

      expect((await stat(preSeedThumb)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Same pattern for the preview tier — `<sha256_prefix16(basename)>_1600.jpg`.
  test('reaps an unversioned pano preview even when its original is live', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'panorama-test.png');
      const preSeedKey = sha256Prefix16('panorama-test.png');
      const preSeedPreview = path.join(root, '.maple', 'previews', `${preSeedKey}_1600.jpg`);
      await writeJpg(preSeedPreview);
      await agePast(preSeedPreview);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(1);
      await expect(stat(preSeedPreview)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks a pano pre-seed preview (sha256_prefix16-keyed) matching NO live filename', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      const preSeedKey = sha256Prefix16('never-indexed.png');
      const preSeedPreview = path.join(root, '.maple', 'previews', `${preSeedKey}_1600.jpg`);
      await writeJpg(preSeedPreview);
      await agePast(preSeedPreview);

      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(1);

      await expect(stat(preSeedPreview)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
