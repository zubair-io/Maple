/**
 * Regression coverage for the critical thumbnailer guard: video containers,
 * metadata-only stub images (eip/braw/afphoto/ai), and audio (mp3/wav/m4a/aac)
 * must never fall through to `copyImageAsThumb`, which would copy the raw
 * source bytes verbatim to a `.jpg`-named thumb path — served by
 * `/api/thumb/...` as garbage `image/jpeg`. See #1835.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateThumb } from './thumbnailer.ts';
import { generatePreview } from './previewer.ts';

const NO_PREVIEW_SOURCES = [
  ['clip.mov', 'not a real quicktime file'],
  ['scan.eip', 'not a real phase one file'],
  ['session.braw', 'not a real blackmagic raw file'],
  ['project.afphoto', 'not a real affinity photo file'],
  ['logo.ai', 'not a real illustrator file'],
  ['track.mp3', 'not a real mp3 file'],
  ['voice.wav', 'not a real wav file'],
  ['memo.m4a', 'not a real m4a file'],
  ['song.aac', 'not a real aac file'],
] as const;

describe('generateThumb — no-preview guard', () => {
  for (const [filename, contents] of NO_PREVIEW_SOURCES) {
    it(`never copies raw source bytes to the thumb path for ${filename}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnailer-guard-'));
      try {
        const srcPath = path.join(dir, filename);
        const thumbPath = path.join(dir, 'thumb.jpg');
        await fs.writeFile(srcPath, contents);

        await generateThumb(srcPath, thumbPath);

        // The critical assertion: no thumb file was written at all — the
        // guard must return before `copyImageAsThumb` ever runs. If this
        // regresses, the raw non-image bytes get copied to thumbPath and
        // served as fake image/jpeg.
        await expect(fs.stat(thumbPath)).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('generatePreview — no-preview guard', () => {
  for (const [filename, contents] of NO_PREVIEW_SOURCES) {
    it(`never copies raw source bytes to the preview path for ${filename}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'previewer-guard-'));
      try {
        const srcPath = path.join(dir, filename);
        const previewPath = path.join(dir, 'preview_1280.jpg');
        await fs.writeFile(srcPath, contents);

        await generatePreview(srcPath, previewPath);

        await expect(fs.stat(previewPath)).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
