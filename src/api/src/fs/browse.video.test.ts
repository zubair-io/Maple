/**
 * Tests for video-file surfacing in listDirFast and listDirContents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

// Isolate from every later suite's idea of where the library roots are — `/`
// must not outlive this file.
withTestEnv('MAPLE_ROOTS', '/');

// An empty library, installed as the process-wide handle: browse's EXIF
// enrichment reaches it with no override, and an empty index is exactly the
// state these cases describe — nothing here has been indexed.
let live: LiveTestDatabase;

beforeAll(async () => {
  live = await createLiveTestDatabase();
});
afterAll(() => {
  live.close();
});

describe('listDirFast — video files', () => {
  it('includes .mov files in the images array with isVideo=true', async () => {
    const { listDirFast } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-video-'));
    try {
      await fs.writeFile(path.join(dir, 'clip.mov'), 'x');
      await fs.writeFile(path.join(dir, 'photo.dng'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      const { images } = result.data!;

      const names = images.map((i) => i.name);
      expect(names).toContain('clip.mov');
      expect(names).toContain('photo.dng');

      const videoEntry = images.find((i) => i.name === 'clip.mov');
      expect(videoEntry?.isVideo).toBe(true);

      const photoEntry = images.find((i) => i.name === 'photo.dng');
      expect(photoEntry?.isVideo).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('includes .mp4 files in the images array with isVideo=true', async () => {
    const { listDirFast } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-video2-'));
    try {
      await fs.writeFile(path.join(dir, 'video.mp4'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      const { images } = result.data!;

      const videoEntry = images.find((i) => i.name === 'video.mp4');
      expect(videoEntry).toBeDefined();
      expect(videoEntry?.isVideo).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT include .xmp files in the images array', async () => {
    const { listDirFast } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-video3-'));
    try {
      await fs.writeFile(path.join(dir, 'clip.mov.xmp'), '<x/>');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      const { images } = result.data!;

      const names = images.map((i) => i.name);
      expect(names).not.toContain('clip.mov.xmp');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listDirContents — video files', () => {
  it('includes .mov files in the images array with isVideo=true (not in files)', async () => {
    const { listDirContents } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-dirc-video-'));
    try {
      await fs.writeFile(path.join(dir, 'clip.mov'), 'x');

      const result = await listDirContents(dir);
      expect(result.ok).toBe(true);
      const { images, files } = result.data!;

      const imageNames = images.map((i) => i.name);
      expect(imageNames).toContain('clip.mov');

      const videoEntry = images.find((i) => i.name === 'clip.mov');
      expect(videoEntry?.isVideo).toBe(true);

      // Must NOT be in the files bucket
      const fileNames = files.map((f) => f.name);
      expect(fileNames).not.toContain('clip.mov');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
