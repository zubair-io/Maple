/**
 * Tests for metadata-only stub-image and audio surfacing in listDirFast and
 * listDirContents (#1835). These formats must land in the `images[]` bucket
 * (like video) with `isStub`/`isAudio` flags — not the inert `files[]`
 * bucket that never gets indexed/surfaced in the grid.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Isolate from the real maple DB.
process.env.MAPLE_MONGO_DB = `maple_test_browse_stub_audio_${process.pid}`;
process.env.MAPLE_ROOTS = '/';

beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});
afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

describe('listDirFast — stub images and audio (#1835)', () => {
  it('includes stub-image files in the images array with isStub=true', async () => {
    const { listDirFast } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-stub-'));
    try {
      await fs.writeFile(path.join(dir, 'scan.eip'), 'x');
      await fs.writeFile(path.join(dir, 'session.braw'), 'x');
      await fs.writeFile(path.join(dir, 'project.afphoto'), 'x');
      await fs.writeFile(path.join(dir, 'logo.ai'), 'x');
      await fs.writeFile(path.join(dir, 'photo.dng'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      const { images } = result.data!;

      for (const name of ['scan.eip', 'session.braw', 'project.afphoto', 'logo.ai']) {
        const entry = images.find((i) => i.name === name);
        expect(entry?.isStub).toBe(true);
        expect(entry?.isAudio).toBeUndefined();
      }

      const photoEntry = images.find((i) => i.name === 'photo.dng');
      expect(photoEntry?.isStub).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('includes audio files in the images array with isAudio=true', async () => {
    const { listDirFast } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-audio-'));
    try {
      await fs.writeFile(path.join(dir, 'track.mp3'), 'x');
      await fs.writeFile(path.join(dir, 'voice.wav'), 'x');
      await fs.writeFile(path.join(dir, 'memo.m4a'), 'x');
      await fs.writeFile(path.join(dir, 'song.aac'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      const { images } = result.data!;

      for (const name of ['track.mp3', 'voice.wav', 'memo.m4a', 'song.aac']) {
        const entry = images.find((i) => i.name === name);
        expect(entry?.isAudio).toBe(true);
        expect(entry?.isStub).toBeUndefined();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listDirContents — stub images and audio (#1835)', () => {
  it('includes stub images and audio in the images array (not in files)', async () => {
    const { listDirContents } = await import('./browse.ts');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-dirc-stub-audio-'));
    try {
      await fs.writeFile(path.join(dir, 'logo.ai'), 'x');
      await fs.writeFile(path.join(dir, 'track.mp3'), 'x');

      const result = await listDirContents(dir);
      expect(result.ok).toBe(true);
      const { images, files } = result.data!;

      const imageNames = images.map((i) => i.name);
      expect(imageNames).toContain('logo.ai');
      expect(imageNames).toContain('track.mp3');

      const stubEntry = images.find((i) => i.name === 'logo.ai');
      expect(stubEntry?.isStub).toBe(true);
      const audioEntry = images.find((i) => i.name === 'track.mp3');
      expect(audioEntry?.isAudio).toBe(true);

      // Must NOT be in the inert files bucket.
      const fileNames = files.map((f) => f.name);
      expect(fileNames).not.toContain('logo.ai');
      expect(fileNames).not.toContain('track.mp3');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
