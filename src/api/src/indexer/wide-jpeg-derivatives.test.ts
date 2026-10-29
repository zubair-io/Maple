/**
 * #5474: a JPEG wider than zune-jpeg's 16384 px default (a stitched drone
 * panorama) must still get its thumb and preview, and an original the decoder
 * genuinely refuses must surface as `SourceDecodeError` rather than as a
 * silent no-op. Real temp directories and the real FFI child pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { maple } from 'maple';
import { generateThumb } from './thumbnailer.ts';
import { generatePreview, PREVIEW_LONG_EDGE_PX } from './previewer.ts';
import { THUMB_LONG_EDGE_PX } from '../thumbs/render.ts';
import { SourceDecodeError } from '../thumbs/source-failure.ts';
import { solidJpeg } from '../test-support/synth-image.ts';
import { writeSettledFile } from '../test-support/settled-file.ts';

const PANORAMA_WIDTH = 19_000;
const PANORAMA_HEIGHT = 8;

let dir = '';
let panorama = '';
let undecodable = '';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wide-jpeg-'));
  panorama = path.join(dir, 'DJI_0483_D.JPG');
  await fs.writeFile(panorama, await solidJpeg(PANORAMA_WIDTH, PANORAMA_HEIGHT, [90, 140, 200]));
  undecodable = path.join(dir, 'broken.jpg');
  await writeSettledFile(undecodable, Buffer.from('\xff\xd8not a jpeg scan', 'latin1'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('derivatives for a JPEG wider than 16384 px', () => {
  it('writes a thumb whose long edge is the thumb size', async () => {
    const thumbPath = path.join(dir, 'thumbs', 'pano.avif');
    await generateThumb(panorama, thumbPath);
    const meta = await maple(thumbPath).metadata();
    expect(meta.width).toBe(THUMB_LONG_EDGE_PX);
  }, 60_000);

  it('writes a preview whose long edge is the preview size', async () => {
    const previewPath = path.join(dir, 'previews', 'pano.avif');
    await generatePreview(panorama, previewPath);
    const meta = await maple(previewPath).metadata();
    expect(meta.width).toBe(PREVIEW_LONG_EDGE_PX);
  }, 60_000);
});

describe('an original the decoder refuses', () => {
  it('throws SourceDecodeError from the thumb render and leaves no file', async () => {
    const thumbPath = path.join(dir, 'thumbs', 'broken.avif');
    await expect(generateThumb(undecodable, thumbPath)).rejects.toBeInstanceOf(SourceDecodeError);
    const entries = await fs.readdir(path.dirname(thumbPath));
    expect(entries.filter((name) => name.startsWith('broken.avif'))).toEqual([]);
  });

  it('throws SourceDecodeError from the preview render', async () => {
    const previewPath = path.join(dir, 'previews', 'broken.avif');
    await expect(generatePreview(undecodable, previewPath)).rejects.toBeInstanceOf(
      SourceDecodeError,
    );
  });
});
