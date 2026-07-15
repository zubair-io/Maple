/**
 * End-to-end coverage for #2011: `generateThumb`/`generatePreview` must
 * route their AVIF encode through `publishValidatedAvif` (temp path →
 * decode-validate → rename) rather than writing straight to the final cache
 * path. Exercises the real pipeline (the actual `imgdecode` child process,
 * not a fake worker) so the wiring itself — not just `validateAvifOutput` in
 * isolation (see `thumbs/validate-avif.test.ts`) — is proven.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { generateThumb } from './thumbnailer.ts';
import { generatePreview, PREVIEW_LONG_EDGE_PX } from './previewer.ts';
import { validateAvifOutput } from '../thumbs/validate-avif.ts';

async function makeJpeg(
  dir: string,
  filename: string,
  width: number,
  height: number,
): Promise<string> {
  const file = path.join(dir, filename);
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  await fs.writeFile(file, buf);
  return file;
}

describe('generateThumb — AVIF validation wiring', () => {
  it('publishes a real bitmap source as a validated AVIF at the thumb path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-avifval-'));
    try {
      const src = await makeJpeg(dir, 'photo.jpg', 3000, 1500);
      const thumbPath = path.join(dir, 'thumb.avif');

      await generateThumb(src, thumbPath);

      // 512 matches thumbnailer.ts's private THUMB_LONG_EDGE_PX — reusing the
      // production validator itself as the assertion oracle confirms the
      // published file is exactly what generateThumb's own gate accepts.
      const result = await validateAvifOutput(thumbPath, 512);
      expect(result.ok).toBe(true);

      // No temp artefact left behind alongside the published file.
      const entries = await fs.readdir(dir);
      expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never leaves a broken file at the thumb path for the unknown-format copy fallback', async () => {
    // .bmp is not in RAW_EXTS, SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS, or the
    // no-preview guard sets, so it reaches `copyImageAsThumb` — the
    // last-resort branch that copies source bytes verbatim. Before #2011
    // this always "succeeded"; now the copied (non-AVIF) bytes must fail
    // `publishValidatedAvif`'s decode gate and never reach the thumb path.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumb-avifval-copy-'));
    try {
      const src = path.join(dir, 'legacy.bmp');
      await fs.writeFile(src, 'not a real bitmap, just bytes');
      const thumbPath = path.join(dir, 'thumb.avif');

      await generateThumb(src, thumbPath);

      await expect(fs.stat(thumbPath)).rejects.toThrow();
      const entries = await fs.readdir(dir);
      expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePreview — AVIF validation wiring', () => {
  it('publishes a real bitmap source as a validated AVIF at the preview path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-avifval-'));
    try {
      const src = await makeJpeg(dir, 'photo.jpg', 3000, 1500);
      const previewPath = path.join(dir, 'preview.avif');

      await generatePreview(src, previewPath);

      const result = await validateAvifOutput(previewPath, PREVIEW_LONG_EDGE_PX);
      expect(result.ok).toBe(true);

      const entries = await fs.readdir(dir);
      expect(entries.filter((n) => n.includes('.tmp.'))).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
