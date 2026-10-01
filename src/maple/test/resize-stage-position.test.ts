import { describe, expect, it } from 'bun:test';
import { maple, type ExtendOptions, type ExtractRegion, type ResizeOptions } from '../src/index.ts';
import { loadSharpOracle } from './support/sharp-oracle.ts';

interface SharpGeometryImage {
  resize(options: ResizeOptions): SharpGeometryImage;
  extract(region: ExtractRegion): SharpGeometryImage;
  extend(options: ExtendOptions): SharpGeometryImage;
  png(): { toBuffer(): Promise<Buffer> };
  raw(): {
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: { width: number; height: number; channels: number };
    }>;
  };
}

const sharp = loadSharpOracle() as
  | ((input: Buffer, options?: Record<string, unknown>) => SharpGeometryImage)
  | null;

const source = {
  data: Buffer.from(
    Array.from({ length: 16 * 16 }, (_, i) => [
      (i % 16) * 13,
      Math.floor(i / 16) * 13,
      (i * 17) % 256,
    ]).flat(),
  ),
  width: 16,
  height: 16,
  channels: 3 as const,
};
const firstSize = { width: 4, height: 4, fit: 'fill' as const, kernel: 'nearest' as const };
const finalSize = { width: 8, height: 8, fit: 'fill' as const, kernel: 'nearest' as const };
const crop = { left: 1, top: 1, width: 2, height: 2 };

async function expectSharpPixels(actual: Buffer, reference: SharpGeometryImage) {
  const pixels = await maple(actual).toRawAlpha();
  const expected = await reference.raw().toBuffer({ resolveWithObject: true });
  expect([pixels.width, pixels.height, pixels.channels]).toEqual([
    expected.info.width,
    expected.info.height,
    expected.info.channels,
  ]);
  expect(Array.from(pixels.data)).toEqual(Array.from(expected.data));
}

describe('repeated resize keeps its original geometry stage (#3554)', () => {
  it.skipIf(sharp === null)('keeps an intervening extract after the final resize', async () => {
    const input = await sharp!(source.data, { raw: source }).png().toBuffer();
    const actual = await maple(input)
      .resize(firstSize)
      .extract(crop)
      .resize(finalSize)
      .png()
      .toBuffer();
    await expectSharpPixels(
      actual,
      sharp!(input).resize(firstSize).extract(crop).resize(finalSize),
    );
  });

  it.skipIf(sharp === null)('keeps extracts on both sides of the resize stage', async () => {
    const input = await sharp!(source.data, { raw: source }).png().toBuffer();
    const preCrop = { left: 2, top: 2, width: 12, height: 12 };
    const actual = await maple(input)
      .extract(preCrop)
      .resize(firstSize)
      .extract(crop)
      .resize(finalSize)
      .png()
      .toBuffer();
    await expectSharpPixels(
      actual,
      sharp!(input).extract(preCrop).resize(firstSize).extract(crop).resize(finalSize),
    );
  });

  it.skipIf(sharp === null)('keeps padding after the final resize', async () => {
    const input = await sharp!(source.data, { raw: source }).png().toBuffer();
    const padding = { left: 2, bottom: 1, background: { r: 9, g: 17, b: 31 } };
    const actual = await maple(input)
      .resize(firstSize)
      .extend(padding)
      .resize(finalSize)
      .png()
      .toBuffer();
    await expectSharpPixels(
      actual,
      sharp!(input).resize(firstSize).extend(padding).resize(finalSize),
    );
  });
});
