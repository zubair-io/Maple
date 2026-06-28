import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, assetsCollection } from '../../db/client.ts';
import type { WatchEvent } from './types.ts';

let reachable = true;
beforeAll(async () => {
  try {
    await getDb();
  } catch {
    reachable = false;
  }
});
beforeEach(async () => {
  if (!reachable) return;
  await (await getDb()).collection('discover_frontier').deleteMany({});
  await (await assetsCollection()).deleteMany({});
});

describe('visitDirectory', () => {
  it('enqueues subdirs, emits created for new images, removed for vanished assets', async () => {
    if (!reachable) return;
    const { visitDirectory } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const root = mkdtempSync(join(tmpdir(), 'maple-sweep-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.dng'), 'x'); // new on disk, not recorded → created
    writeFileSync(join(root, 'c.dng'), 'x'); // on disk AND recorded → skipped (no event)
    writeFileSync(join(root, 'note.txt'), 'ignored'); // non-image: skipped

    const folderId = new ObjectId();
    await (
      await assetsCollection()
    ).insertMany([
      // recorded but NOT on disk → removed
      {
        maple_id: 'gone1',
        fileinfo: [{ library_id: folderId, path: '', filename: 'b.dng' }],
        deleted_at: null,
      },
      // recorded AND on disk, unchanged → must emit NOTHING (no write storm)
      {
        maple_id: 'keep1',
        fileinfo: [{ library_id: folderId, path: '', filename: 'c.dng' }],
        deleted_at: null,
      },
    ] as never);

    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    const dir = await frontier.claimNextDir(folderId, 1, 60_000);

    await visitDirectory(dir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });

    // subdir enqueued for the same generation
    expect(await frontier.remainingForGen(folderId, 1)).toBeGreaterThanOrEqual(1);
    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toContain('created:a.dng');
    expect(kinds).toContain('removed:b.dng');
    expect(kinds.find((k) => k.includes('c.dng'))).toBeUndefined(); // unchanged → no write
    expect(kinds.find((k) => k.includes('note.txt'))).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it('reconciles a non-root subdirectory using the correct relative path', async () => {
    if (!reachable) return;
    const { visitDirectory } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const root = mkdtempSync(join(tmpdir(), 'maple-sweep-sub-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'keep.dng'), 'x'); // on disk AND recorded → must be skipped (no event)
    // gone.dng is NOT written to disk → should emit removed

    const folderId = new ObjectId();
    await (
      await assetsCollection()
    ).insertMany([
      // on disk → must emit nothing
      {
        maple_id: 'sub-keep1',
        fileinfo: [{ library_id: folderId, path: 'sub', filename: 'keep.dng' }],
        deleted_at: null,
      },
      // NOT on disk → must emit removed
      {
        maple_id: 'sub-gone1',
        fileinfo: [{ library_id: folderId, path: 'sub', filename: 'gone.dng' }],
        deleted_at: null,
      },
    ] as never);

    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    // claimNextDir returns the root first (oldest enqueued); visitDirectory on
    // root enqueues 'sub'. Claim again until we get the sub dir.
    const rootDir = await frontier.claimNextDir(folderId, 1, 60_000);
    await visitDirectory(rootDir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });
    // Now claim the sub dir that was just enqueued
    const subDir = await frontier.claimNextDir(folderId, 1, 60_000);
    expect(subDir).not.toBeNull();
    await visitDirectory(subDir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });

    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toContain('removed:gone.dng');
    expect(kinds.find((k) => k.includes('keep.dng'))).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it('does not descend into `.maple/` cache or fire events for cache contents', async () => {
    // Regression for #1186: walking into `.maple/` makes the sweeper index
    // its own thumb/preview cache as if it were source content. Each
    // resulting phantom asset's thumb/preview output then lands one
    // `.maple/` deeper than the file (per `fs/xmp.ts` path math), and the
    // next sweep re-discovers that — a self-feeding `.maple/.maple/.../…jpg`
    // recursion. The sweeper must skip dotdirs entirely.
    if (!reachable) return;
    const { visitDirectory } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const root = mkdtempSync(join(tmpdir(), 'maple-sweep-cache-'));
    // Legitimate source photo — should still be discovered.
    writeFileSync(join(root, 'real.dng'), 'x');
    // The full mess the bug produced: nested `.maple/` cache dirs with
    // thumbs/previews matching the production layout, plus an AppleDouble
    // resource-fork file (extension matches but content doesn't).
    mkdirSync(join(root, '.maple', 'thumbs'), { recursive: true });
    mkdirSync(join(root, '.maple', 'previews'), { recursive: true });
    writeFileSync(join(root, '.maple', 'thumbs', 'deadbeef.jpg'), 'x');
    writeFileSync(join(root, '.maple', 'previews', 'deadbeef_1024.jpg'), 'x');
    writeFileSync(join(root, '._sneaky.jpg'), 'x');

    const folderId = new ObjectId();
    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    const dir = await frontier.claimNextDir(folderId, 1, 60_000);
    await visitDirectory(dir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });

    // Only the real photo fires; nothing under `.maple/` and no AppleDouble.
    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toEqual(['created:real.dng']);
    // The `.maple/` directory is NOT enqueued for a follow-up visit.
    // visitDirectory consumed the root entry — frontier should be empty.
    expect(await frontier.remainingForGen(folderId, 1)).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  it('emits created for a video file (.mov)', async () => {
    if (!reachable) return;
    const { visitDirectory } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const root = mkdtempSync(join(tmpdir(), 'maple-sweep-video-'));
    writeFileSync(join(root, 'clip.mov'), 'x');

    const folderId = new ObjectId();
    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    const dir = await frontier.claimNextDir(folderId, 1, 60_000);
    await visitDirectory(dir!, root, {
      handleEvent: async (e) => {
        events.push(e);
      },
      folderId,
    });

    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toContain('created:clip.mov');

    rmSync(root, { recursive: true, force: true });
  });
});

describe('advanceSweep', () => {
  it('advanceSweep bumps generation and reseeds the root when the frontier is empty', async () => {
    if (!reachable) return;
    const { advanceSweep } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');
    const folderId = new ObjectId();

    // Frontier empty for gen 1 ⇒ advance to gen 2 and reseed the root.
    const next = await advanceSweep(folderId, '/srv/photos/Library', 1);
    expect(next).toBe(2);
    expect(await frontier.remainingForGen(folderId, 2)).toBe(1);
  });
});

describe('SweeperLoop', () => {
  it('SweeperLoop visits dirs paced by interval and halts when paused', async () => {
    if (!reachable) return;
    const { SweeperLoop } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');
    const root = mkdtempSync(join(tmpdir(), 'maple-loop-'));
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    const folderId = new ObjectId();
    await frontier.seedRoot(folderId, root, 1);

    let paused = false;
    const visited: string[] = [];
    const loop = new SweeperLoop({
      folderId,
      root,
      deps: { folderId, handleEvent: async () => {} },
      loadConfig: async () => ({ paused, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
      onVisit: (p) => {
        visited.push(p);
        if (visited.length === 3) paused = true;
      },
    });
    await loop.runUntilIdleOrPaused(); // test-only bound
    expect(visited.length).toBeGreaterThanOrEqual(3);
    rmSync(root, { recursive: true, force: true });
  });

  it('SweeperLoop resumes a persisted generation (startGen) and does not process gen 1 rows', async () => {
    // Regression guard for the restart-rehydration fix: without startGen the
    // loop would default to gen 1, miss the gen-3 row, and return idle without
    // visiting any directory.
    if (!reachable) return;
    const { SweeperLoop } = await import('./sweeper.ts');
    const frontier = await import('./frontier.repo.ts');

    const folderId = new ObjectId();
    // Use an empty temp dir as the gen-3 root (no subdirs → one visit, then done).
    const root = mkdtempSync(join(tmpdir(), 'maple-resume-'));

    // Seed a gen-3 frontier row directly (simulates a sweep that had already
    // advanced past gen 1 before the process restarted).
    await frontier.enqueueDirs(folderId, [root], 3);

    const visited: string[] = [];
    const loop = new SweeperLoop({
      folderId,
      root,
      startGen: 3,
      deps: { folderId, handleEvent: async () => {} },
      loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
      onVisit: (p) => visited.push(p),
    });
    await loop.runUntilIdleOrPaused();

    // The loop must have claimed and visited the gen-3 directory.
    expect(visited).toContain(root);
    // The gen-3 frontier row was consumed (dir was completed).
    expect(await frontier.remainingForGen(folderId, 3)).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });
});
