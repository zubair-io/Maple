/**
 * Regression tests for `sweepOrphanedCaches`' handling of the LEGACY thumb
 * freshness sidecar (`<key>.avif.meta`). The `.meta` protocol that wrote
 * these (`thumbs/thumb-meta.ts`) was removed in #2258 — nothing writes them
 * any more — but #2252 shipped and ran in production first, so every
 * install that has been running since has one `.meta` file per thumbnail
 * already on disk. This suite covers draining that pre-existing state, not
 * any current write path. Split out of `cache-gc.test.ts` to stay under the
 * file-size budget, mirroring `cache-gc.pano-preseed.test.ts`; like both it
 * runs against a per-test SQLite database installed as the process-wide
 * handle, so it shares no state with its neighbours.
 *
 * Sidecars are deliberately NOT swept as entries in their own right: the suffix
 * is appended to the whole artefact filename, so `path.extname('<key>.avif.meta')`
 * is `.meta` and the stem is `<key>.avif`, which matches no live-key shape —
 * putting `.meta` in `THUMB_EXTS` would condemn the sidecars of perfectly live
 * thumbs. They are instead reaped alongside their artefact, plus a dedicated
 * stranded-sidecar pass for ones orphaned out of band. Neither path counts toward
 * `scanned`/`deleted`, so the counters still reconcile against artefacts.
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

/** A 16-hex stem that hashes no live filename — a genuine orphan. */
const DEAD_KEY = '0123456789abcdef'; // gitleaks:allow sha256_prefix16 — 16 hex

// The library-roots cache is process-wide and must not outlive its database.
afterEach(() => {
  invalidateLibraryRoots();
});

async function mkTree(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cache-gc-sidecars-'));
}

/** Register `root` as a library and bust the app's own in-memory
 * `loadLibraryRoots()` cache so it picks up the fresh insert. Required for any
 * delete decision — with no resolvable library id the sweep scans but never
 * deletes. */
function registerLibrary(db: Database, root: string): string {
  const libraryId = insertFolder(db, { path: root });
  invalidateLibraryRoots();
  return libraryId;
}

/** Insert a live (non-tombstoned) asset at one location. */
function insertLiveAsset(db: Database, libraryId: string, relPath: string, filename: string): void {
  insertLocation(db, { assetId: insertAsset(db), libraryId, path: relPath, filename });
}

async function writeAvif(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0x00, 0x00, 0x00, 0x1c])); // tiny AVIF-ish bytes
}

/** Write a LEGACY `.meta` sidecar — the shape the pre-#2258 `.meta`
 * protocol used to write. Nothing in the current codebase writes this any
 * more; the test writes it by hand to simulate state left behind by an
 * older deployed version. */
async function writeLegacySidecar(thumbPath: string): Promise<void> {
  await mkdir(path.dirname(thumbPath), { recursive: true });
  await writeFile(`${thumbPath}.meta`, JSON.stringify({ mtimeMs: 1, size: 1 }));
}

/** Age `p` past the 60s recency-skip window so the sweep will consider it. */
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

function thumbsDir(root: string): string {
  return path.join(root, '.maple', 'thumbs');
}

describe('sweepOrphanedCaches — legacy thumb .meta sidecars', () => {
  test('reaps the legacy sidecar alongside its thumb, and keeps a live thumb’s', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'live.dng');

      const orphan = path.join(thumbsDir(root), `${DEAD_KEY}.avif`);
      const liveThumb = path.join(thumbsDir(root), `${sha256Prefix16('live.dng')}.avif`);
      for (const f of [orphan, liveThumb]) {
        await writeAvif(f);
        await writeLegacySidecar(f);
        await agePast(f);
        await agePast(`${f}.meta`);
      }

      // Only the two .avif files are scanned; sidecars ride along uncounted.
      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 2,
        deleted: 1,
        skipped_recent: 0,
      });

      await expect(stat(orphan)).rejects.toThrow();
      await expect(stat(`${orphan}.meta`)).rejects.toThrow();
      expect((await stat(liveThumb)).size).toBeGreaterThan(0);
      expect((await stat(`${liveThumb}.meta`)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reaps a stranded legacy sidecar whose thumb is gone', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      const libraryId = registerLibrary(live.db, root);
      insertLiveAsset(live.db, libraryId, '', 'live.dng');

      const liveThumb = path.join(thumbsDir(root), `${sha256Prefix16('live.dng')}.avif`);
      await writeAvif(liveThumb);
      await writeLegacySidecar(liveThumb);
      await agePast(liveThumb);
      await agePast(`${liveThumb}.meta`);

      // A sidecar with no artefact beside it — never scanned as an entry, so
      // without the dedicated pass it would leak forever.
      const stranded = path.join(thumbsDir(root), `${DEAD_KEY}.avif.meta`);
      await mkdir(path.dirname(stranded), { recursive: true });
      await writeFile(stranded, JSON.stringify({ mtimeMs: 1, size: 1 }));
      await agePast(stranded);

      // Only the live .avif is scanned, and nothing is counted deleted.
      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 1,
        deleted: 0,
        skipped_recent: 0,
      });

      await expect(stat(stranded)).rejects.toThrow();
      expect((await stat(liveThumb)).size).toBeGreaterThan(0);
      expect((await stat(`${liveThumb}.meta`)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leaves a just-written stranded legacy sidecar for the next pass', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // Not aged: within the recency window a sidecar belongs to a thumb some
      // stage is mid-publish on, so it must survive this pass.
      const fresh = path.join(thumbsDir(root), `${DEAD_KEY}.avif.meta`);
      await mkdir(path.dirname(fresh), { recursive: true });
      await writeFile(fresh, JSON.stringify({ mtimeMs: 1, size: 1 }));

      expect(await sweepOrphanedCaches(root)).toEqual({
        scanned: 0,
        deleted: 0,
        skipped_recent: 0,
      });
      expect((await stat(fresh)).size).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
