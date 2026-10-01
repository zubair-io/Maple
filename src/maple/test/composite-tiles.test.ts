import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';
import type { CompositeLayer } from '../src/types.ts';
import { loadSharpOracle, type SharpCompositeFactory } from './support/sharp-oracle.ts';

const sharp = loadSharpOracle() as SharpCompositeFactory | null;
const gravities = [
  'centre',
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

function pattern(width: number, height: number, channels: 3 | 4) {
  const data = Buffer.from(
    Array.from({ length: width * height * channels }, (_, i) =>
      channels === 4 && i % 4 === 3
        ? [0, 5, 64, 128, 254, 255][Math.floor(i / 4) % 6]
        : (i * 47 + 19) % 256,
    ),
  );
  return { data, width, height, channels };
}

async function compareTile(
  width: number,
  height: number,
  options: Omit<CompositeLayer, 'input'>,
  channels: 3 | 4,
) {
  const base = pattern(width, height, 4);
  const overlay = pattern(2, 3, channels);
  const output = await maple(base)
    .composite([{ input: overlay, ...options }])
    .png()
    .toBuffer();
  const mine = (await maple(output).toRawAlpha()).data;
  const theirs = await sharp!(base.data, { raw: base })
    .composite([{ input: overlay.data, raw: overlay, ...options }])
    .raw()
    .toBuffer();
  expect(mine.length).toBe(theirs.length);
  expect(
    mine.reduce((max, value, i) => Math.max(max, Math.abs(value - theirs[i])), 0),
  ).toBeLessThanOrEqual(channels === 3 ? 0 : 1);
}

describe('Tiled composite gravity parity', () => {
  for (const gravity of gravities) {
    it.skipIf(sharp === null)(
      `${gravity}: patterned RGB/RGBA tiles match Sharp on odd/even extents`,
      async () => {
        for (const [width, height] of [
          [8, 6],
          [7, 5],
          [8, 5],
          [7, 6],
        ]) {
          for (const channels of [3, 4] as const) {
            await compareTile(width, height, { gravity, tile: true }, channels);
          }
        }
      },
    );
  }

  it.skipIf(sharp === null)(
    'explicit crop offsets override gravity and clamp to the replicated extent',
    async () => {
      for (const gravity of gravities) {
        for (const [left, top] of [
          [0, 0],
          [1, 1],
          [5, 7],
          [2147483647, 2147483647],
        ]) {
          await compareTile(7, 5, { gravity, left, top, tile: true }, 3);
        }
      }
    },
  );

  it('rejects negative tiled crop offsets by name', async () => {
    const base = pattern(8, 6, 4);
    const input = pattern(2, 3, 4);
    await expect(
      maple(base)
        .composite([{ input, left: -1, top: 0, tile: true }])
        .png()
        .toBuffer(),
    ).rejects.toThrow(/tiled offset -1/);
  });
});
