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

describe('AVIF normalized-source metadata (#3580)', () => {
  it.skipIf(sharp === null)(
    'equivalent source ICC follows normalized pixels while source bytes stay intact',
    async () => {
      for (const channels of [3, 4] as const) {
        const pixel = channels === 3 ? [170, 100, 50] : [170, 100, 50, 137];
        const source = {
          data: new Uint8Array(Array.from({ length: 256 }, () => pixel).flat()),
          width: 16,
          height: 16,
          channels,
        };
        for (const profile of ['p3', 'srgb'] as const) {
          const encoded = Buffer.from(
            await maple(source)
              .withIccProfile(profile)
              .avif({ quality: 100, effort: 0 })
              .toBuffer(),
          );
          const equivalent = Buffer.from(encoded);
          const profileAt = equivalent.indexOf(Buffer.from('prof')) + 4;
          expect(profileAt).toBeGreaterThan(3);
          // ICC creator only: all matrix/TRC tags and AV1 samples stay unchanged.
          equivalent.write('Test', profileAt + 80, 'ascii');
          const preserved = Buffer.from(equivalent);
          const sourceProfile = (await maple(equivalent).metadata()).icc!;
          const managed = await sharp(encoded).withIccProfile('srgb').raw().toBuffer();
          const equivalentManaged = await sharp(equivalent).withIccProfile('srgb').raw().toBuffer();
          expect(equivalentManaged).toEqual(managed);
          const kept = await maple(equivalent).keepMetadata().png().toBuffer();
          const outputManaged = await sharp(kept).withIccProfile('srgb').raw().toBuffer();
          for (let at = 0; at < managed.length; at++) {
            expect(Math.abs(outputManaged[at]! - managed[at]!)).toBeLessThanOrEqual(3);
          }
          const outputProfile = (await maple(kept).metadata()).icc!;
          if (profile === 'p3') {
            expect(outputProfile.toString('latin1')).toContain('sRGB');
            expect(outputProfile).not.toEqual(sourceProfile);
          } else {
            expect(outputProfile).toEqual(sourceProfile);
          }
          expect(equivalent).toEqual(preserved);
          expect((await maple(equivalent).metadata()).icc).toEqual(sourceProfile);
        }
      }
    },
  );
});
