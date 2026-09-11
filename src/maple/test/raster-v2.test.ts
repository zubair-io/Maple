import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * Gate for the second-generation raster surface (#3498, #3513): raw pixel
 * input, `toRaw()`, cover fit, the resampling-filter option, AVIF effort, and
 * AVIF decode. Split out of `maple.test.ts` to keep both files inside the
 * repo's file-size budget.
 */
describe('Raster v2 surface', () => {
  const solid = (w: number, h: number, rgb: [number, number, number]) => ({
    data: new Uint8Array(Array.from({ length: w * h }, () => rgb).flat()),
    width: w,
    height: h,
    channels: 3 as const,
  });

  it('accepts raw pixel input and encodes it', async () => {
    const png = await maple(solid(8, 4, [10, 20, 30]))
      .toFormat('png')
      .toBuffer();
    const meta = await maple(png).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([8, 4, 'png']);
  });

  it('cover fit produces the exact box', async () => {
    const png = await maple(solid(40, 20, [1, 2, 3]))
      .toFormat('png')
      .toBuffer();
    const out = await maple(png)
      .resize({ width: 10, height: 10, fit: 'cover' })
      .toFormat('png')
      .toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height]).toEqual([10, 10]);
  });

  it('toRaw returns native-size RGB8', async () => {
    const png = await maple(solid(6, 5, [90, 90, 90]))
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRaw();
    expect([raw.width, raw.height, raw.channels, raw.data.length]).toEqual([6, 5, 3, 90]);
    expect(raw.data.every((b) => b === 90)).toBe(true);
  });

  it('decodes AVIF for metadata, transcode and integrity', async () => {
    const avif = await maple(solid(24, 16, [200, 50, 50]))
      .toFormat('avif', { quality: 60, effort: 2 })
      .toBuffer();
    const meta = await maple(avif).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([24, 16, 'avif']);
    const jpeg = await maple(avif).toFormat('jpeg', { quality: 90 }).toBuffer();
    expect(jpeg[0]).toBe(0xff);
    expect(await maple(avif).validateIntegrity()).toBe(true);
    expect(await maple(avif.subarray(0, 40)).validateIntegrity()).toBe(false);
  });

  it('recovers a truncated JPEG', async () => {
    const jpeg = await maple(solid(64, 48, [30, 60, 90]))
      .toFormat('jpeg', { quality: 90 })
      .toBuffer();
    const sos = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === 0xda);
    const cut = jpeg.subarray(0, sos + Math.floor((jpeg.length - sos) * 0.6));
    const out = await maple(cut).resize(32, 32).toFormat('png').toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height]).toEqual([32, 24]);
  });

  /**
   * Minimal APP1 EXIF segment carrying a single IFD0 entry: Orientation
   * (tag 0x0112, SHORT) = `orientation`. Spliced in right after the SOI
   * marker, which is where a camera writes it.
   */
  const withExifOrientation = (jpeg: Buffer, orientation: number) => {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii'); // little-endian TIFF header
    tiff.writeUInt16LE(0x2a, 2);
    tiff.writeUInt32LE(8, 4); // IFD0 starts right after the header
    tiff.writeUInt16LE(1, 8); // one entry
    tiff.writeUInt16LE(0x0112, 10); // Orientation
    tiff.writeUInt16LE(3, 12); // type SHORT
    tiff.writeUInt32LE(1, 14); // count
    tiff.writeUInt16LE(orientation, 18); // inline value
    tiff.writeUInt32LE(0, 22); // no next IFD
    const header = Buffer.alloc(4);
    header.writeUInt16BE(0xffe1, 0); // APP1
    header.writeUInt16BE(2 + 6 + tiff.length, 2); // segment length
    const app1 = Buffer.concat([header, Buffer.from('Exif\0\0', 'binary'), tiff]);
    return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
  };

  it('toRaw with rotate() honours EXIF orientation 6', async () => {
    const jpeg = await maple(solid(24, 12, [70, 80, 90]))
      .toFormat('jpeg', { quality: 90 })
      .toBuffer();
    const rotated = withExifOrientation(jpeg, 6);
    // Proves the fixture: the probe reads the spliced-in tag.
    expect((await maple(rotated).metadata()).orientation).toBe(6);

    const raw = await maple(rotated).rotate().toRaw();
    expect([raw.width, raw.height, raw.channels]).toEqual([12, 24, 3]);
    expect(raw.data.length).toBe(12 * 24 * 3);

    // Without rotate() the native orientation is kept.
    const asShot = await maple(rotated).toRaw();
    expect([asShot.width, asShot.height]).toEqual([24, 12]);
  });

  /**
   * A stubbed RGB8 decode entry that records the capacity of every call it
   * receives, so the number of decodes and the size of each allocation are
   * observable. It always reports a 2x3 image (18 bytes of RGB8). `ptr` is
   * wired to the identity function below, so the stub gets the real Buffers.
   */
  const decodeRecorder = () => {
    const capacities: number[] = [];
    const lib = {
      symbols: {
        maple_raster_decode_rgb8_buf: (...args: unknown[]) => {
          const [, , , outBuf, cap, outLen, w, h] = args as [
            unknown,
            unknown,
            unknown,
            Buffer | null,
            bigint,
            Buffer,
            Buffer,
            Buffer,
          ];
          capacities.push(Number(cap));
          outLen.writeBigUInt64LE(BigInt(2 * 3 * 3), 0);
          w.writeUInt32LE(2, 0);
          h.writeUInt32LE(3, 0);
          if (!outBuf || Number(cap) < 18) return 100;
          outBuf.fill(7);
          return 0;
        },
      },
    };
    return { capacities, lib };
  };

  const identity = (buf: Uint8Array) => buf;

  const stubProbe = (metadata: Record<string, unknown> | null) => () =>
    metadata
      ? { ok: true, metadata: metadata as never }
      : { ok: false, error: 'unsupported header' };

  it('calls the RGB8 decoder once when the metadata probe can size the output', async () => {
    const { createRasterV2Binding } = await import('../src/native-raster-v2.ts');
    const { capacities, lib } = decodeRecorder();
    const sized = createRasterV2Binding(
      lib as never,
      identity,
      () => null,
      stubProbe({ width: 2, height: 3, channels: 3, orientation: 1, format: 'png' }),
    );
    const res = sized.rasterDecodeRgb8Buf(new Uint8Array([1, 2, 3]), false);
    expect([res.ok, res.width, res.height, res.buffer?.length]).toEqual([true, 2, 3, 18]);
    expect(capacities).toEqual([18]);

    // A probe that cannot size the input falls back to the two-call
    // protocol: one null-buffer sizing call, then the real decode.
    capacities.length = 0;
    const unsized = createRasterV2Binding(lib as never, identity, () => null, stubProbe(null));
    const fallback = unsized.rasterDecodeRgb8Buf(new Uint8Array([1, 2, 3]), false);
    expect(fallback.ok).toBe(true);
    expect(capacities).toEqual([0, 18]);
  });

  it('never allocates from an absurd or RAW header, falling back to the size probe', async () => {
    const { createRasterV2Binding } = await import('../src/native-raster-v2.ts');
    // Header dimensions arrive before any decoder has validated the file, so
    // they are never trusted to size an allocation past the ceiling: 1e10
    // pixels must not reach `Buffer.alloc`. A RAW header probes fine through
    // the TIFF dimension parser but has no path through this decoder, so it
    // must not pre-allocate ~300 MB on the way to an error either.
    for (const metadata of [
      { width: 100000, height: 100000, channels: 3, orientation: 1, format: 'tiff' },
      { width: 11648, height: 8736, channels: 3, orientation: 1, format: 'dng' },
    ]) {
      const { capacities, lib } = decodeRecorder();
      const binding = createRasterV2Binding(
        lib as never,
        identity,
        () => null,
        stubProbe(metadata),
      );
      const res = binding.rasterDecodeRgb8Buf(new Uint8Array([1, 2, 3]), false);
      expect(res.ok).toBe(true);
      // First call is the null-buffer size probe (capacity 0), not a
      // header-sized allocation.
      expect(capacities).toEqual([0, 18]);
    }
  });

  it('encodes AVIF at both ends of the effort range', async () => {
    for (const effort of [0, 9]) {
      const avif = await maple(solid(24, 16, [120, 60, 30]))
        .toFormat('avif', { quality: 50, effort })
        .toBuffer();
      const meta = await maple(avif).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([24, 16, 'avif']);
    }
  });

  it('maps the filter option to different resampling kernels', async () => {
    const src = await maple({
      data: new Uint8Array(
        Array.from({ length: 32 * 32 }, (_, i) => {
          const x = i % 32;
          const y = Math.floor(i / 32);
          return (x + y) % 2 === 0 ? [255, 0, 0] : [0, 0, 255];
        }).flat(),
      ),
      width: 32,
      height: 32,
      channels: 3 as const,
    })
      .toFormat('png')
      .toBuffer();

    const resized = async (filter: 'nearest' | 'lanczos3') =>
      maple(src).resize({ width: 9, height: 9, filter }).toFormat('png').toBuffer();
    const nearest = await resized('nearest');
    const lanczos = await resized('lanczos3');
    expect(nearest.equals(lanczos)).toBe(false);

    const pixels = async (png: Buffer) => (await maple(png).toRaw()).data;
    expect(Buffer.from(await pixels(nearest)).equals(Buffer.from(await pixels(lanczos)))).toBe(
      false,
    );
  });

  it('a second resize() replaces the pending one instead of stacking two resamples', async () => {
    const src = await maple(solid(64, 64, [12, 34, 56]))
      .toFormat('png')
      .toBuffer();
    const stacked = await maple(src).resize(32, 32).resize(16, 16).toFormat('png').toBuffer();
    const direct = await maple(src).resize(16, 16).toFormat('png').toBuffer();
    expect(Buffer.from(stacked).equals(Buffer.from(direct))).toBe(true);
  });

  it('infers the toFile output format from the extension when none is set', async () => {
    const png = await maple(solid(8, 8, [50, 60, 70]))
      .toFormat('png')
      .toBuffer();
    const outPath = `/tmp/maple_infer_${Date.now()}_${Math.random().toString(36).slice(2)}.webp`;
    try {
      const res = await maple(png).resize(4, 4).toFile(outPath);
      expect(res.ok).toBe(true);
      const meta = await maple(outPath).metadata();
      expect(meta.format).toBe('webp');
    } finally {
      const fs = await import('node:fs/promises');
      await fs.unlink(outPath).catch(() => {});
    }
  });
});
