import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { sha256Prefix16 } from '../fs/xmp.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import { sweepOrphanedCaches } from './cache-gc.ts';

async function seed(root: string, names: readonly string[]): Promise<void> {
  const oldTime = new Date(Date.now() - 300_000);
  for (const name of names) {
    const file = join(root, '.maple', name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, name);
    await utimes(file, oldTime, oldTime);
  }
}

async function listing(root: string, tier: string): Promise<string[]> {
  return (await readdir(join(root, '.maple', tier))).toSorted();
}

describe('cache-gc retired derivative names (#4928)', () => {
  it('neither renames nor deletes hashed or versioned names, live or orphaned', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-gc-'));
    try {
      const libraryId = insertFolder(live.db, { path: root });
      insertLocation(live.db, {
        assetId: insertAsset(live.db),
        libraryId,
        path: '',
        filename: 'photo.dng',
      });
      invalidateLibraryRoots();
      const liveHash = sha256Prefix16('photo.dng');
      const goneHash = sha256Prefix16('gone.dng');
      const retiredThumbs = [
        `${liveHash}.avif`,
        `${liveHash}.jpg`,
        `${liveHash}.v25.avif`,
        `${goneHash}.avif`,
        `${goneHash}.v24.jpg`,
        'photo.dng.v25.avif',
      ];
      const retiredPreviews = [
        'gone.dng.v24.avif',
        'gone.dng.v25.avif.source.json',
        'photo.dng.v25.avif',
        'photo.dng.v25.preview.json',
        'photo.dng.v25.webp',
      ];
      await seed(root, [
        ...retiredThumbs.map((name) => `thumbs/${name}`),
        ...retiredPreviews.map((name) => `previews/${name}`),
        'thumbs/gone.dng.avif',
        'previews/gone.dng.avif',
      ]);

      const result = await sweepOrphanedCaches(root);

      expect(result).toEqual({ scanned: 2, deleted: 2, skipped_recent: 0 });
      expect(await listing(root, 'thumbs')).toEqual(retiredThumbs.toSorted());
      expect(await listing(root, 'previews')).toEqual(retiredPreviews.toSorted());
      expect(await readFile(join(root, '.maple/thumbs', `${liveHash}.v25.avif`), 'utf8')).toBe(
        `thumbs/${liveHash}.v25.avif`,
      );
    } finally {
      invalidateLibraryRoots();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('location cleanup removes current and legacy previews for the exact source only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-cleanup-'));
    try {
      const directory = join(root, '.maple', 'previews');
      await mkdir(directory, { recursive: true });
      const removed = [
        'photo.dng.avif',
        'photo.dng.jpg',
        'photo.dng.preview.json',
        'photo.dng.v1.avif',
        'photo.dng.v25.avif',
        'photo.dng.v26.preview.json',
      ];
      const kept = ['photo.dng.bak.avif', 'photo.dng.bak.v25.avif'];
      for (const name of [...removed, ...kept]) await writeFile(join(directory, name), name);
      await cleanPreviewsCacheForLocation(root, { path: '', filename: 'photo.dng' });
      expect((await readdir(directory)).toSorted()).toEqual(kept);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
