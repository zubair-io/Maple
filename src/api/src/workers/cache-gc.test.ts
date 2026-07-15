/**
 * Tests for `sweepOrphanedCaches`. Per-process isolated DB + skip-if-Mongo-
 * unreachable, mirroring `libraries.cache.test.ts`.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
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
import { MongoClient, ObjectId, type Db } from 'mongodb';

const TEST_DB = `maple_test_cache_gc_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[cache-gc.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {
      /* ignore */
    }
    try {
      await mongo.close();
    } catch {
      /* ignore */
    }
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

const KNOWN_ID = 'a'.repeat(32);
const LEGACY_KEY = '0123456789abcdef'; // gitleaks:allow sha256_prefix16 — 16 hex

async function mkTree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cache-gc-'));
  return root;
}

/** Register `root` as a library (so `sweepOrphanedCaches`' previews sweep can
 * resolve a library id for it) and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. Previews are
 * path-keyed and library-scoped now (see `cachePathForAsset`'s doc), unlike
 * thumbs' DB-wide `maple_id` uniqueness — every previews test below needs a
 * registered library, thumbs-only tests don't. */
async function registerLibrary(root: string): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: libraryId,
    path: root,
    label: 'cache-gc-test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  return libraryId;
}

/** Insert a live (non-tombstoned) asset row for one `fileinfo` location —
 * the shape `sweepOrphanedCaches`' previews known-live-set query reads. */
async function insertLiveAsset(libraryId: ObjectId, relPath: string, filename: string) {
  await db!.collection('assets').insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        library_id: libraryId,
        path: relPath,
        filename,
        deleted_at: null,
        missing_since: null,
      },
    ],
  } as never);
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
  test('unlinks legacy sha256_prefix16-keyed thumb and keeps known maple_id-keyed thumb', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // Legacy-key thumbs are only recognized as the pano pre-seed scheme
      // (and thus verifiably dead vs. verifiably live) once the library
      // resolves — see `isOrphanThumb`'s doc.
      await registerLibrary(root);
      const knownThumb = path.join(root, '.maple', 'thumbs', `${KNOWN_ID}.jpg`);
      const legacyThumb = path.join(root, '.maple', 'thumbs', `${LEGACY_KEY}.jpg`);
      await writeJpg(knownThumb);
      await writeJpg(legacyThumb);
      await agePast(knownThumb);
      await agePast(legacyThumb);

      await db!
        .collection('assets')
        .insertOne({ _id: new ObjectId(), maple_id: KNOWN_ID } as never);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1, skipped_recent: 0 });

      // Known file remains.
      const s = await stat(knownThumb);
      expect(s.size).toBeGreaterThan(0);
      // Legacy file gone.
      await expect(stat(legacyThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks orphaned .avif thumb and keeps known .avif thumb (thumb stage v3 format)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const knownThumb = path.join(root, '.maple', 'thumbs', `${KNOWN_ID}.avif`);
      const legacyThumb = path.join(root, '.maple', 'thumbs', `${LEGACY_KEY}.avif`);
      await writeAvif(knownThumb);
      await writeAvif(legacyThumb);
      await agePast(knownThumb);
      await agePast(legacyThumb);

      await db!
        .collection('assets')
        .insertOne({ _id: new ObjectId(), maple_id: KNOWN_ID } as never);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 2, deleted: 1, skipped_recent: 0 });

      // Known file remains.
      const s = await stat(knownThumb);
      expect(s.size).toBeGreaterThan(0);
      // Legacy file gone.
      await expect(stat(legacyThumb)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unlinks a preview whose filename is not a live location in the registered library', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(root, '.maple', 'previews', 'gone.dng.1280.avif');
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
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      // `image.jpg` is live; `image.jpg.bak` is NOT (already deleted).
      await insertLiveAsset(libraryId, '', 'image.jpg');
      const keep = path.join(root, '.maple', 'previews', 'image.jpg.1280.avif');
      const orphan = path.join(root, '.maple', 'previews', 'image.jpg.bak.1280.avif');
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

  test('keeps a preview whose filename matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
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

  test('keeps a developed preview (dev_<N> suffix) whose filename matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
      const keep = path.join(root, '.maple', 'previews', 'a.dng.dev_5.jpg');
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

  test('unlinks an orphaned developed preview (dev_<N> suffix) whose filename is not live', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(root, '.maple', 'previews', 'gone.dng.dev_12.jpg');
      await writeJpg(orphan);
      await agePast(orphan);

      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps an edited-preview (_1600.edited.jpg) whose hash matches a live fileinfo entry', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const { sha256Prefix16 } = await import('../fs/xmp.ts');
    const root = await mkTree();
    try {
      const libraryId = await registerLibrary(root);
      await insertLiveAsset(libraryId, '', 'a.dng');
      // Apple's local-only edited/developed-render preview
      // (`MapleSidecarPaths.editedPreviewURL`, #2009) — hash-keyed like the
      // pano pre-seed scheme, not path-keyed like the modern server tiers.
      const keep = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('a.dng')}_1600.edited.jpg`,
      );
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

  test('unlinks an orphaned edited-preview (_1600.edited.jpg) whose hash matches no live filename', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const { sha256Prefix16 } = await import('../fs/xmp.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      const orphan = path.join(
        root,
        '.maple',
        'previews',
        `${sha256Prefix16('gone.dng')}_1600.edited.jpg`,
      );
      await writeJpg(orphan);
      await agePast(orphan);

      // No live asset hashes to `sha256Prefix16('gone.dng')` — orphaned.
      const result = await sweepOrphanedCaches(root);
      expect(result).toEqual({ scanned: 1, deleted: 1, skipped_recent: 0 });

      await expect(stat(orphan)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not delete previews when the library cannot be resolved (safe degradation)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      // Deliberately NOT registered — `resolveLibraryId` returns null.
      const wouldBeOrphan = path.join(root, '.maple', 'previews', 'anything.dng.1280.avif');
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
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
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
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
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

  test('TOCTOU: recently-written orphan is NOT unlinked (skipped_recent bumps)', async () => {
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
      // Unknown filename (no live asset for it) with fresh mtime — simulates
      // a stage mid-write or just-finished writing while the known-live set
      // was already snapshotted.
      const fresh = path.join(root, '.maple', 'previews', 'brand-new.dng.1280.avif');
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
    if (!mongoReachable) return;
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    try {
      await registerLibrary(root);
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
    if (!mongoReachable) return;
    const root = await mkTree();
    try {
      await registerLibrary(root);
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
    if (!mongoReachable) return;
    // POSIX unlink requires write+execute on the parent directory. Chmod the
    // parent to 0o555 (r-x for owner) so:
    //   - readdir still works (need 'r'), so the sweep sees the files
    //   - unlink fails with EACCES (need 'w' on parent), tripping the threshold
    // Skip on Windows (no POSIX perms) and when running as root (perms ignored).
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    const lockedDir = path.join(root, '.maple', 'thumbs');
    try {
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
