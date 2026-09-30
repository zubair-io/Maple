import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maple } from 'maple';
import type { RawPixels } from 'maple';
import { renderImageThumbToFile } from './render.ts';
import { checkAvifOutput } from './avif-checks.ts';

// Every rotation produces distinct pixels, not just a different aspect ratio.
function ramp() {
  const width = 24;
  const height = 16;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([x * 10, y * 15, x * 3 + y * 5], (y * width + x) * 3);
    }
  }
  return { data, width, height, channels: 3 as const };
}

function rotatedPixels(decoded: RawPixels, orientation: number) {
  const quarterTurn = orientation !== 1;
  const width = quarterTurn ? decoded.height : decoded.width;
  const height = quarterTurn ? decoded.width : decoded.height;
  const position =
    orientation === 6
      ? (x: number, y: number) => [decoded.height - 1 - y, x]
      : orientation === 8
        ? (x: number, y: number) => [y, decoded.width - 1 - x]
        : (x: number, y: number) => [x, y];
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      const [ox, oy] = position(x, y);
      const start = (y * decoded.width + x) * 3;
      data.set(decoded.data.subarray(start, start + 3), (oy * width + ox) * 3);
    }
  }
  return { width, height, data };
}

describe('thumbnail orientation is resolved before AVIF publication (#3589)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maple-thumb-orientation-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const orientation of [1, 6, 8]) {
    it(`bakes JPEG orientation ${orientation} into AVIF pixels without changing the original`, async () => {
      const source = join(dir, 'source.jpg');
      const output = join(dir, 'thumb.avif');
      const bytes = await maple(ramp()).withMetadata({ orientation }).jpeg().toBuffer();
      await writeFile(source, bytes);
      const before = await stat(source);
      const decoded = await maple(source).toRaw();
      const expected = rotatedPixels(decoded, orientation);

      expect(await renderImageThumbToFile(source, output, 256, 'jpg')).toBe(true);
      const actual = await maple(output).toRaw();
      expect([actual.width, actual.height, actual.channels]).toEqual([
        expected.width,
        expected.height,
        3,
      ]);
      const error = actual.data.reduce(
        (sum, value, i) => sum + Math.abs(value - expected.data[i]),
        0,
      );
      // AVIF is lossy; the wrong rotation differs by >50 on this ramp.
      expect(error / expected.data.length).toBeLessThan(12);
      expect((await maple(output).metadata()).orientation).toBeUndefined();
      expect(await checkAvifOutput(output, 256)).toEqual({ ok: true });
      expect((await readFile(source)).equals(bytes)).toBe(true);
      expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);
    });
  }

  it('does not apply an AVIF Exif Orientation tag as a second rotation', async () => {
    const source = join(dir, 'source.avif');
    const output = join(dir, 'thumb.avif');
    const bytes = await maple(ramp()).withMetadata({ orientation: 6 }).avif().toBuffer();
    await writeFile(source, bytes);
    const metadata = await maple(source).metadata();
    expect(metadata.exif?.length).toBeGreaterThan(0);
    expect(metadata.orientation).toBeUndefined();
    expect(await renderImageThumbToFile(source, output, 256, 'avif')).toBe(true);
    const actual = await maple(output).metadata();
    expect([actual.width, actual.height]).toEqual([24, 16]);
    expect(actual.orientation).toBeUndefined();
    expect(await checkAvifOutput(output, 256)).toEqual({ ok: true });
    expect((await readFile(source)).equals(bytes)).toBe(true);
  });
});
