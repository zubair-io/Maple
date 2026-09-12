/**
 * Cross-decoder oracle for #3506's encoders: everything Maple writes is read
 * back by *sharp* — libvips/libjpeg-turbo/libpng/libtiff/libheif — rather than
 * by the Rust crate that wrote it.
 *
 * This is the gate the branch was missing. Every other round-trip test uses
 * the encoding crate as its own decoder, so two real defects passed clean:
 * AVIF written at 10-bit (undecodable by libheif) and a TIFF horizontal
 * predictor on `compression: 'none'`/`'packbits'` (the `tiff` crate
 * un-differences whatever tag 317 claims, so encoder and decoder cancelled the
 * corruption out).
 *
 * sharp is a devDependency of `src/api`, not of this package — `@justmaple/maple`
 * exists to *replace* it and must not depend on it. So it is resolved out of
 * that workspace and, when it is not installed there (a fresh clone, a CI job
 * that only builds this package), the suite prints a loud banner and passes
 * rather than failing on a missing oracle.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

const repoRoot = path.resolve(__dirname, '../../..');

/** sharp from `src/api`'s node_modules, or null when it isn't installed. */
function loadSharp(): SharpModule | null {
  try {
    const resolved = require.resolve('sharp', { paths: [path.join(repoRoot, 'src/api')] });
    return require(resolved) as SharpModule;
  } catch {
    return null;
  }
}

type SharpInstance = {
  metadata(): Promise<{ channels: number; hasAlpha: boolean; depth: string; format: string }>;
  raw(): { toBuffer(): Promise<Buffer> };
  jpeg(options: Record<string, unknown>): { toBuffer(): Promise<Buffer> };
  avif(options: Record<string, unknown>): { toBuffer(): Promise<Buffer> };
  tiff(options: Record<string, unknown>): { toBuffer(): Promise<Buffer> };
};
type SharpModule = (input: Buffer, options?: Record<string, unknown>) => SharpInstance;

const sharp = loadSharp();

const W = 64;
const H = 64;

/** Deterministic gradient plus a structured high-frequency channel. */
function source(channels: 3 | 4): Uint8Array {
  const data = new Uint8Array(W * H * channels);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * channels;
      data[i] = (x * 4) & 0xff;
      data[i + 1] = (y * 4) & 0xff;
      data[i + 2] = (x * y) % 251;
      if (channels === 4) {
        data[i + 3] = x < W / 2 ? 255 : 64;
      }
    }
  }
  return data;
}

/**
 * A representative source for the *lossy* comparisons: a gradient with
 * bounded per-pixel noise, i.e. the shape of real photographic content.
 *
 * `source()` above deliberately alternates chroma every pixel (its blue
 * channel is `(x * y) % 251`, a wrap-around moiré), which is the right
 * stressor for a byte-exact lossless round-trip and the wrong one for a
 * perceptual budget: it punishes 4:2:0 chroma downsampling far harder than
 * any photograph does. Measured, Maple minus sharp at 4:2:0 is -0.09 dB on
 * this source and -1.18 dB on that one, while at 4:4:4 — no chroma
 * downsampling at all — both sources give 0.00 dB. See #3584.
 */
function photographic(): Uint8Array {
  const data = new Uint8Array(W * H * 3);
  let state = 7;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = ((state >>> 22) & 31) - 16;
      const clamp = (v: number) => Math.max(0, Math.min(255, v));
      const i = (y * W + x) * 3;
      data[i] = clamp(x * 4 + noise);
      data[i + 1] = clamp(y * 4 + noise);
      data[i + 2] = clamp(128 + ((x + y) >> 1) + noise);
    }
  }
  return data;
}

const rgb = source(3);
const rgba = source(4);
const photo = photographic();

function psnr(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const mse = sum / n;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

/**
 * One tag's first value out of a little/big-endian TIFF's first IFD. Short
 * values live inline in the entry, which is all any tag asserted here uses.
 */
function tiffTag(bytes: Buffer, wanted: number): number | null {
  const le = bytes[0] === 0x49;
  const u16 = (o: number) => (le ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number) => (le ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === wanted) {
      return u16(entry + 8);
    }
  }
  return null;
}

/** Bits-per-channel out of an AVIF's `pixi` box. */
function pixiDepths(bytes: Buffer): number[] {
  const at = bytes.indexOf(Buffer.from('pixi'));
  if (at < 0) return [];
  return Array.from(bytes.subarray(at + 9, at + 9 + bytes[at + 8]));
}

if (sharp === null) {
  const banner =
    '\n' +
    '='.repeat(78) +
    '\n  SKIPPED: the cross-decoder oracle needs sharp under src/api/node_modules.\n' +
    '  Encoder output was NOT verified against libvips/libtiff/libheif.\n' +
    `  Install it with:  cd ${path.join(repoRoot, 'src/api')} && bun install\n` +
    '='.repeat(78) +
    '\n';
  describe('Cross-decoder oracle', () => {
    it('is skipped because sharp is not installed under src/api', () => {
      console.warn(banner);
      expect(sharp).toBeNull();
    });
  });
} else {
  const readSharp = async (bytes: Buffer) => {
    const meta = await sharp(bytes).metadata();
    const raw = await sharp(bytes).raw().toBuffer();
    return { meta, raw: new Uint8Array(raw) };
  };
  const fromRaw = (data: Uint8Array, channels: 3 | 4) =>
    sharp(Buffer.from(data), { raw: { width: W, height: H, channels } });

  describe('Cross-decoder oracle (sharp reads Maple)', () => {
    it('PNG is byte-exact through libpng, RGB and RGBA', async () => {
      for (const [data, channels] of [
        [rgb, 3],
        [rgba, 4],
      ] as const) {
        const bytes = await maple({ data, width: W, height: H, channels }).png().toBuffer();
        const { meta, raw } = await readSharp(bytes);
        expect(meta.format).toBe('png');
        expect(meta.channels).toBe(channels);
        expect(meta.hasAlpha).toBe(channels === 4);
        expect(raw).toEqual(data);
      }
    });

    it('WebP lossless is byte-exact through libwebp, RGB and RGBA', async () => {
      for (const [data, channels] of [
        [rgb, 3],
        [rgba, 4],
      ] as const) {
        const bytes = await maple({ data, width: W, height: H, channels }).webp().toBuffer();
        const { meta, raw } = await readSharp(bytes);
        expect(meta.format).toBe('webp');
        expect(meta.channels).toBe(channels);
        expect(raw).toEqual(data);
      }
    });

    // The C2 gate. libtiff reads the differenced bytes straight back as
    // pixels when tag 317 is set on a compressor TIFF does not define it for,
    // so a predictor leaking onto `none`/`packbits` shows up here — and only
    // here — as a non-exact round-trip.
    it('TIFF is byte-exact through libtiff for every compressor', async () => {
      const expectedTags: Array<[string, number, number]> = [
        // compression, tag 259 (Compression), tag 317 (Predictor)
        ['none', 1, 1],
        ['lzw', 5, 2],
        ['deflate', 8, 2],
        ['packbits', 0x8005, 1],
      ];
      for (const [compression, tag259, tag317] of expectedTags) {
        const bytes = await maple({ data: rgb, width: W, height: H, channels: 3 })
          .tiff({ compression: compression as 'none' })
          .toBuffer();
        expect(tiffTag(bytes, 259)).toBe(tag259);
        expect(tiffTag(bytes, 317)).toBe(tag317);
        const { meta, raw } = await readSharp(bytes);
        expect(meta.channels).toBe(3);
        expect(raw).toEqual(rgb);
      }
    });

    // The C4 gate: the same ExtraSamples declaration sharp itself writes.
    it('TIFF carries alpha the way sharp does', async () => {
      const bytes = await maple({ data: rgba, width: W, height: H, channels: 4 })
        .tiff({ compression: 'none' })
        .toBuffer();
      expect(tiffTag(bytes, 277)).toBe(4); // SamplesPerPixel
      expect(tiffTag(bytes, 338)).toBe(2); // ExtraSamples: unassociated alpha
      expect(tiffTag(bytes, 317)).toBe(1); // no predictor on the alpha path
      const { meta, raw } = await readSharp(bytes);
      expect(meta.channels).toBe(4);
      expect(meta.hasAlpha).toBe(true);
      expect(raw).toEqual(rgba);

      // Same declaration in sharp's own RGBA TIFF, which is the claim the
      // README makes: not "Maple writes some alpha tag" but "Maple writes
      // the tag libvips writes".
      const theirs = await fromRaw(rgba, 4).tiff({ compression: 'none' }).toBuffer();
      expect(tiffTag(theirs, 277)).toBe(tiffTag(bytes, 277));
      expect(tiffTag(theirs, 338)).toBe(tiffTag(bytes, 338));
    });

    // The C1 gate. A 10-bit AVIF is not merely lower quality to libheif —
    // it fails to decode at all ("Bitstream not supported by this decoder"),
    // so the assertion that matters is that this resolves.
    it('AVIF decodes through libheif at 8-bit, RGB and RGBA', async () => {
      for (const [data, channels] of [
        [rgb, 3],
        [rgba, 4],
      ] as const) {
        const bytes = await maple({ data, width: W, height: H, channels })
          .avif({ quality: 60 })
          .toBuffer();
        expect(pixiDepths(bytes).every((d) => d === 8)).toBe(true);
        const { meta } = await readSharp(bytes);
        expect(meta.format).toBe('heif');
        expect(meta.depth).toBe('uchar');
        expect(meta.channels).toBe(channels);
        expect(meta.hasAlpha).toBe(channels === 4);
      }
    });

    it('JPEG is within 0.5 dB of sharp at matched quality and chroma', async () => {
      const cases: Array<[number, '4:2:0' | '4:4:4']> = [
        [50, '4:2:0'],
        [80, '4:2:0'],
        [80, '4:4:4'],
        [95, '4:4:4'],
      ];
      for (const [quality, chromaSubsampling] of cases) {
        const mine = await maple({ data: photo, width: W, height: H, channels: 3 })
          .jpeg({ quality, chromaSubsampling })
          .toBuffer();
        const theirs = await fromRaw(photo, 3).jpeg({ quality, chromaSubsampling }).toBuffer();
        const [minePixels, theirPixels] = await Promise.all([readSharp(mine), readSharp(theirs)]);
        expect(minePixels.meta.channels).toBe(3);
        const mineDb = psnr(minePixels.raw, photo);
        const theirDb = psnr(theirPixels.raw, photo);
        expect(mineDb).toBeGreaterThanOrEqual(theirDb - 0.5);
      }
    });

    /**
     * AVIF does NOT reach the 0.5 dB bar the other lossy container does, and
     * this test pins how far short it falls rather than pretending otherwise.
     *
     * The gap was invisible until the bit depth was pinned to 8 — before
     * that, libheif could not decode Maple's AVIF at all, so no comparison
     * against libaom was possible. Measured deltas on this source (Maple
     * minus sharp): -1.42 dB at quality 50, -6.49 dB at quality 80. Likely
     * causes are `ColorModel::RGB` (three correlated planes, no YCbCr
     * decorrelation) and `ravif`'s own quality-to-quantizer curve; tracked
     * as #3583.
     *
     * These budgets are a ONE-WAY RATCHET, like `test-fixtures/budgets.json`:
     * tightening one happens in the same commit that delivers the
     * improvement. A regression past them fails here.
     */
    const AVIF_PSNR_BUDGET_DB: Record<number, number> = { 50: 1.6, 80: 7.0 };

    it('AVIF fidelity stays inside its measured gap against sharp (#3583)', async () => {
      for (const quality of [50, 80]) {
        const mine = await maple({ data: photo, width: W, height: H, channels: 3 })
          .avif({ quality })
          .toBuffer();
        const theirs = await fromRaw(photo, 3).avif({ quality }).toBuffer();
        const [minePixels, theirPixels] = await Promise.all([readSharp(mine), readSharp(theirs)]);
        const mineDb = psnr(minePixels.raw, photo);
        const theirDb = psnr(theirPixels.raw, photo);
        const shortfall = theirDb - mineDb;
        expect(shortfall).toBeLessThanOrEqual(AVIF_PSNR_BUDGET_DB[quality]);
      }
    });
  });
}
