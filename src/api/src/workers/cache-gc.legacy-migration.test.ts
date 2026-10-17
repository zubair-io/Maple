import { describe, expect, it, spyOn } from 'bun:test';
import * as mirrored from '../fs/mirrored.ts';
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

type LiveDb = Awaited<ReturnType<typeof createLiveTestDatabase>>['db'];

const hash = sha256Prefix16('photo.dng');

async function seed(root: string, names: readonly string[]): Promise<void> {
  const oldTime = new Date(Date.now() - 300_000);
  for (const name of names) {
    const file = join(root, '.maple', name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, name);
    await utimes(file, oldTime, oldTime);
  }
}

function registerPhoto(db: LiveDb, root: string): void {
  const libraryId = insertFolder(db, { path: root });
  insertLocation(db, { assetId: insertAsset(db), libraryId, path: '', filename: 'photo.dng' });
  invalidateLibraryRoots();
}

async function listing(root: string, tier: string): Promise<string[]> {
  return (await readdir(join(root, '.maple', tier))).toSorted();
}

describe('cache-gc legacy derivative migration (#4793)', () => {
  it('renames the newest legacy derivative into place and deletes the rest, never touching the original', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-gc-'));
    try {
      await writeFile(join(root, 'photo.dng'), 'original');
      registerPhoto(live.db, root);
      await seed(root, [
        `thumbs/${hash}.avif`,
        `thumbs/${hash}.avif.meta`,
        `thumbs/${hash}.avif.v`,
        `thumbs/${hash}.v24.avif`,
        `thumbs/${hash}.v25.avif`,
        `thumbs/${sha256Prefix16('gone.dng')}.v25.avif`,
        'previews/photo.dng.v24.avif',
        'previews/photo.dng.v25.avif',
        'previews/photo.dng.v25.webp',
        'previews/photo.dng.v25.preview.json',
        'previews/photo.dng.v25.avif.source.json',
      ]);

      const result = await sweepOrphanedCaches(root);

      expect(result.deleted).toBe(4);
      expect(await listing(root, 'thumbs')).toEqual(['photo.dng.avif']);
      expect(await readFile(join(root, '.maple/thumbs/photo.dng.avif'), 'utf8')).toBe(
        `thumbs/${hash}.v25.avif`,
      );
      expect(await listing(root, 'previews')).toEqual([
        'photo.dng.avif',
        'photo.dng.avif.source.json',
        'photo.dng.preview.json',
        'photo.dng.webp',
      ]);
      expect(await readFile(join(root, '.maple/previews/photo.dng.avif'), 'utf8')).toBe(
        'previews/photo.dng.v25.avif',
      );
      expect(await readFile(join(root, 'photo.dng'), 'utf8')).toBe('original');
    } finally {
      invalidateLibraryRoots();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps an existing unversioned derivative and deletes its legacy siblings', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-gc-'));
    try {
      registerPhoto(live.db, root);
      await seed(root, [
        'thumbs/photo.dng.avif',
        `thumbs/${hash}.v25.avif`,
        'previews/photo.dng.avif',
        'previews/photo.dng.v25.avif',
      ]);

      const result = await sweepOrphanedCaches(root);

      expect(result.deleted).toBe(2);
      expect(await readFile(join(root, '.maple/thumbs/photo.dng.avif'), 'utf8')).toBe(
        'thumbs/photo.dng.avif',
      );
      expect(await readFile(join(root, '.maple/previews/photo.dng.avif'), 'utf8')).toBe(
        'previews/photo.dng.avif',
      );
      expect(await listing(root, 'thumbs')).toEqual(['photo.dng.avif']);
      expect(await listing(root, 'previews')).toEqual(['photo.dng.avif']);
    } finally {
      invalidateLibraryRoots();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never overwrites a derivative published after the directory was listed', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-gc-'));
    const listDir = mirrored.readdir;
    const fresh: Record<string, string> = {
      thumbs: join(root, '.maple/thumbs/photo.dng.avif'),
      previews: join(root, '.maple/previews/photo.dng.avif'),
    };
    const spy = spyOn(mirrored, 'readdir').mockImplementation((async (
      ...args: Parameters<typeof listDir>
    ) => {
      const entries = await listDir(...args);
      const tier = String(args[0]).split('/').at(-1) ?? '';
      if (fresh[tier]) await writeFile(fresh[tier], `fresh ${tier}`);
      return entries;
    }) as typeof listDir);
    try {
      registerPhoto(live.db, root);
      await seed(root, [`thumbs/${hash}.v25.avif`, 'previews/photo.dng.v25.avif']);

      await sweepOrphanedCaches(root);

      expect(await readFile(fresh.thumbs, 'utf8')).toBe('fresh thumbs');
      expect(await readFile(fresh.previews, 'utf8')).toBe('fresh previews');
      expect(await listing(root, 'thumbs')).toEqual(['photo.dng.avif']);
      expect(await listing(root, 'previews')).toEqual(['photo.dng.avif']);
    } finally {
      spy.mockRestore();
      invalidateLibraryRoots();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves hashed thumbs alone when the library cannot be resolved', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-legacy-gc-'));
    try {
      insertFolder(live.db, { path: join(root, 'elsewhere') });
      invalidateLibraryRoots();
      await seed(root, [`thumbs/${hash}.v25.avif`, `thumbs/${sha256Prefix16('x.dng')}.avif`]);

      const result = await sweepOrphanedCaches(root);

      expect(result.deleted).toBe(0);
      expect(await listing(root, 'thumbs')).toEqual(
        [`${hash}.v25.avif`, `${sha256Prefix16('x.dng')}.avif`].toSorted(),
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
