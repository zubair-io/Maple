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
});
