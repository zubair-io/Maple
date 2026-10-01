import { describe, expect, it } from 'bun:test';
import type { Sharp } from 'sharp';
import { maple } from '../src/index.ts';
import { loadSharpOracle } from './support/sharp-oracle.ts';

const sharp = loadSharpOracle() as typeof import('sharp') | null;
const source = {
  width: 32,
  height: 32,
  channels: 4 as const,
  data: new Uint8Array(
    Array.from({ length: 32 * 32 }, (_, i) => {
      const x = i % 32;
      return x < 8 ? [200, 10, 10, 255] : x < 24 ? [200, 180, 80, 64] : [0, 250, 0, 0];
    }).flat(),
  ),
};

type Maple = ReturnType<typeof maple>;
const filters: [string, (image: Maple) => Maple, (image: Sharp) => Sharp][] = [
  ['resize', (image) => image, (image) => image],
  ['threshold', (image) => image.threshold(128), (image) => image.threshold(128)],
  ['median', (image) => image.median(3), (image) => image.median(3)],
  ['blur', (image) => image.blur(1.5), (image) => image.blur(1.5)],
  ['sharpen', (image) => image.sharpen(), (image) => image.sharpen()],
  [
    'convolve',
    (image) =>
      image.convolve({
        width: 3,
        height: 3,
        kernel: Array(9).fill(1),
        scale: 9,
      }),
    (image) =>
      image.convolve({
        width: 3,
        height: 3,
        kernel: Array(9).fill(1),
        scale: 9,
      }),
  ],
  [
    'median-threshold-blur',
    (image) => image.median(3).threshold(128).blur(1.5),
    (image) => image.median(3).threshold(128).blur(1.5),
  ],
];

describe('resize and filters share alpha premultiplication (#3585)', () => {
  for (const kernel of [
    'nearest',
    'linear',
    'cubic',
    'mitchell',
    'lanczos2',
    'lanczos3',
  ] as const) {
    for (const [name, mapleFilter, sharpFilter] of filters) {
      it.skipIf(sharp === null)(`${kernel} resize + ${name} matches sharp`, async () => {
        const actual = await mapleFilter(maple(source).resize({ width: 16, kernel })).toRawAlpha();
        const expected = await sharpFilter(
          sharp!(Buffer.from(source.data), { raw: source }).resize({
            width: 16,
            kernel,
          }),
        )
          .toColourspace('srgb')
          .raw()
          .toBuffer();
        expect([actual.width, actual.height, actual.channels]).toEqual([16, 16, 4]);
        expect(Array.from(actual.data)).toEqual(Array.from(expected));
      });
    }
  }
});
