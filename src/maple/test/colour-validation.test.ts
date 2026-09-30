import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';
import { maple as publishedMaple } from '../dist/index.js';
import type { Colour } from '../src/types.ts';

const pixel = {
  data: new Uint8Array([9, 8, 7]),
  width: 1,
  height: 1,
  channels: 3 as const,
};

describe('Colour validation', () => {
  it('validates colours through the compiled public package entry point', () => {
    expect(() => publishedMaple(pixel).flatten({ background: { r: 300, g: 0, b: 0 } })).toThrow(
      /Invalid colour channel r=300/,
    );
    expect(() =>
      publishedMaple(pixel).extend({ left: 1, background: { r: 1, g: 2, b: 3, alpha: NaN } }),
    ).toThrow(/Invalid colour alpha=NaN/);
  });
  it('rejects invalid RGB bytes at each public colour caller', () => {
    for (const field of ['r', 'g', 'b'] as const) {
      for (const invalid of [-1, 256, 300, 1.5, NaN, Infinity, -Infinity]) {
        const colour = { r: 1, g: 2, b: 3, [field]: invalid };
        const calls = [
          () => maple(pixel).flatten({ background: colour }),
          () => maple(pixel).resize({ width: 1, background: colour }),
          () => maple(pixel).extend({ left: 1, background: colour }),
          () => maple(pixel).rotate(45, { background: colour }),
          () => maple(pixel).trim({ background: colour }),
          () => maple(pixel).tint(colour),
        ];
        for (const call of calls) {
          expect(call).toThrow(`Invalid colour channel ${field}=${invalid}`);
        }
      }
    }
  });

  it('rejects invalid alpha before it can become a null or out-of-range byte', () => {
    for (const alpha of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
      expect(() => maple(pixel).flatten({ background: { r: 1, g: 2, b: 3, alpha } })).toThrow(
        `Invalid colour alpha=${alpha}`,
      );
    }
  });

  it('rejects malformed hex colours by name in the builder', () => {
    for (const background of ['#gggggg', '#12', '#ff0000zz', 'orange']) {
      expect(() => maple(pixel).flatten({ background })).toThrow(
        `Unrecognised colour '${background}'`,
      );
    }
  });

  it('rejects missing or non-numeric channel values from JavaScript callers', () => {
    for (const r of [undefined, null, '12']) {
      expect(() =>
        maple(pixel).flatten({ background: { r, g: 2, b: 3 } as unknown as Colour }),
      ).toThrow(`Invalid colour channel r=${r}`);
    }
  });

  it('rounds valid alpha and preserves RGB byte boundaries in a real PNG', async () => {
    const png = await maple(pixel)
      .extend({ left: 1, background: { r: 0, g: 255, b: 128, alpha: 0.5 } })
      .png()
      .toBuffer();
    const output = await maple(png).toRawAlpha();
    expect(output.channels).toBe(4);
    expect(Array.from(output.data)).toEqual([0, 255, 128, 128, 9, 8, 7, 255]);
  });

  it('accepts alpha endpoints and the default opaque alpha', async () => {
    for (const [alpha, byte] of [
      [0, 0],
      [1, 255],
      [undefined, 255],
    ] as const) {
      const png = await maple(pixel)
        .extend({ left: 1, background: { r: 0, g: 255, b: 128, alpha } })
        .png()
        .toBuffer();
      const output = await maple(png).toRawAlpha();
      expect(Array.from(output.data.subarray(0, output.channels))).toEqual(
        alpha === 0 ? [0, 255, 128, byte] : [0, 255, 128],
      );
    }
  });

  it('retains the preceding resize when a replacement colour is rejected', async () => {
    const input = { ...pixel, data: new Uint8Array(8 * 4 * 3).fill(64), width: 8, height: 4 };
    const builder = maple(input).resize(2);
    expect(() => builder.resize({ width: 4, background: { r: 300, g: 0, b: 0 } })).toThrow(
      /Invalid colour/,
    );
    const png = await builder.png().toBuffer();
    const output = await maple(png).toRawAlpha();
    expect([output.width, output.height]).toEqual([2, 1]);
  });
});
