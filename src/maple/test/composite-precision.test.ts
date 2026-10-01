import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';
import { loadSharpOracle, type SharpCompositeFactory } from './support/sharp-oracle.ts';

const sharp = loadSharpOracle() as SharpCompositeFactory | null;
const pixel = (values: number[]) => ({
  data: Buffer.from(values),
  width: 1,
  height: 1,
  channels: 4 as const,
});

function patterned(width: number, height: number, seed: number, channels: 3 | 4 = 4) {
  const data = Buffer.from(
    Array.from({ length: width * height * channels }, (_, i) =>
      channels === 4 && i % channels === 3
        ? [0, 1, 5, 16, 64, 127, 254, 255][(Math.floor(i / channels) + seed) % 8]
        : (i * 37 + seed * 71) % 256,
    ),
  );
  return { data, width, height, channels };
}

function withinOneByte(mine: Uint8Array, theirs: Uint8Array) {
  expect(mine.length).toBe(theirs.length);
  const worst = mine.reduce((max, value, i) => Math.max(max, Math.abs(value - theirs[i])), 0);
  expect(worst).toBeLessThanOrEqual(1);
}

describe('Composite layer precision', () => {
  it('preserves low-alpha contributions until the last layer', async () => {
    const base = pixel([162, 143, 17, 5]);
    const inputs = [
      [157, 237, 15, 6],
      [201, 220, 107, 7],
      [51, 16, 25, 8],
    ].map(pixel);
    const output = await maple(base)
      .composite(inputs.map((input) => ({ input })))
      .png()
      .toBuffer();
    expect(Array.from((await maple(output).toRawAlpha()).data)).toEqual([136, 144, 43, 25]);
  });

  it.skipIf(sharp === null)(
    'agrees with libvips on three overlapping low-alpha layers',
    async () => {
      const base = pixel([162, 143, 17, 5]);
      const inputs = [
        [157, 237, 15, 6],
        [201, 220, 107, 7],
        [51, 16, 25, 8],
      ].map(pixel);
      const output = await maple(base)
        .composite(inputs.map((input) => ({ input })))
        .png()
        .toBuffer();
      const theirs = await sharp!(base.data, { raw: base })
        .composite(inputs.map((raw) => ({ input: raw.data, raw })))
        .raw()
        .toBuffer();
      withinOneByte((await maple(output).toRawAlpha()).data, theirs);
    },
  );

  it.skipIf(sharp === null)('translucent separable blends match libvips', async () => {
    const base = pixel([100, 50, 25, 128]);
    const input = pixel([200, 100, 50, 128]);
    for (const blend of ['multiply', 'screen', 'darken', 'lighten'] as const) {
      const output = await maple(base).composite([{ input, blend }]).png().toBuffer();
      const theirs = await sharp!(base.data, { raw: base })
        .composite([{ input: input.data, raw: input, blend }])
        .raw()
        .toBuffer();
      withinOneByte((await maple(output).toRawAlpha()).data, theirs);
    }
  });

  for (const blend of ['over', 'multiply', 'screen', 'darken', 'lighten', 'add'] as const) {
    it.skipIf(sharp === null)(
      `${blend}: multiple layers, offsets, RGB and tiles match libvips`,
      async () => {
        const base = patterned(8, 6, 2);
        const inputs = [patterned(8, 6, 3), patterned(3, 2, 1, 3), patterned(2, 3, 7)];
        const positions = [
          { left: 0, top: 0 },
          { left: 1, top: 2 },
          { left: 0, top: 0, tile: true },
        ];
        const output = await maple(base)
          .composite(inputs.map((input, i) => ({ input, blend, ...positions[i] })))
          .png()
          .toBuffer();
        const overlays: Record<string, unknown>[] = inputs.map((raw, i) => ({
          input: raw.data,
          raw,
          blend,
          ...positions[i],
        }));
        const theirs = await sharp!(base.data, { raw: base }).composite(overlays).raw().toBuffer();
        withinOneByte((await maple(output).toRawAlpha()).data, theirs);
      },
    );
  }
});
