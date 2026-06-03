import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, assetsCollection } from '../../db/client.ts';
import type { WatchEvent } from './types.ts';

let reachable = true;
beforeAll(async () => { try { await getDb(); } catch { reachable = false; } });
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
    await (await assetsCollection()).insertMany([
      // recorded but NOT on disk → removed
      { maple_id: 'gone1', fileinfo: [{ library_id: folderId, path: '', filename: 'b.dng' }], deleted_at: null },
      // recorded AND on disk, unchanged → must emit NOTHING (no write storm)
      { maple_id: 'keep1', fileinfo: [{ library_id: folderId, path: '', filename: 'c.dng' }], deleted_at: null },
    ] as never);

    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    const dir = await frontier.claimNextDir(folderId, 1, 60_000);

    await visitDirectory(dir!, root, {
      handleEvent: async (e) => { events.push(e); },
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
    await (await assetsCollection()).insertMany([
      // on disk → must emit nothing
      { maple_id: 'sub-keep1', fileinfo: [{ library_id: folderId, path: 'sub', filename: 'keep.dng' }], deleted_at: null },
      // NOT on disk → must emit removed
      { maple_id: 'sub-gone1', fileinfo: [{ library_id: folderId, path: 'sub', filename: 'gone.dng' }], deleted_at: null },
    ] as never);

    const events: WatchEvent[] = [];
    await frontier.seedRoot(folderId, root, 1);
    // claimNextDir returns the root first (oldest enqueued); visitDirectory on
    // root enqueues 'sub'. Claim again until we get the sub dir.
    const rootDir = await frontier.claimNextDir(folderId, 1, 60_000);
    await visitDirectory(rootDir!, root, {
      handleEvent: async (e) => { events.push(e); },
      folderId,
    });
    // Now claim the sub dir that was just enqueued
    const subDir = await frontier.claimNextDir(folderId, 1, 60_000);
    expect(subDir).not.toBeNull();
    await visitDirectory(subDir!, root, {
      handleEvent: async (e) => { events.push(e); },
      folderId,
    });

    const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
    expect(kinds).toContain('removed:gone.dng');
    expect(kinds.find((k) => k.includes('keep.dng'))).toBeUndefined();

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
