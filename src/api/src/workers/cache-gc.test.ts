/**
 * Tests for `sweepOrphanedCaches` (#3787).
 *
 * The sweep decides what to delete from one library's `.maple/` caches by
 * comparing what is on disk against the live filenames in that library, so each
 * test needs a real database and a real directory tree. The database is a
 * per-test SQLite one installed as the process-wide handle — the sweep resolves
 * the library and its live set through the ordinary production path, with no
 * override to thread and no external service to have running.
 */
import { describe, test, expect, afterEach, mock } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  stat,
  utimes,
  symlink,
  chmod,
  readdir,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const KNOWN_ID = 'a'.repeat(32);
const LEGACY_KEY = '0123456789abcdef'; // gitleaks:allow sha256_prefix16 — 16 hex

async function mkTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-'));
  return root;
}

// The library-roots cache is process-wide, so a root registered by one test
// would otherwise still resolve in the next one — against a disposed database.
afterEach(() => {
  invalidateLibraryRoots();
});

/** Register `root` as a library (so `sweepOrphanedCaches`' previews sweep can
 * resolve a library id for it) and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. BOTH tiers are
 * path-keyed and library-scoped now (see `cachePathForAsset`'s doc), so every
 * test that expects a delete decision needs a registered library — with no
 * resolvable library id the sweep scans but never deletes. */
function registerLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

/** Insert a live (non-tombstoned) asset at one location — the rows the sweep's
 * live-set query reads. */
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

describe('sweepOrphanedCaches', () => {
  // The retired `<maple_id>` naming MUST be reaped even though the asset still
  // carries that maple_id (it remains the thumb ETag). A liveness check against
  // the DB would keep one stale file per asset forever — see cache-gc's module
  // doc. The live path-keyed thumb in the same directory must survive.
  test('reaps a retired maple_id-keyed thumb and keeps the live path-keyed one', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const { sha256Prefix16 } = await import('../fs/xmp.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'live.dng');
      // Asset keeps its maple_id — proving the reap is not "maple_id is gone".
      run(live.db, `UPDATE assets SET maple_id = ? WHERE id = ?`, KNOWN_ID, insertAsset(live.db));

      const retiredThumb = path.join(root, '.maple', 'thumbs', `${KNOWN_ID}.jpg`);
      const liveThumb = path.join(root, '.maple', 'thumbs', `${sha256Prefix16('live.dng')}.jpg`);
      const deadKeyThumb = path.join(root, '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      for (const f of [retiredThumb, liveThumb, deadKeyThumb]) {
        await writeJpg(f);
        await agePast(f);
      }

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 3, deleted: 2, skipped_recent: 0 });

      // The thumb whose stem hashes a live filename in this directory survives.
      expect((await stat(liveThumb)).size).toBeGreaterThan(0);
      // Retired scheme, and a path-key matching no live file, both reaped.
      await expect(stat(retiredThumb)).rejects.toThrow();
      await expect(stat(deadKeyThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Same rule for the .avif tier the thumb stage actually writes.
  test('reaps a retired .avif thumb and keeps the live path-keyed .avif', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const { sha256Prefix16 } = await import('../fs/xmp.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'live.dng');
      const retiredThumb = path.join(root, '.maple', 'thumbs', `${KNOWN_ID}.avif`);
      const liveThumb = path.join(root, '.maple', 'thumbs', `${sha256Prefix16('live.dng')}.avif`);
      for (const f of [retiredThumb, liveThumb]) {
        await writeAvif(f);
        await agePast(f);
      }

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1, skipped_recent: 0 });

      expect((await stat(liveThumb)).size).toBeGreaterThan(0);
      await expect(stat(retiredThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks a preview whose filename is not a live location in the registered library', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      const orphan = path.join(root, '.maple', 'previews', 'gone.dng.avif');
      await writeAvif(orphan);
      await agePast(orphan);

      // No live asset for `gone.dng` — the file is orphaned.
      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Regression for jules's PR #2006 review: `image.jpg` is a strict string
  // prefix of `image.jpg.bak`, so naive `name.startsWith(liveFilename + '.')`
  // prefix matching would wrongly treat the deleted `image.jpg.bak`'s
  // orphaned preview as live (it matches `image.jpg.`'s prefix).
  test('unlinks an orphaned preview even when its filename is a strict prefix-match of a DIFFERENT live filename', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      // `image.jpg` is live; `image.jpg.bak` is NOT (already deleted).
      insertLiveAsset(live.db, libraryId, '', 'image.jpg');
      const keep = path.join(root, '.maple', 'previews', 'image.jpg.avif');
      const orphan = path.join(root, '.maple', 'previews', 'image.jpg.bak.avif');
      await writeAvif(keep);
      await writeAvif(orphan);
      await agePast(keep);
      await agePast(orphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a preview whose filename matches a live location', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'a.dng');
      const keep = path.join(root, '.maple', 'previews', 'a.dng.full.jpg');
      await writeJpg(keep);
      await agePast(keep);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A tombstoned location is not live, so the derivative keyed off its filename
  // is an orphan even though the row is still there — the port has to filter on
  // the location's own tags, not on the asset's existence.
  test('unlinks a preview whose only location is tombstoned', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLocation(live.db, {
        assetId: insertAsset(live.db),
        libraryId,
        path: '',
        filename: 'moved.dng',
        deletedAt: new Date().toISOString(),
      });
      const orphan = path.join(root, '.maple', 'previews', 'moved.dng.avif');
      await writeAvif(orphan);
      await agePast(orphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });
      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Migration (#2017): with the size/version token gone, the new
  // `<filename>.avif` is kept for a live asset while pre-KISS files for the
  // SAME live asset — the size-keyed `<filename>.1280.avif` and the retired
  // display-preview stage's `<filename>.dev_<N>.jpg` — orphan out, because they
  // recover to a source filename (`a.dng.1280` / null) that is never live.
  test('keeps the new <filename>.avif but orphans pre-KISS size/version-keyed files for a live asset', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'a.dng');
      const keep = path.join(root, '.maple', 'previews', 'a.dng.avif');
      const oldSized = path.join(root, '.maple', 'previews', 'a.dng.1280.avif');
      const oldDev = path.join(root, '.maple', 'previews', 'a.dng.dev_5.jpg');
      await writeAvif(keep);
      await writeAvif(oldSized);
      await writeJpg(oldDev);
      await agePast(keep);
      await agePast(oldSized);
      await agePast(oldDev);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 3, deleted: 2, skipped_recent: 0 });

      const s = await stat(keep);
      expect(s.size).toBeGreaterThan(0);
      await expect(stat(oldSized)).rejects.toThrow();
      await expect(stat(oldDev)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not delete previews when the library cannot be resolved (safe degradation)', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // A library exists, but not this root — `resolveLibraryId` returns null.
      registerLibrary(live.db, path.join(root, 'elsewhere'));
      const wouldBeOrphan = path.join(root, '.maple', 'previews', 'anything.dng.avif');
      await writeAvif(wouldBeOrphan);
      await agePast(wouldBeOrphan);

      const result = await sweepOrphanedCaches(root);
      // Still scanned (parity with thumbs), but nothing deleted — a
      // transient/failed library lookup must never mass-delete previews.
      expect(result).toEqual({ scanned: 1, deleted: 0, skipped_recent: 0 });

      const s = await stat(wouldBeOrphan);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('library with no .maple/ directories → { scanned: 0, deleted: 0 }', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // Put a normal photo at the root and a sub-folder, but no .maple.
      const topPhoto = path.join(root, 'photo.jpg');
      const subPhoto = path.join(root, 'sub', 'photo2.jpg');
      await writeJpg(topPhoto);
      await writeJpg(subPhoto);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 0, deleted: 0, skipped_recent: 0 });

      // Sweep must never touch normal asset files outside .maple/ caches.
      const topStat = await stat(topPhoto);
      expect(topStat.size).toBeGreaterThan(0);
      const subStat = await stat(subPhoto);
      expect(subStat.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('descends into sub-folders to find nested .maple/ caches', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      const nested = path.join(root, 'vacation', '2024', '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      await writeJpg(nested);
      await agePast(nested);

      const result = await sweepOrphanedCaches(root);
      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(1);
      await expect(stat(nested)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The live set is keyed by directory, so a live filename in one directory
  // must not vouch for a same-named derivative in another.
  test('does not let a live filename in one directory keep a derivative in another', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, 'kept', 'a.dng');
      const elsewhere = path.join(root, 'other', '.maple', 'previews', 'a.dng.avif');
      const here = path.join(root, 'kept', '.maple', 'previews', 'a.dng.avif');
      for (const f of [elsewhere, here]) {
        await writeAvif(f);
        await agePast(f);
      }

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1, skipped_recent: 0 });
      expect((await stat(here)).size).toBeGreaterThan(0);
      await expect(stat(elsewhere)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('TOCTOU: recently-written orphan is NOT unlinked (skipped_recent bumps)', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // Unknown filename (no live asset for it) with fresh mtime — simulates
      // a stage mid-write or just-finished writing while the known-live set
      // was already snapshotted.
      const fresh = path.join(root, '.maple', 'previews', 'brand-new.dng.avif');
      await writeAvif(fresh);
      // Do NOT age — mtime is "now", inside the recency window.

      const result = await sweepOrphanedCaches(root);
      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.skipped_recent).toBe(1);

      // File is still on disk despite its filename being unknown.
      const s = await stat(fresh);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not follow directory symlinks (no infinite loop)', async () => {
    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // A real .maple cache with one legacy orphan to verify the sweep still
      // does its job around the symlink.
      const realOrphan = path.join(root, '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      await writeJpg(realOrphan);
      await agePast(realOrphan);

      // Self-referential dir symlink: would loop forever if the walk followed it.
      await mkdir(path.join(root, 'inner'), { recursive: true });
      await symlink(root, path.join(root, 'inner', 'loop'));

      const result = await sweepOrphanedCaches(root);
      // Walk completed (no hang) and still found / unlinked the real orphan.
      expect(result.scanned).toBe(1);
      expect(result.deleted).toBe(1);
      await expect(stat(realOrphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ENOENT (file vanished between readdir and unlink) does not abort sweep or log error', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // Four legacy-keyed orphans. The mock makes `fs.unlink` race-fail
      // (ENOENT) for the first to land in unlinkSafe, simulating another
      // process having removed it between readdir and unlink.
      const racedKey = '0123456789abcdee'; // gitleaks:allow sha256_prefix16 — 16 hex
      const otherKeys = [
        '0123456789abcded', // gitleaks:allow sha256_prefix16 — 16 hex
        '0123456789abcdec', // gitleaks:allow sha256_prefix16 — 16 hex
        '0123456789abcdeb', // gitleaks:allow sha256_prefix16 — 16 hex
      ];
      const racedPath = path.join(root, '.maple', 'thumbs', `${racedKey}.jpg`);
      const otherPaths = otherKeys.map((k) => path.join(root, '.maple', 'thumbs', `${k}.jpg`));
      for (const p of [racedPath, ...otherPaths]) {
        await writeJpg(p);
        await agePast(p);
      }

      const realFs = await import('node:fs/promises');
      // Capture the real unlink BEFORE patching the module — otherwise the
      // fallback path inside the mock would recurse through the mocked
      // binding and blow the stack.
      const realUnlink = realFs.unlink.bind(realFs);
      // Module mock — bun:test rewires the ESM binding for the duration of
      // the test. Reset after by re-mocking back to the originals.
      mock.module('node:fs/promises', () => ({
        ...realFs,
        unlink: async (target: Parameters<typeof realFs.unlink>[0]) => {
          if (target === racedPath) {
            throw Object.assign(new Error('ENOENT: no such file or directory'), {
              code: 'ENOENT',
            });
          }
          return realUnlink(target);
        },
      }));

      try {
        // Fresh import so the mocked module is bound.
        const { sweepOrphanedCaches } = await import('./cache-gc.ts');

        // Even with the ENOENT injection, the sweep MUST complete and unlink
        // the other 3 orphans. If ENOENT counted toward FAIL_THRESHOLD, three
        // consecutive ENOENTs would abort the sweep — here we only inject one,
        // but the streak counter must also reset so a subsequent real failure
        // wouldn't trip immediately. `deleted === 3` verifies both.
        const result = await sweepOrphanedCaches(root);
        expect(result.scanned).toBe(4);
        expect(result.deleted).toBe(3);
        expect(result.skipped_recent).toBe(0);

        for (const p of otherPaths) {
          await expect(stat(p)).rejects.toThrow();
        }
        // racedPath is still there because our mock prevented the real unlink.
        const s = await stat(racedPath);
        expect(s.size).toBeGreaterThan(0);
      } finally {
        mock.module('node:fs/promises', () => realFs);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persistent unlink failure aborts sweep without crashing the caller', async () => {
    // POSIX unlink requires write+execute on the parent directory. Chmod the
    // parent to 0o555 (r-x for owner) so:
    //   - readdir still works (need 'r'), so the sweep sees the files
    //   - unlink fails with EACCES (need 'w' on parent), tripping the threshold
    // Skip on Windows (no POSIX perms) and when running as root (perms ignored).
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    const lockedDir = path.join(root, '.maple', 'thumbs');
    try {
      registerLibrary(live.db, root);
      // Four orphan files in one cache dir. We need at least 3 same-errno
      // failures to trip FAIL_THRESHOLD; the 4th may or may not be attempted
      // depending on whether the abort raced the loop body.
      const orphans = [
        path.join(lockedDir, `${LEGACY_KEY}.jpg`),
        path.join(lockedDir, '0123456789abcdee.jpg'),
        path.join(lockedDir, '0123456789abcded.jpg'),
        path.join(lockedDir, '0123456789abcdec.jpg'),
      ];
      for (const p of orphans) {
        await writeJpg(p);
        await agePast(p);
      }

      // Read-execute on parent: readdir/stat succeed, unlink fails EACCES.
      await chmod(lockedDir, 0o555);

      // Sweep should catch the abort internally and return partial counts —
      // crucially, it must NOT throw past the boot wiring at index.ts.
      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);
      // At least 3 scanned (the threshold) before the abort. May be 3 or 4
      // depending on readdir order.
      expect(result.scanned).toBeGreaterThanOrEqual(3);

      // Restore perms so files still on disk can be enumerated then cleaned.
      await chmod(lockedDir, 0o755);
      const remaining = await readdir(lockedDir);
      expect(remaining.length).toBe(orphans.length);
    } finally {
      // Defensive: re-open perms in case the test errored before we did.
      try {
        await chmod(lockedDir, 0o755);
      } catch {
        /* ignore */
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
