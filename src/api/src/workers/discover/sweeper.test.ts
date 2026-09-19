/**
 * The reconciliation sweep: one directory per call, diffed against what the
 * database records for that directory.
 *
 * The three refusals are the tests worth keeping honest. A recorded file
 * missing from a listing is not evidence it is gone (a network share can return
 * a truncated listing), an empty library root is not evidence that every file
 * under it is gone (#2171 — an unmounted mount is a present-but-empty
 * directory), and `.maple/` must never be walked at all, or the sweep indexes
 * its own cache and feeds itself.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newObjectIdHex } from '../../db/object-id.ts';
import { createDiscoverLibrary, seedAsset, seedLocation } from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { advanceSweep, SweeperLoop, visitDirectory } from './sweeper.ts';
import type { WatchEvent } from './types.ts';

/** Record an asset at one location, the way a previous sweep would have. */
function record(
  library: { db: Parameters<typeof seedAsset>[0]; folderId: { toHexString(): string } },
  path: string,
  filename: string,
): string {
  const id = seedAsset(library.db, { id: newObjectIdHex(), mapleId: newObjectIdHex() });
  seedLocation(library.db, {
    assetId: id,
    libraryId: library.folderId.toHexString(),
    path,
    filename,
  });
  return id;
}

/** `kind:basename` for each emitted event — what the assertions read. */
function kindsOf(events: readonly WatchEvent[]): string[] {
  return events.map((event) => `${event.kind}:${event.absPath.split('/').pop()}`);
}

describe('visitDirectory', () => {
  it('enqueues subdirs, emits created for new images, removed for vanished assets', async () => {
    using library = await createDiscoverLibrary('maple-sweep-');
    const root = library.root;
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.dng'), 'x'); // new on disk, not recorded → created
    writeFileSync(join(root, 'c.dng'), 'x'); // on disk AND recorded → skipped (no event)
    writeFileSync(join(root, 'note.txt'), 'ignored'); // non-image: skipped

    record(library, '', 'b.dng'); // recorded but NOT on disk → removed
    record(library, '', 'c.dng'); // recorded AND on disk → must emit NOTHING

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);

    await visitDirectory(dir!, root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });

    // The subdirectory is enqueued for the same generation.
    expect(await frontier.remainingForGen(library.folderId, 1)).toBeGreaterThanOrEqual(1);
    const kinds = kindsOf(events);
    expect(kinds).toContain('created:a.dng');
    expect(kinds).toContain('removed:b.dng');
    expect(kinds.find((kind) => kind.includes('c.dng'))).toBeUndefined(); // unchanged → no write
    expect(kinds.find((kind) => kind.includes('note.txt'))).toBeUndefined();
  });

  it('does NOT emit removed for a present file missing from an incomplete listing', async () => {
    using library = await createDiscoverLibrary('maple-sweep-');
    writeFileSync(join(library.root, 'present.dng'), 'x'); // on disk AND recorded

    record(library, '', 'present.dng'); // the simulated listing omits it
    record(library, '', 'gone.dng'); // genuinely not on disk

    await frontier.seedRoot(library.folderId, library.root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);

    const events: WatchEvent[] = [];
    await visitDirectory(dir!, library.root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
      // Truncated listing: readdir "succeeds" but returns an empty set even
      // though present.dng is on disk (the SMB-blip failure mode).
      readDir: async () => [],
    });

    const kinds = kindsOf(events);
    // present.dng is really on disk → the stat-confirm skips it despite the listing.
    expect(kinds).not.toContain('removed:present.dng');
    // gone.dng is genuinely absent → still removed.
    expect(kinds).toContain('removed:gone.dng');
  });

  it('does NOT emit removed when the library root is unavailable (empty mountpoint)', async () => {
    // #2171: an unmounted bind/network mount is typically a present-but-EMPTY
    // directory. readdir succeeds (empty listing) and every stat-confirm
    // returns ENOENT — so the per-candidate stat alone cannot stop a mass
    // false-tag. The sweep must refuse to emit `removed` when the library root
    // itself holds no entries at all.
    using library = await createDiscoverLibrary('maple-sweep-unmounted-');
    // Root left completely EMPTY — the unmounted mountpoint.

    record(library, '', 'was-here.dng');

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, library.root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    await visitDirectory(dir!, library.root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });

    // The file stats absent, but the root is empty → no removal evidence.
    expect(events).toEqual([]);
  });

  it('reconciles a non-root subdirectory using the correct relative path', async () => {
    using library = await createDiscoverLibrary('maple-sweep-sub-');
    mkdirSync(join(library.root, 'sub'));
    writeFileSync(join(library.root, 'sub', 'keep.dng'), 'x'); // on disk AND recorded

    record(library, 'sub', 'keep.dng'); // on disk → must emit nothing
    record(library, 'sub', 'gone.dng'); // NOT on disk → must emit removed

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, library.root, 1);
    // claimNextDir returns the root first (oldest enqueued); visiting the root
    // enqueues 'sub'. Claim again to get the subdirectory.
    const rootDir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    const deps = {
      handleEvent: async (event: WatchEvent) => {
        events.push(event);
      },
      folderId: library.folderId,
    };
    await visitDirectory(rootDir!, library.root, deps);
    const subDir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    expect(subDir).not.toBeNull();
    await visitDirectory(subDir!, library.root, deps);

    const kinds = kindsOf(events);
    expect(kinds).toContain('removed:gone.dng');
    expect(kinds.find((kind) => kind.includes('keep.dng'))).toBeUndefined();
  });

  it('does not descend into `.maple/` cache or fire events for cache contents', async () => {
    // Regression for #1186: walking into `.maple/` makes the sweep index its
    // own thumb/preview cache as if it were source content. Each resulting
    // phantom asset's own output then lands one `.maple/` deeper, and the next
    // sweep re-discovers that — a self-feeding recursion. Dotdirs are skipped
    // entirely.
    using library = await createDiscoverLibrary('maple-sweep-cache-');
    const root = library.root;
    writeFileSync(join(root, 'real.dng'), 'x'); // legitimate source photo
    // The full mess the bug produced: nested cache dirs matching the production
    // layout, plus an AppleDouble resource fork whose extension matches but
    // whose content does not.
    mkdirSync(join(root, '.maple', 'thumbs'), { recursive: true });
    mkdirSync(join(root, '.maple', 'previews'), { recursive: true });
    writeFileSync(join(root, '.maple', 'thumbs', 'deadbeef.jpg'), 'x');
    writeFileSync(join(root, '.maple', 'previews', 'deadbeef_1024.jpg'), 'x');
    writeFileSync(join(root, '._sneaky.jpg'), 'x');

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    await visitDirectory(dir!, root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });

    // Only the real photo fires; nothing under `.maple/` and no AppleDouble.
    expect(kindsOf(events)).toEqual(['created:real.dng']);
    // `.maple/` is NOT enqueued for a follow-up visit, and the root entry was
    // consumed, so the frontier is empty.
    expect(await frontier.remainingForGen(library.folderId, 1)).toBe(0);
  });

  it('emits created for a video file (.mov)', async () => {
    using library = await createDiscoverLibrary('maple-sweep-video-');
    writeFileSync(join(library.root, 'clip.mov'), 'x');

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, library.root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    await visitDirectory(dir!, library.root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });

    expect(kindsOf(events)).toContain('created:clip.mov');
  });
});

describe('advanceSweep', () => {
  it('bumps the generation and reseeds the root when the frontier is empty', async () => {
    using library = await createDiscoverLibrary('maple-advance-');

    // Frontier empty for gen 1 ⇒ advance to gen 2 and reseed the root.
    const next = await advanceSweep(library.folderId, library.root, 1);
    expect(next).toBe(2);
    expect(await frontier.remainingForGen(library.folderId, 2)).toBe(1);
  });
});

describe('SweeperLoop', () => {
  it('visits dirs paced by the interval and halts when paused', async () => {
    using library = await createDiscoverLibrary('maple-loop-');
    mkdirSync(join(library.root, 'a'));
    mkdirSync(join(library.root, 'b'));
    await frontier.seedRoot(library.folderId, library.root, 1);

    let paused = false;
    const visited: string[] = [];
    const loop = new SweeperLoop({
      folderId: library.folderId,
      root: library.root,
      deps: { folderId: library.folderId, handleEvent: async () => {} },
      loadConfig: async () => ({ paused, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
      onVisit: (dirPath) => {
        visited.push(dirPath);
        if (visited.length === 3) paused = true;
      },
    });
    await loop.runUntilIdleOrPaused(); // test-only bound
    expect(visited.length).toBeGreaterThanOrEqual(3);
  });

  it('resumes a persisted generation and does not process gen-1 rows', async () => {
    // Regression guard for the restart-rehydration fix: without `startGen` the
    // loop defaults to gen 1, misses the gen-3 row, and returns idle without
    // visiting any directory.
    using library = await createDiscoverLibrary('maple-resume-');

    // Seed a gen-3 frontier row directly — a sweep that had already advanced
    // past gen 1 before the process restarted.
    await frontier.enqueueDirs(library.folderId, [library.root], 3, false);

    const visited: string[] = [];
    const loop = new SweeperLoop({
      folderId: library.folderId,
      root: library.root,
      startGen: 3,
      deps: { folderId: library.folderId, handleEvent: async () => {} },
      loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
      onVisit: (dirPath) => visited.push(dirPath),
    });
    await loop.runUntilIdleOrPaused();

    expect(visited).toContain(library.root);
    // The gen-3 row was consumed (the directory was completed).
    expect(await frontier.remainingForGen(library.folderId, 3)).toBe(0);
  });
});
