import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';
import { loadNativeBinding } from '../src/native.ts';

/** Gate for #3501: geometry ops through the real FFI, closed-form. */
describe('Geometry', () => {
  /** `w`x`h` where pixel (x, y) is `[x, y, 0]` — position is visible in bytes. */
  const coords = (w: number, h: number) => ({
    data: new Uint8Array(
      Array.from({ length: w * h }, (_, i) => [i % w, Math.floor(i / w), 0]).flat(),
    ),
    width: w,
    height: h,
    channels: 3 as const,
  });

  const png = (src: Parameters<typeof maple>[0]) => maple(src).toFormat('png').toBuffer();

  it('extract() takes the named window', async () => {
    const out = await maple(await png(coords(4, 4)))
      .extract({ left: 2, top: 1, width: 2, height: 2 })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect([raw.width, raw.height]).toEqual([2, 2]);
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([2, 1, 0]);
  });

  it('extend() pads with the requested background', async () => {
    const out = await maple(await png(coords(2, 2)))
      .extend({ left: 1, background: { r: 9, g: 8, b: 7 } })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect([raw.width, raw.height]).toEqual([3, 2]);
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([9, 8, 7]);
  });

  it('extend() with a transparent background produces RGBA', async () => {
    const out = await maple(await png(coords(2, 2)))
      .extend({ top: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(raw.channels).toBe(4);
    expect(raw.data[3]).toBe(0);
  });

  it('rotate(90) swaps the dimensions', async () => {
    const out = await maple(await png(coords(4, 2)))
      .rotate(90)
      .toFormat('png')
      .toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height]).toEqual([2, 4]);
  });

  it('rotate(-450) is the same as rotate(270)', async () => {
    const src = await png(coords(4, 2));
    const a = await maple(src).rotate(-450).toFormat('png').toBuffer();
    const b = await maple(src).rotate(270).toFormat('png').toBuffer();
    expect(a.equals(b)).toBe(true);
  });

  it('rotate() with no angle still means auto-orient', async () => {
    // Backwards compatibility with Tier 1: `.rotate()` = EXIF auto-orient.
    const src = await png(coords(4, 2));
    const out = await maple(src).rotate().toFormat('png').toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height]).toEqual([4, 2]);
  });

  it('flop() mirrors', async () => {
    const src = await png(coords(2, 1));
    const flopped = await maple(src).flop().toFormat('png').toBuffer();
    const raw = await maple(flopped).toRawAlpha();
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([1, 0, 0]);
  });

  it('flip() mirrors about the horizontal axis', async () => {
    // 1x2: row 0 is (0,0,0), row 1 is (0,1,0). Flipped, row 0 of the
    // output is the source's row 1.
    const src = await png(coords(1, 2));
    const flipped = await maple(src).flip().toFormat('png').toBuffer();
    const raw = await maple(flipped).toRawAlpha();
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([0, 1, 0]);
  });

  it('trim() removes a uniform border', async () => {
    const bordered = {
      data: new Uint8Array(
        Array.from({ length: 5 * 5 }, (_, i) => {
          const x = i % 5;
          const y = Math.floor(i / 5);
          return x >= 1 && x <= 3 && y >= 1 && y <= 3 ? [0, 0, 0] : [255, 255, 255];
        }).flat(),
      ),
      width: 5,
      height: 5,
      channels: 3 as const,
    };
    const out = await maple(await png(bordered))
      .trim()
      .toFormat('png')
      .toBuffer();
    const meta = await maple(out).metadata();
    expect([meta.width, meta.height]).toEqual([3, 3]);
  });

  it('rejects an unimplemented extendWith by name', async () => {
    await expect(
      maple(await png(coords(2, 2)))
        .extend({ left: 1, extendWith: 'mirror' as never })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/mirror/);
  });

  it('rejects trim lineArt by name', async () => {
    await expect(
      maple(await png(coords(2, 2)))
        .trim({ lineArt: true as never })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/lineArt/);
  });

  it('rejects a non-finite rotate angle before it reaches the recipe', () => {
    expect(() => maple(coords(2, 2)).rotate(NaN)).toThrow(/angle must be finite/);
  });

  it('rejects a non-finite trim threshold before it reaches the recipe', () => {
    expect(() => maple(coords(2, 2)).trim({ threshold: Infinity })).toThrow(
      /threshold must be finite/,
    );
  });

  it('the legacy raster_v2 render path composites transparent pixels over black for JPEG', async () => {
    // #3501 fix-round-3: raster_v2's render_into (rasterFromRawRenderBuf /
    // maple_raster_from_raw_render_buf) used to call encode_raster_rgb
    // directly, which drops alpha without compositing — a fully-transparent
    // red pixel kept its red channel instead of blending to black. This
    // FFI entry isn't reachable through the fluent builder (toFormat/
    // toBuffer always take the v3 recipe pipeline, which was already
    // correct), but it's still a real, callable part of the native ABI, so
    // it gets pinned directly against the freshly-built dylib.
    const pixels = new Uint8Array([255, 0, 0, 0, 0, 0, 0, 255]); // transparent red, opaque black
    const res = loadNativeBinding().rasterFromRawRenderBuf(
      pixels,
      2,
      1,
      4,
      0,
      0,
      0,
      0,
      'jpeg',
      90,
      0,
    );
    expect(res.ok).toBe(true);
    // Decode the JPEG bytes back through the package's own pipeline rather
    // than reading the encoded bytes directly.
    const raw = await maple(Buffer.from(res.buffer!)).toRawAlpha();
    const [r, g, b] = raw.data.subarray(0, 3);
    expect(r).toBeLessThan(24);
    expect(g).toBeLessThan(24);
    expect(b).toBeLessThan(24);
  });
});
