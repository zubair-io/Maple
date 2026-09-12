import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * Gate for #3503 Task D6: colour ops through the real FFI, closed-form.
 * `greyscale()`'s expected values are Rec.709 luma taken in LINEAR light
 * (the #3503 controller ruling reverses the plan's original "encoded
 * values" expectation for this one op — see raw-core's `raster_colour.rs`).
 */
describe('Colour ops', () => {
  const solid = (px: number[]) => ({
    data: new Uint8Array(Array.from({ length: 4 * 4 }, () => px).flat()),
    width: 4,
    height: 4,
    channels: px.length as 3 | 4,
  });
  const png = (px: number[]) => maple(solid(px)).toFormat('png').toBuffer();
  const first = async (buf: Buffer) => {
    const raw = await maple(buf).toRawAlpha();
    return Array.from(raw.data.subarray(0, raw.channels));
  };

  it('greyscale() applies Rec.709 luma in linear light', async () => {
    const out = await maple(await png([255, 0, 0]))
      .greyscale()
      .toFormat('png')
      .toBuffer();
    expect(await first(out)).toEqual([127, 127, 127]);
  });

  it('greyscale() leaves a fourth (alpha) channel untouched', async () => {
    const out = await maple(await png([255, 0, 0, 77]))
      .greyscale()
      .toFormat('png')
      .toBuffer();
    expect(await first(out)).toEqual([127, 127, 127, 77]);
  });

  it('grayscale() is the same method', async () => {
    const a = await maple(await png([0, 255, 0]))
      .greyscale()
      .toFormat('png')
      .toBuffer();
    const b = await maple(await png([0, 255, 0]))
      .grayscale()
      .toFormat('png')
      .toBuffer();
    expect(a.equals(b)).toBe(true);
  });

  it('gamma() follows the libvips power law around the resize', async () => {
    // With no resize between them, gamma(2.2) is exponent 1/2.2 then 2.2 —
    // a net identity, which is what sharp's default pair does.
    const src = await png([40, 130, 220]);
    const out = await maple(src).gamma().toFormat('png').toBuffer();
    const [r, g, b] = await first(out);
    expect(Math.abs(r - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 130)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 220)).toBeLessThanOrEqual(2);
  });

  it('gamma(g, gammaOut) with different values darkens or brightens', async () => {
    const out = await maple(await png([128, 128, 128]))
      .gamma(1.0, 2.0)
      .toFormat('png')
      .toBuffer();
    // Net exponent gammaOut/gamma = 2: (128/255)^2 * 255 = 64.
    expect((await first(out))[0]).toBe(64);
  });

  /** Deterministic 4x4 RGB gradient, matching the fixture sharp was measured against. */
  const gradient4x4 = (): { data: Uint8Array; width: number; height: number; channels: 3 } => {
    const w = 4;
    const h = 4;
    const data = new Uint8Array(w * h * 3);
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.floor((y * w + x) * (255 / (w * h - 1)));
        data[i++] = v;
        data[i++] = 255 - v;
        data[i++] = (v * 2) % 256;
      }
    }
    return { data, width: w, height: h, channels: 3 };
  };

  it('gamma().resize() and resize().gamma() are ASSEMBLY-time equivalent', async () => {
    // sharp's gamma/resize are fixed pipeline stages: gamma-in always runs
    // immediately before the resize stage and gamma-out immediately after
    // it, regardless of the order `.gamma()`/`.resize()` were called in.
    // This is the regression check for the critical bug: before the fix,
    // `.gamma(2.2).resize(2,2)` pushed BOTH gamma ops ahead of a resize op
    // that didn't exist in the list yet, so gamma had no effect at all —
    // the two orderings below would have matched each other AND matched a
    // plain resize with no gamma. Default (lanczos3) kernel.
    const plain = await maple(gradient4x4()).resize(2, 2).toRawAlpha();
    const gammaFirst = await maple(gradient4x4()).gamma(2.2).resize(2, 2).toRawAlpha();
    const resizeFirst = await maple(gradient4x4()).resize(2, 2).gamma(2.2).toRawAlpha();
    expect(Buffer.from(gammaFirst.data).equals(Buffer.from(resizeFirst.data))).toBe(true);
    expect(Buffer.from(gammaFirst.data).equals(Buffer.from(plain.data))).toBe(false);
  });

  it('gamma-around-resize matches sharp, kernel isolated via nearest', async () => {
    // Same ordering check, but with `nearest` as the resize kernel so the
    // comparison to real sharp isolates gamma placement from resize-kernel
    // numerics: `nearest` is an exact pixel pick with no interpolation, so
    // maple's plain `nearest` resize is already byte-identical to sharp's
    // (verified separately) — `raw-core`'s `fast_image_resize`-based
    // `lanczos3` is NOT bit-identical to libvips' `lanczos3`, which is a
    // pre-existing, unrelated gap; pinning to sharp through THAT kernel
    // would conflate the two concerns.
    const opts = { width: 2, height: 2, filter: 'nearest' as const };
    const gammaFirst = await maple(gradient4x4()).gamma(2.2).resize(opts).toRawAlpha();
    const resizeFirst = await maple(gradient4x4()).resize(opts).gamma(2.2).toRawAlpha();
    expect(Buffer.from(gammaFirst.data).equals(Buffer.from(resizeFirst.data))).toBe(true);
    // Measured against real sharp 0.34.5
    // `.gamma(2.2).resize(2,2,{kernel:'nearest'})` on this exact gradient.
    const sharpExpected = [83, 169, 169, 118, 135, 237, 220, 33, 185, 255, 0, 253];
    Array.from(gammaFirst.data).forEach((byte, idx) => {
      expect(Math.abs(byte - sharpExpected[idx])).toBeLessThanOrEqual(2);
    });
  });

  it('gamma() rejects an out-of-range value by name', () => {
    expect(() => maple(solid([1, 2, 3])).gamma(0.5)).toThrow(/gamma.*\[1\.0, 3\.0\].*0\.5/);
  });

  it('gamma(g, gammaOut) rejects an out-of-range gammaOut by name', () => {
    expect(() => maple(solid([1, 2, 3])).gamma(2.0, 5)).toThrow(/gammaOut.*\[1\.0, 3\.0\].*5/);
  });

  it('linear() applies a*x + b per channel', async () => {
    const out = await maple(await png([100, 100, 100]))
      .linear([0.5, 1.0, 2.0], [10, 0, -50])
      .toFormat('png')
      .toBuffer();
    expect(await first(out)).toEqual([60, 100, 150]);
  });

  it('linear() accepts scalar a/b', async () => {
    const out = await maple(await png([100, 100, 100]))
      .linear(2, -50)
      .toFormat('png')
      .toBuffer();
    expect(await first(out)).toEqual([150, 150, 150]);
  });

  it('negate() inverts, and { alpha: false } spares transparency', async () => {
    const src = await png([0, 100, 255, 200]);
    expect(await first(await maple(src).negate().toFormat('png').toBuffer())).toEqual([
      255, 155, 0, 55,
    ]);
    expect(
      await first(await maple(src).negate({ alpha: false }).toFormat('png').toBuffer()),
    ).toEqual([255, 155, 0, 200]);
  });

  it('modulate({ saturation: 0 }) neutralises a colour', async () => {
    const out = await maple(await png([200, 40, 40]))
      .modulate({ saturation: 0 })
      .toFormat('png')
      .toBuffer();
    const [r, g, b] = await first(out);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });

  it('modulate() leaves a fourth (alpha) channel untouched', async () => {
    const out = await maple(await png([200, 40, 40, 88]))
      .modulate({ brightness: 1.2 })
      .toFormat('png')
      .toBuffer();
    expect((await first(out))[3]).toBe(88);
  });

  it('modulate() rejects a negative saturation by name', async () => {
    await expect(
      maple(await png([1, 2, 3]))
        .modulate({ saturation: -1 })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/saturation/);
  });

  it('tint() with a neutral grey gives the sharp-measured 105 grey', async () => {
    // Measured against real sharp 0.34.5 `.tint({r:128,g:128,b:128})` on
    // solid (200,40,40): [105,105,105]. Tint reduces to luminance in
    // LINEAR light (#3503 controller ruling B, `bw_luma` — the same
    // reduction `greyscale()` uses), so this is not just an r≈g≈b check.
    const out = await maple(await png([200, 40, 40]))
      .tint({ r: 128, g: 128, b: 128 })
      .toFormat('png')
      .toBuffer();
    const [r, g, b] = await first(out);
    for (const channel of [r, g, b]) {
      expect(Math.abs(channel - 105)).toBeLessThanOrEqual(1);
    }
  });

  it('a chromatic tint() matches the sharp-measured value', async () => {
    // Measured against real sharp 0.34.5 `.tint({r:255,g:0,b:0})` on solid
    // mid-grey (100,100,100): [216,0,0].
    const out = await maple(await png([100, 100, 100]))
      .tint({ r: 255, g: 0, b: 0 })
      .toFormat('png')
      .toBuffer();
    const [r, g, b] = await first(out);
    expect(Math.abs(r - 216)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 0)).toBeLessThanOrEqual(1);
  });

  it('normalise() stretches a compressed ramp to the full range', async () => {
    const ramp = {
      data: new Uint8Array(
        Array.from({ length: 129 }, (_, i) => {
          const v = 64 + Math.floor(i / 2);
          return [v, v, v];
        }).flat(),
      ),
      width: 129,
      height: 1,
      channels: 3 as const,
    };
    const out = await maple(await maple(ramp).toFormat('png').toBuffer())
      .normalise({ lower: 0, upper: 100 })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(raw.data[0]).toBeLessThanOrEqual(1);
    expect(raw.data[raw.data.length - 1]).toBeGreaterThanOrEqual(254);
  });

  it('normalize() is the same method', async () => {
    const src = await png([90, 90, 90]);
    const a = await maple(src).normalise().toFormat('png').toBuffer();
    const b = await maple(src).normalize().toFormat('png').toBuffer();
    expect(a.equals(b)).toBe(true);
  });

  it('normalise() rejects lower >= upper by name', async () => {
    await expect(
      maple(await png([1, 2, 3]))
        .normalise({ lower: 50, upper: 50 })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/lower < upper/);
  });

  it('toColourspace("display-p3") rotates a saturated red and tags the JPEG', async () => {
    const src = await png([255, 0, 0]);
    const p3 = await maple(src).toColourspace('display-p3').toFormat('jpeg').toBuffer();
    expect(Array.from(p3.subarray(0, 0))).toEqual([]); // sanity: p3 is a Buffer
    expect(p3.includes(Buffer.from('ICC_PROFILE\0', 'latin1'))).toBe(true);
    const raw = await maple(p3).toRawAlpha();
    const [r, g, b] = Array.from(raw.data.subarray(0, 3));
    expect(Math.abs(r - 234)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 51)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 35)).toBeLessThanOrEqual(2);
  });

  it('toColourspace("srgb") and ("display-p3") produce different bytes', async () => {
    const src = await png([255, 0, 0]);
    const srgb = await maple(src).toColourspace('srgb').toFormat('jpeg').toBuffer();
    const p3 = await maple(src).toColourspace('display-p3').toFormat('jpeg').toBuffer();
    expect(srgb.equals(p3)).toBe(false);
  });

  it('toColorspace() is the same method as toColourspace()', async () => {
    const src = await png([10, 20, 30]);
    const a = await maple(src).toColourspace('display-p3').toFormat('jpeg').toBuffer();
    const b = await maple(src).toColorspace('display-p3').toFormat('jpeg').toBuffer();
    expect(a.equals(b)).toBe(true);
  });

  it('rejects an unsupported colourspace by name', async () => {
    await expect(
      maple(await png([1, 2, 3]))
        .toColourspace('cmyk' as never)
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/cmyk/);
  });
});
