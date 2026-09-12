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

  it('gamma() with symmetric defaults nets to near-identity with no resize', async () => {
    // #3503 fix-round-2: with no resize between them, gamma(2.2) pushes
    // exponent 2.2 then exponent 1/2.2 (our plain-power-law op; see
    // `builder-colour.ts` for why this is the opposite of a naive reading
    // of libvips' own `vips_gamma`) — algebraically a net identity, with
    // only 8-bit intermediate-quantization rounding to absorb.
    const src = await png([40, 130, 220]);
    const out = await maple(src).gamma().toFormat('png').toBuffer();
    const [r, g, b] = await first(out);
    expect(Math.abs(r - 40)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 130)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 220)).toBeLessThanOrEqual(2);
  });

  it('gamma(g, gammaOut) with different values darkens or brightens', async () => {
    // #3503 fix-round-2: our `gamma` op is a PLAIN power law, unlike
    // libvips' own `vips_gamma` (which computes `x ** (1/exponent)`), so
    // the builder pushes `exponent: gamma` before the resize and
    // `exponent: 1/gammaOut` after it (see `builder-colour.ts`). With no
    // resize call at all here, `gamma: 1.0` before is an exact no-op
    // (128 stays 128, no quantization loss), so this closed form is exact:
    // (128/255)^(1/2.0) * 255 = 180.66, which libvips TRUNCATES to 180 (not
    // 181 — measured against real sharp 0.34.5, which returns 180 for both
    // `.gamma(1.0, 2.0)` and `.gamma(1.5, 3.0)` on solid grey 128).
    const out = await maple(await png([128, 128, 128]))
      .gamma(1.0, 2.0)
      .toFormat('png')
      .toBuffer();
    expect((await first(out))[0]).toBe(180);
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

  it('a decisive asymmetric gamma pins the fixed exponent direction', async () => {
    // #3503 fix-round-2, the critical re-review finding: the exponents
    // around resize were inverted relative to sharp. libvips' `vips_gamma`
    // computes `x ** (1/exponent)`, so sharp's `Gamma(image, 1/gamma)`
    // before resize nets to `x ** gamma` (darken for gamma>1) and
    // `Gamma(image, gammaOut)` after nets to `x ** (1/gammaOut)` (brighten
    // for gammaOut>1). `.gamma(1.5, 3.0)` on solid grey 128 with a 1x1
    // `nearest` resize (an exact pick, no interpolation, so the resize
    // itself contributes no numeric drift) makes the direction
    // unambiguous — measured against real sharp 0.34.5: 180 exactly (it was
    // within 1 of ours before the truncation fix; it is exact now).
    const out = await maple(solid([128, 128, 128]))
      .gamma(1.5, 3.0)
      .resize({ width: 1, height: 1, filter: 'nearest' })
      .toRawAlpha();
    expect(out.data[0]).toBe(180);
  });

  /** 16 grey levels spanning the FULL 0-255 range, 4x4. */
  const greyRamp4x4 = () => ({
    data: new Uint8Array(
      Array.from({ length: 16 }, (_, i) => Math.round((i * 255) / 15)).flatMap((v) => [v, v, v]),
    ),
    width: 4,
    height: 4,
    channels: 3 as const,
  });

  it('a symmetric gamma(2.2) around a nearest resize matches sharp exactly', async () => {
    // Same ordering check as the lanczos3 test above, but with `nearest` as
    // the resize kernel (an exact pixel pick, verified separately to be
    // byte-identical between maple and sharp) so the sharp comparison
    // isolates gamma correctness from the unrelated `fast_image_resize`
    // vs. libvips `lanczos3` numeric gap flagged in fix-round-1.
    //
    // The 16 grey levels span the FULL 0-255 range. An earlier revision of
    // this test used 100-255 and blamed the near-black drift on "sharp's own
    // imprecision" — that was wrong, and it hid a real bug: sharp's gamma
    // pair does collapse the darkest codes to 0, but only because libvips
    // TRUNCATES on the way back to uchar, and Maple was rounding (raw-core
    // `raster_colour::to_uchar_trunc`). Rounding made `.gamma()` land 21
    // codes off sharp near black. With truncation the whole range is
    // byte-exact, so this asserts equality rather than a tolerance.
    const opts = { width: 2, height: 2, filter: 'nearest' as const };
    const gammaFirst = await maple(greyRamp4x4()).gamma(2.2).resize(opts).toRawAlpha();
    const resizeFirst = await maple(greyRamp4x4()).resize(opts).gamma(2.2).toRawAlpha();
    expect(Buffer.from(gammaFirst.data).equals(Buffer.from(resizeFirst.data))).toBe(true);
    // Measured against real sharp 0.34.5 `.gamma(2.2).resize(2,2,{kernel:
    // 'nearest'})` on this exact 4x4 grid of levels.
    expect(Array.from(gammaFirst.data)).toEqual([
      83, 83, 83, 118, 118, 118, 220, 220, 220, 255, 255, 255,
    ]);
  });

  it('gamma() truncates like libvips over the whole 0-255 range', async () => {
    // No resize at all, so this is purely the gamma PAIR on the encoded
    // samples. Measured against real sharp 0.34.5 `.gamma()` on the same 16
    // levels: the two darkest codes collapse to 0 (libvips truncates the
    // float band on the way back to uchar), and rounding instead would put
    // 17 -> 21 here, the 21-code drift this pins against.
    const out = await maple(greyRamp4x4()).gamma().toRawAlpha();
    const reds = Array.from(out.data).filter((_, i) => i % 3 === 0);
    expect(reds).toEqual([0, 0, 33, 49, 65, 83, 100, 118, 135, 152, 169, 186, 203, 220, 237, 255]);
  });

  it('linear() truncates like libvips, matching sharp byte for byte', async () => {
    // `1.2*13 - 10 = 5.6` and `0.5*3 = 1.5`: libvips truncates the float
    // band to 5 and 1 where rounding gives 6 and 2. Measured against real
    // sharp 0.34.5, which disagreed with the old rounding on 996 of 3072
    // samples of a 32x32 noise fixture at `linear(1.2, -10)` alone.
    const out = await maple(solid([13, 3, 3]))
      .linear([1.2, 0.5, 0.5], [-10, 0, 0])
      .toRawAlpha();
    expect(Array.from(out.data.subarray(0, 3))).toEqual([5, 1, 1]);
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

  it('linear() rejects coefficient vectors sharp rejects', () => {
    // All four messages measured against real sharp 0.34.5. Before this,
    // `[1, 1.5]` silently ran the third channel at a[0] = 1 (#3503 review I5).
    const img = () => maple(solid([1, 2, 3]));
    expect(() => img().linear([1, 1.5], [0, 0])).toThrow(
      /linear: vector must have 1 or 3 elements, got 2/,
    );
    expect(() => img().linear([1, 1, 1, 0.5], [0, 0, 0, 0])).toThrow(
      /linear: vector must have 1 or 3 elements, got 4/,
    );
    expect(() => img().linear([1, 1.5, 0.5], 10)).toThrow(
      /Expected a and b to be arrays of the same length/,
    );
    expect(() => img().linear(1.2, [0, 10, -10])).toThrow(
      /Expected a and b to be arrays of the same length/,
    );
  });

  it('linear() broadcasts a 1-element vector, as libvips does', async () => {
    const out = await maple(solid([100, 100, 100]))
      .linear([0.5], [10])
      .toRawAlpha();
    expect(Array.from(out.data.subarray(0, 3))).toEqual([60, 60, 60]);
  });

  it('negate(false) is a no-op, like sharp', async () => {
    // sharp: `this.options.negate = is.bool(options) ? options : true`, so a
    // boolean false DISABLES the op. Measured against real sharp 0.34.5,
    // which returns the source pixels untouched (#3503 review I4).
    const src = await png([0, 100, 255, 200]);
    expect(await first(await maple(src).negate(false).toFormat('png').toBuffer())).toEqual([
      0, 100, 255, 200,
    ]);
    expect(await first(await maple(src).negate(true).toFormat('png').toBuffer())).toEqual([
      255, 155, 0, 55,
    ]);
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
    // Measured: sharp reaches 255 here, not 254 — at 0/100 the upper bound
    // is the band's true maximum, so the brightest pixel lands on white.
    expect(raw.data[raw.data.length - 1]).toBe(255);
  });

  it('normalise() at the default 1/99 matches sharp on a colour image', async () => {
    // The bounds come from libvips `vips_percent`, which is not a rank
    // search: it thresholds the cumulative histogram of trunc(L*) —
    // rescaled so its maximum is the maximum BIN INDEX — at
    // `percent * bins / 100`, strictly greater, and reports one past the
    // last bin when nothing qualifies. A rank search put this fixture's
    // default normalise up to 46 codes away from sharp on colour noise.
    // Expected values measured against real sharp 0.34.5 on this fixture.
    const colours = {
      data: new Uint8Array(
        [
          [10, 20, 30],
          [200, 40, 60],
          [60, 180, 90],
          [40, 50, 220],
          [128, 128, 128],
          [250, 240, 200],
          [5, 5, 5],
          [160, 90, 30],
        ].flat(),
      ),
      width: 4,
      height: 2,
      channels: 3 as const,
    };
    const out = await maple(colours).normalise().toRawAlpha();
    const sharpExpected = [
      8, 18, 28, 206, 46, 64, 70, 189, 98, 46, 53, 223, 134, 134, 134, 255, 255, 214, 1, 1, 1, 165,
      95, 35,
    ];
    Array.from(out.data).forEach((byte, idx) => {
      expect(Math.abs(byte - sharpExpected[idx])).toBeLessThanOrEqual(1);
    });
  });

  it('normalise() at 0/100 takes the true min and max, like sharp', async () => {
    // sharp skips the percentile machinery for 0/100 and truncates the L*
    // band's own extremes (`operations.cc:75-77`). Measured against real
    // sharp 0.34.5 on the same fixture.
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
    const wide = await maple(ramp).normalise({ lower: 0, upper: 100 }).toRawAlpha();
    expect(wide.data[0]).toBe(1);
    expect(wide.data[wide.data.length - 1]).toBe(255);
    // ...and at the default 1/99 the 99th percentile lands inside the
    // populated range, so the top clips short of white: sharp gives 251.
    const narrow = await maple(ramp).normalise().toRawAlpha();
    expect(narrow.data[0]).toBe(1);
    expect(narrow.data[narrow.data.length - 1]).toBe(251);
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

  it('toColourspace("display-p3") then ("srgb") round-trips the pixels', async () => {
    // The executor must track the primaries the image is ACTUALLY in and
    // use that as `from` for the next `toColourspace`, not a hardcoded
    // sRGB — otherwise this pair applies the sRGB->P3 rotation twice
    // instead of rotating back, and the round trip would drift far more
    // than a rounding error.
    const src = await png([255, 0, 0]);
    const out = await maple(src).toColourspace('display-p3').toColourspace('srgb').toRawAlpha();
    const original = await first(src);
    Array.from(out.data.subarray(0, out.channels)).forEach((byte, idx) => {
      expect(Math.abs(byte - original[idx])).toBeLessThanOrEqual(1);
    });
  });
});
