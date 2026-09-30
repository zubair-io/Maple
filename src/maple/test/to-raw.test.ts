import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maple } from '../src/index.ts';
import { maple as publishedMaple } from '../dist/index.js';

const source = {
  data: new Uint8Array([255, 0, 0, 77, 0, 255, 0, 128, 0, 0, 255, 0, 40, 50, 60, 255]),
  width: 2,
  height: 2,
  channels: 4 as const,
};

describe('toRaw recipe execution (#3579)', () => {
  it('executes queued edits through the compiled public package entry point', async () => {
    const png = await maple(source).png().toBuffer();
    const image = publishedMaple(png).extract({ left: 0, top: 0, width: 1, height: 1 }).greyscale();
    const output = await image.toRaw();
    expect([output.width, output.height, output.channels]).toEqual([1, 1, 3]);
    expect(Array.from(output.data)).toEqual([127, 127, 127]);
    const alpha = await image.toRawAlpha();
    expect(Array.from(alpha.data)).toEqual([127, 127, 127, 77]);
  });
  it('runs colour operations on raw and encoded inputs before dropping alpha', async () => {
    const png = await maple(source).png().toBuffer();
    for (const input of [source, png]) {
      const out = await maple(input)
        .extract({ left: 0, top: 0, width: 1, height: 1 })
        .greyscale()
        .toRaw();
      expect([out.width, out.height, out.channels]).toEqual([1, 1, 3]);
      expect(Array.from(out.data)).toEqual([127, 127, 127]);
    }
  });

  it('resizes a file input and keeps the original file intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maple-to-raw-'));
    try {
      const png = await maple(source).png().toBuffer();
      const path = join(root, 'input.png');
      await writeFile(path, png);
      const out = await maple(path)
        .resize({
          width: 4,
          height: 4,
          fit: 'fill',
          kernel: 'nearest',
          withoutEnlargement: false,
        })
        .toRaw();
      expect([out.width, out.height, out.channels, out.data.length]).toEqual([4, 4, 3, 48]);
      expect(Array.from(out.data.subarray(0, 3))).toEqual([255, 0, 0]);
      expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(png)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('composites before discarding alpha and does not mutate repeated terminal calls', async () => {
    const overlay = await maple({
      data: new Uint8Array([0, 0, 255, 255]),
      width: 1,
      height: 1,
      channels: 4,
    })
      .png()
      .toBuffer();
    const builder = maple(source).composite([{ input: overlay, left: 0, top: 0 }]);
    const first = await builder.toRaw();
    const second = await builder.toRaw();
    expect(Array.from(first.data.subarray(0, 3))).toEqual([0, 0, 255]);
    expect(second).toEqual(first);
    const alpha = await builder.toRawAlpha();
    expect(alpha.channels).toBe(4);
    expect(alpha.data[7]).toBe(128);
  });

  it('honours gamma held outside the op list and a configured encoded output', async () => {
    const out = await maple({
      data: new Uint8Array([128, 128, 128]),
      width: 1,
      height: 1,
      channels: 3,
    })
      .gamma(1, 2)
      .jpeg({ quality: 1 })
      .toRaw();
    expect(Array.from(out.data)).toEqual([180, 180, 180]);
    expect(out.channels).toBe(3);
  });

  it('drops straight alpha without flattening transparent RGB', async () => {
    const out = await maple(source).toRaw();
    expect([out.width, out.height, out.channels]).toEqual([2, 2, 3]);
    expect(Array.from(out.data)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 40, 50, 60]);
  });
});
