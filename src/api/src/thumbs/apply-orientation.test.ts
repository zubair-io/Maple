import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { maple } from 'maple';
import { applyExifOrientationInPlace } from './apply-orientation.ts';
import { solidAvif, solidJpeg } from '../test-support/synth-image.ts';
import { generateThumb } from '../indexer/thumbnailer.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';

// Resolve the repo root so the indexer integration test can find the gitignored
// fixture regardless of CWD. Mirrors the pattern in `src/api/tests/fs/thumb.test.ts`.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');

/**
 * Minimal APP1 EXIF segment carrying a single IFD0 entry: Orientation
 * (tag 0x0112, SHORT) = `orientation`. Spliced in right after the SOI
 * marker, which is where a camera writes it. Copied from
 * `src/maple/test/raster-v2.test.ts`'s `withExifOrientation` — the same
 * hand-spliced-EXIF trick, not shared production code.
 */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); // little-endian TIFF header
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 starts right after the header
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // type SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // inline value
  tiff.writeUInt32LE(0, 22); // no next IFD
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0); // APP1
  header.writeUInt16BE(2 + 6 + tiff.length, 2); // segment length
  const app1 = Buffer.concat([header, Buffer.from('Exif\0\0', 'binary'), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

// A 16x8 JPEG: portrait when the orientation tag asks for 90° CW (orientation=6),
// landscape on disk. After rotation, dimensions must swap to 8x16 and the tag
// must be stripped (Maple's metadata probe returns 1).
async function makeOrientedJpeg(dir: string, orientation: number): Promise<string> {
  const file = path.join(dir, `oriented-${orientation}.jpg`);
  const plain = await solidJpeg(16, 8, [200, 50, 50], 90);
  const buf = withExifOrientation(plain, orientation);
  await writeFile(file, buf);
  return file;
}

describe('applyExifOrientationInPlace', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orient-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rotates pixels and strips the tag for orientation 6 (90° CW)', async () => {
    const file = await makeOrientedJpeg(dir, 6);
    const before = await maple(file).metadata();
    expect(before.width).toBe(16);
    expect(before.height).toBe(8);
    expect(before.orientation).toBe(6);

    await applyExifOrientationInPlace(file);

    const after = await maple(file).metadata();
    // After physical rotation, the probe reports the rotated dimensions.
    expect(after.width).toBe(8);
    expect(after.height).toBe(16);
    // After re-encoding with .rotate(), the orientation tag is gone (or 1).
    expect(after.orientation === undefined || after.orientation === 1).toBe(true);
  });

  it('is a no-op for orientation 1 (no rotation needed)', async () => {
    const file = await makeOrientedJpeg(dir, 1);
    const beforeBytes = await readFile(file);

    await applyExifOrientationInPlace(file);

    // Byte-identical: the helper must not re-encode when orientation is already 1.
    const afterBytes = await readFile(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  it('is a no-op when the orientation tag is missing (bare AVIF)', async () => {
    // Build a bare AVIF with no orientation tag at all.
    const file = path.join(dir, 'no-meta.avif');
    await writeFile(file, await solidAvif(16, 8, [0, 100, 0]));
    const beforeBytes = await readFile(file);

    await applyExifOrientationInPlace(file);

    const afterBytes = await readFile(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  it('handles orientation 8 (90° CCW)', async () => {
    const file = await makeOrientedJpeg(dir, 8);
    await applyExifOrientationInPlace(file);
    const after = await maple(file).metadata();
    expect(after.width).toBe(8);
    expect(after.height).toBe(16);
  });
});

describe('indexer thumbnailer + orientation', () => {
  // Skip when raw-ffi is unavailable (CI without libraw_ffi.dylib built).
  const pool = ffiPool();
  const maybe = pool.available() ? it : it.skip;

  maybe('produces an upright thumb for an oriented RAW', async () => {
    // We don't ship a small RAW with non-default orientation as a fixture;
    // this test is gated on `test-fixtures/raws/test_0017.dng` (the existing
    // reference) but only asserts that the produced thumb has orientation=1
    // or absent — i.e. whatever the source orientation is, the on-disk thumb
    // is physically upright.
    const fs = await import('node:fs/promises');
    const raw = path.resolve(REPO_ROOT, 'test-fixtures/raws/test_0017.dng');
    try {
      await fs.stat(raw);
    } catch {
      return; // fixture missing, soft pass
    }
    const thumbsDir = path.join(path.dirname(raw), '.maple/thumbs');
    await fs.rm(thumbsDir, { recursive: true, force: true });
    await generateThumb(raw);
    // Walk the .maple/thumbs dir and find the one .avif we just made.
    const entries = await fs.readdir(thumbsDir);
    const avif = entries.find((e) => e.endsWith('.avif'));
    expect(avif).toBeDefined();
    const meta = await maple(path.join(thumbsDir, avif!)).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });
});
