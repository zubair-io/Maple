import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';
import { loadSharpOracle } from './support/sharp-oracle.ts';

const sharp = loadSharpOracle();

describe('AVIF colour signalling (#3580)', () => {
  it.skipIf(sharp === null)(
    'P3 RGB/RGBA output is colour-managed by an independent reader and Maple',
    async () => {
      for (const channels of [3, 4] as const) {
        const pixel = channels === 3 ? [210, 75, 40] : [210, 75, 40, 137];
        const source = {
          data: new Uint8Array(Array.from({ length: 256 }, () => pixel).flat()),
          width: 16,
          height: 16,
          channels,
        };
        const encoded = await maple(source)
          .toColourspace('display-p3')
          .avif({ quality: 100, effort: 0 })
          .toBuffer();
        const metadata = await sharp(encoded).metadata();
        expect(metadata.hasProfile).toBe(true);
        expect(metadata.icc.toString('latin1')).toContain('Display P3');
        const external = await sharp(encoded).withIccProfile('srgb').raw().toBuffer();
        const reopened = await maple(encoded).toRawAlpha();
        for (let at = 0; at < external.length; at++) {
          expect(Math.abs(external[at]! - source.data[at]!)).toBeLessThanOrEqual(3);
        }
        for (let at = 0; at < reopened.data.length; at++) {
          const expected =
            channels === 3 && reopened.channels === 4 && at % 4 === 3
              ? 255
              : pixel[at % reopened.channels]!;
          expect(Math.abs(reopened.data[at]! - expected)).toBeLessThanOrEqual(3);
        }
        const kept = await maple(encoded).keepMetadata().png().toBuffer();
        expect((await maple(kept).metadata()).icc!.toString('latin1')).toContain('sRGB');
      }
    },
  );
});
