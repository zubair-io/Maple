import { describe, expect, it } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-fields.generated.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { sha256Prefix16 } from '../fs/xmp.ts';
import { cleanPreviewsCacheForLocation } from '../fs/preview-cache-cleanup.ts';
import { sweepOrphanedCaches } from './cache-gc.ts';

describe('shared cache version retirement (#3594)', () => {
  it('reaps legacy/older renders and markers while preserving current and newer formats', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkdtemp(join(tmpdir(), 'maple-version-gc-'));
    try {
      const source = join(root, 'photo.dng');
      await copyFile(
        resolve(import.meta.dir, '../../../../test-fixtures/batch-transfer/source.dng'),
        source,
      );
      const original = await readFile(source);
      const libraryId = insertFolder(live.db, { path: root });
      insertLocation(live.db, {
        assetId: insertAsset(live.db),
        libraryId,
        path: '',
        filename: 'photo.dng',
      });
      invalidateLibraryRoots();
      const hash = sha256Prefix16('photo.dng');
      const old = PIPELINE_OUTPUT_VERSION - 1;
      const current = PIPELINE_OUTPUT_VERSION;
      const future = current + 1;
      const retired = [
        `thumbs/${hash}.avif`,
        `thumbs/${hash}.v${old}.avif`,
        'previews/photo.dng.avif',
        `previews/photo.dng.v${old}.avif`,
        `previews/photo.dng.v${old}.preview.json`,
        `previews/photo.dng.v${old}.avif.source.json`,
      ];
      const retained = [
        `thumbs/${hash}.v${current}.avif`,
        `thumbs/${hash}.v${future}.avif`,
        `previews/photo.dng.v${current}.avif`,
        `previews/photo.dng.v${future}.avif`,
        `previews/photo.dng.v${current}.webp`,
        `previews/photo.dng.v${current}.png`,
        `previews/photo.dng.v${current}.preview.json`,
        `previews/photo.dng.v${current}.avif.source.json`,
      ];
      const markers = [`thumbs/${hash}.avif.v`, `thumbs/${hash}.avif.meta`];
      const oldTime = new Date(Date.now() - 300_000);
      for (const name of [...retired, ...retained, ...markers]) {
        const path = join(root, '.maple', name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, name);
        await utimes(path, oldTime, oldTime);
      }
      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(retired.length);
      for (const name of [...retired, ...markers])
        await expect(stat(join(root, '.maple', name))).rejects.toThrow();
      for (const name of retained)
        expect(await readFile(join(root, '.maple', name), 'utf8')).toBe(name);
      expect(await readFile(source)).toEqual(original);
    } finally {
      invalidateLibraryRoots();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('location cleanup removes every version for the exact source and preserves a same-prefix source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maple-version-cleanup-'));
    try {
      const directory = join(root, '.maple', 'previews');
      await mkdir(directory, { recursive: true });
      const removed = [
        'photo.dng.avif',
        'photo.dng.v1.avif',
        `photo.dng.v${PIPELINE_OUTPUT_VERSION}.avif`,
        `photo.dng.v${PIPELINE_OUTPUT_VERSION + 1}.preview.json`,
      ];
      const kept = `photo.dng.bak.v${PIPELINE_OUTPUT_VERSION}.avif`;
      for (const name of [...removed, kept]) await writeFile(join(directory, name), name);
      await cleanPreviewsCacheForLocation(root, { path: '', filename: 'photo.dng' });
      for (const name of removed) await expect(stat(join(directory, name))).rejects.toThrow();
      expect(await readFile(join(directory, kept), 'utf8')).toBe(kept);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
