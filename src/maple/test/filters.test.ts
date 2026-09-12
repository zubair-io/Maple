import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * A one-byte stand-in for a real image, for the synchronous argument-validation
 * cases below — they throw before any decode. It cannot be `Buffer.alloc(0)`:
 * an empty input buffer is itself rejected in the constructor (#3507), exactly
 * as `sharp(Buffer.alloc(0))` is ("Input Buffer is empty"), so it would mask
 * the per-option error these tests are about.
 */
const DUMMY_INPUT = Buffer.alloc(1);

/**
 * Gate for #3504: filters through the real FFI, closed-form on synthetics.
 *
 * The wire shapes these methods emit follow `raster_recipe_filter.rs`'s
 * actual schema (#3504 task E4), which in one place — `convolve`'s `scale`
 * — disagrees with the task brief's own literal builder code (see
 * `builder-filter.ts`'s module doc): the brief's `scale: kernel.scale ?? 0`
 * would collapse "the caller never set `scale`" and "the caller explicitly
 * passed `scale: 0`" into the same wire value, which is wrong for a
 * zero-sum kernel run with no `scale` at all. `'convolve() tells an absent
 * scale from an explicit scale: 0'` below is the test that would have
 * caught that.
 */
describe('Filters', () => {
  /** `n`x`n` black with one white pixel in the middle. */
  const impulse = (n: number) => {
    const centre = Math.floor(n / 2);
    return {
      data: new Uint8Array(
        Array.from({ length: n * n }, (_, i) => {
          const x = i % n;
          const y = Math.floor(i / n);
          return x === centre && y === centre ? [255, 255, 255] : [0, 0, 0];
        }).flat(),
      ),
      width: n,
      height: n,
      channels: 3 as const,
    };
  };

  /** A vertical step edge: 60 on the left, 200 on the right. */
  const stepEdge = (w: number, h: number) => ({
    data: new Uint8Array(
      Array.from({ length: w * h }, (_, i) => {
        const v = i % w < w / 2 ? 60 : 200;
        return [v, v, v];
      }).flat(),
    ),
    width: w,
    height: h,
    channels: 3 as const,
  });

  /** `w`x`h`, flat except one bright column at `spikeX`. */
  const columnSpike = (w: number, h: number, spikeX: number) => ({
    data: new Uint8Array(
      Array.from({ length: w * h }, (_, i) => {
        const v = i % w === spikeX ? 200 : 0;
        return [v, v, v];
      }).flat(),
    ),
    width: w,
    height: h,
    channels: 3 as const,
  });

  const pixels = async (buf: Buffer) => (await maple(buf).toRawAlpha()).data;
  const png = (src: Parameters<typeof maple>[0]) => maple(src).toFormat('png').toBuffer();

  it('blur() with no sigma is a 3x3 box', async () => {
    const out = await maple(await png(impulse(5)))
      .blur()
      .toFormat('png')
      .toBuffer();
    const px = await pixels(out);
    expect(px[(2 * 5 + 2) * 3]).toBe(28);
  });

  it('blur(sigma) spreads an impulse further than the box', async () => {
    const src = await png(impulse(11));
    const box = await pixels(await maple(src).blur().toFormat('png').toBuffer());
    const gauss = await pixels(await maple(src).blur(3).toFormat('png').toBuffer());
    const peak = (5 * 11 + 5) * 3;
    expect(gauss[peak]).toBeLessThan(box[peak]);
  });

  it('sharpen() lifts the bright side of an edge', async () => {
    const src = await png(stepEdge(16, 4));
    const before = await pixels(src);
    const after = await pixels(await maple(src).sharpen({ sigma: 1.5 }).toFormat('png').toBuffer());
    const i = (2 * 16 + 8) * 3;
    expect(after[i]).toBeGreaterThan(before[i]);
  });

  it('sharpen() rejects an out-of-range transfer parameter by name', () => {
    // sharp validates m1/m2/x1/y2/y3 to [0, 1000000] and names the
    // offending field; the builder now does that before the wire rather
    // than leaving it to the executor, so the throw is synchronous.
    expect(() => maple(DUMMY_INPUT).sharpen({ sigma: 1, m1: -1 })).toThrow(/m1/);
  });

  it('median() erases a speck but keeps an edge', async () => {
    const speck = impulse(5);
    const cleaned = await pixels(
      await maple(await png(speck))
        .median(3)
        .toFormat('png')
        .toBuffer(),
    );
    expect(cleaned[(2 * 5 + 2) * 3]).toBe(0);

    const edge = await pixels(
      await maple(await png(stepEdge(16, 4)))
        .median(3)
        .toFormat('png')
        .toBuffer(),
    );
    expect(edge[(2 * 16 + 8) * 3]).toBe(200);
  });

  it('median() accepts an even window size, asymmetric like sharp', async () => {
    // Controller ruling (c) on task E5: sharp/vips_rank accepts even
    // windows (no odd-only restriction) and, measured against sharp
    // 0.34.5 with a single-column spike probe, puts the extra tap on the
    // LOW side of the window — a `size: 2` window at pixel x covers
    // columns [x-1, x], so a spike at column 2 shows up at output columns
    // 2 AND 3, never column 1. See `RasterImage::median`'s doc comment in
    // raw-core for the general `before`/`after` formula this pins.
    const src = columnSpike(6, 6, 2);
    const out = await pixels(
      await maple(await png(src))
        .median(2)
        .toFormat('png')
        .toBuffer(),
    );
    const row = (y: number) => Array.from({ length: 6 }, (_, x) => out[(y * 6 + x) * 3]);
    expect(row(3)).toEqual([0, 0, 200, 200, 0, 0]);
  });

  it('threshold() binarises through greyscale by default', async () => {
    const src = {
      data: new Uint8Array([255, 0, 0, 0, 255, 0]),
      width: 2,
      height: 1,
      channels: 3 as const,
    };
    const out = await pixels(
      await maple(await png(src))
        .threshold()
        .toFormat('png')
        .toBuffer(),
    );
    expect(Array.from(out)).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('convolve() with an identity kernel is identity', async () => {
    const src = await png(stepEdge(8, 2));
    const out = await maple(src)
      .convolve({ width: 3, height: 3, kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0] })
      .toFormat('png')
      .toBuffer();
    expect(Buffer.from(await pixels(out)).equals(Buffer.from(await pixels(src)))).toBe(true);
  });

  it('convolve() tells an absent scale from an explicit scale: 0', async () => {
    // Load-bearing wire-shape check: raster_recipe.rs's `Convolve.scale` is
    // `Option<f64>` precisely so the executor can tell "never set" (wire
    // null, falls back to the kernel's own sum) apart from "explicitly 0"
    // (wire 0, sharp's own rule clips it up to 1). A flat field run through
    // a 3x3 box of ones stays flat when `scale` is omitted (divisor 9), but
    // blows past 255 and clamps when `scale: 0` is passed explicitly
    // (divisor 1) — mirrors raw-core's own
    // `convolve_scale_explicit_zero_clips_to_one_but_absent_scale_uses_the_kernel_sum`.
    const flat = {
      data: new Uint8Array(Array(5 * 5 * 3).fill(30)),
      width: 5,
      height: 5,
      channels: 3 as const,
    };
    const src = await png(flat);
    const centre = (2 * 5 + 2) * 3;

    const absent = await pixels(
      await maple(src)
        .convolve({ width: 3, height: 3, kernel: Array(9).fill(1) })
        .toFormat('png')
        .toBuffer(),
    );
    expect(absent[centre]).toBe(30);

    const explicitZero = await pixels(
      await maple(src)
        .convolve({ width: 3, height: 3, kernel: Array(9).fill(1), scale: 0 })
        .toFormat('png')
        .toBuffer(),
    );
    expect(explicitZero[centre]).toBe(255);
  });

  it('rejects an out-of-range or non-integer median window by name', () => {
    // Not oddness any more (ruling (c) dropped that restriction) — the
    // sharp-matching [1, 1000] ceiling is what still rejects, and a
    // fractional size is named rather than reaching serde, which used to
    // answer `median(3.5)` with "rawler failed to decode <recipe>: …
    // invalid type: floating point `3.5`, expected u32".
    expect(() => maple(DUMMY_INPUT).median(1001)).toThrow(/1001/);
    expect(() => maple(DUMMY_INPUT).median(3.5)).toThrow(/size/);
  });

  it('rejects a kernel whose length disagrees with its dimensions', () => {
    expect(() =>
      maple(DUMMY_INPUT).convolve({ width: 3, height: 3, kernel: [1, 2, 3] }),
    ).toThrow(/9 values/);
  });

  it('rejects NaN and Infinity by name, which JSON would turn into null', () => {
    // `JSON.stringify(NaN)` is `null`, so anything not caught here reaches
    // raw-core as an absent field: `blur(NaN)` used to run the box blur and
    // report success, and a NaN kernel entry surfaced as "recipe parse
    // failed: invalid type: null, expected f64".
    expect(() => maple(DUMMY_INPUT).blur(NaN)).toThrow(/sigma/);
    expect(() => maple(DUMMY_INPUT).blur(Infinity)).toThrow(/sigma/);
    expect(() => maple(DUMMY_INPUT).blur({ sigma: NaN })).toThrow(/options\.sigma/);
    expect(() =>
      maple(DUMMY_INPUT).convolve({
        width: 3,
        height: 3,
        kernel: [1, 1, 1, 1, NaN, 1, 1, 1, 1],
      }),
    ).toThrow(/kernel\[4\]/);
    expect(() => maple(DUMMY_INPUT).sharpen({ sigma: 1, y3: -Infinity })).toThrow(/y3/);
  });

  it('blur and sharpen require a sigma when given an options object', () => {
    // sharp: `blur({})` throws "Expected number between 0.3 and 1000 for
    // options.sigma" and `sharpen({m1: 3})` throws the equivalent for its
    // own 0.000001-10 domain. Both used to run the mild/box path here, which
    // also meant m1/m2/x1/y2/y3 were validated and then silently ignored.
    expect(() => maple(DUMMY_INPUT).blur({})).toThrow(/options\.sigma/);
    expect(() => maple(DUMMY_INPUT).sharpen({ m1: 3 })).toThrow(/options\.sigma/);
  });

  it('sharpen(number) is the same sigma form blur(number) is', async () => {
    // sharp's deprecated positional `sharpen(sigma)` is still live in
    // 0.34.5. Before this wave `sharpen(2)` was silently the no-argument
    // fast kernel, which measured 37 levels away from sharp.
    const src = await png(stepEdge(16, 4));
    const positional = await pixels(await maple(src).sharpen(2).toFormat('png').toBuffer());
    const object = await pixels(await maple(src).sharpen({ sigma: 2 }).toFormat('png').toBuffer());
    expect(Array.from(positional)).toEqual(Array.from(object));
  });

  it('threshold() rejects a non-integer or out-of-range value by name', () => {
    expect(() => maple(DUMMY_INPUT).threshold(300)).toThrow(/threshold/);
    expect(() => maple(DUMMY_INPUT).threshold(128.5)).toThrow(/threshold/);
  });

  it('threshold() greyscale follows sharps literal-true rule', async () => {
    // sharp: `if (!is.object(options) || options.greyscale === true ||
    // options.grayscale === true)`. So an options object that does not
    // literally set one spelling to `true` turns greyscale OFF — measured
    // max diff 255 on 31% of a noise fixture's samples when this was
    // treated as "default true". Solid red is the readable case: greyscale
    // takes bw_luma(255, 0, 0) = 127, which is under 128, so every channel
    // goes to 0; per-channel keeps red at 255.
    const red = {
      data: new Uint8Array(Array.from({ length: 16 }, () => [255, 0, 0]).flat()),
      width: 4,
      height: 4,
      channels: 3 as const,
    };
    const src = await png(red);
    const through = async (options?: object) =>
      Array.from(
        (await pixels(await maple(src).threshold(128, options).toFormat('png').toBuffer())).slice(
          0,
          3,
        ),
      );
    expect(await through()).toEqual([0, 0, 0]);
    expect(await through({})).toEqual([255, 0, 0]);
    expect(await through({ greyscale: undefined })).toEqual([255, 0, 0]);
    expect(await through({ greyscale: false })).toEqual([255, 0, 0]);
    expect(await through({ greyscale: true })).toEqual([0, 0, 0]);
    expect(await through({ grayscale: true, greyscale: false })).toEqual([0, 0, 0]);
  });

  it('a RAW develop input names an op it cannot run instead of dropping it', async () => {
    // `maple('photo.dng').blur(5).toFile(out)` used to write an unblurred
    // file and report success — the RAW-develop terminal never read
    // `state.ops`. `toFile` reports it the way it reports every other
    // failure, and `toBuffer` turns that into a throw.
    const res = await maple('photo.dng').blur(5).toFile('/tmp/maple-never-written.jpg');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blur is not supported on a RAW develop input/);
    await expect(maple('photo.dng').blur(5).toBuffer()).rejects.toThrow(
      /blur is not supported on a RAW develop input/,
    );
  });

  it('a RAW develop still honours the two ops it reads off state', async () => {
    // `resize` (read back as a long-edge limit) and `toColourspace` (which
    // also writes `state.colorSpace`, the export space the develop pipeline
    // takes) are the two ops the guard above lets through — both get past
    // it and fail only on the missing file. `toColourspace('b-w')` is the
    // exception: it pushes a `greyscale` op rather than a `toColourspace`
    // one, and the develop pipeline has no greyscale stage, so it is named
    // like any other unsupported op.
    const missing = /raw read/;
    const resized = await maple('photo.dng').resize(100).toFile('/tmp/maple-never-written-a.jpg');
    expect(resized.error).toMatch(missing);
    const p3 = await maple('photo.dng')
      .toColourspace('display-p3')
      .toFile('/tmp/maple-never-written-b.jpg');
    expect(p3.error).toMatch(missing);
    const bw = await maple('photo.dng')
      .toColourspace('b-w')
      .toFile('/tmp/maple-never-written-c.jpg');
    expect(bw.error).toMatch(/greyscale is not supported on a RAW develop input/);
  });

  it('threshold(0) and threshold(false) are no-ops, as in sharp', async () => {
    // sharp gates the whole stage on `threshold != 0` (`pipeline.cc`) and
    // resolves `threshold(false)` to 0, so neither form touches the image.
    // Measured byte-identical to the source on sharp 0.34.5, where a
    // literal `pixel >= 0` whitens everything (max diff 255 on 3060 of
    // 3072 samples of a noise fixture). `threshold(true)` is 128.
    const src = await png(stepEdge(8, 4));
    const before = Array.from(await pixels(src));
    const through = async (v: number | boolean) =>
      Array.from(await pixels(await maple(src).threshold(v).toFormat('png').toBuffer()));
    expect(await through(0)).toEqual(before);
    expect(await through(false)).toEqual(before);
    expect(await through(true)).not.toEqual(before);
  });

  it('blur and sharpen take sharps deprecated boolean form', async () => {
    // `true` is the mild path, `false` is no filter at all.
    const src = await png(stepEdge(16, 4));
    const raw = async (b: Buffer) => Array.from(await pixels(b));
    const before = await raw(src);
    expect(await raw(await maple(src).blur(false).toFormat('png').toBuffer())).toEqual(before);
    expect(await raw(await maple(src).sharpen(false).toFormat('png').toBuffer())).toEqual(before);
    expect(await raw(await maple(src).blur(true).toFormat('png').toBuffer())).toEqual(
      await raw(await maple(src).blur().toFormat('png').toBuffer()),
    );
    expect(await raw(await maple(src).sharpen(true).toFormat('png').toBuffer())).toEqual(
      await raw(await maple(src).sharpen().toFormat('png').toBuffer()),
    );
  });

  it('median rejects a window larger than the image, like vips_rank', async () => {
    // Measured on sharp 0.34.5: `median(3)` on a 1x1 and `median(5)` on a
    // 4x4 both throw "rank: window too large"; `median(4)` on the 4x4 does
    // not.
    const one = {
      data: new Uint8Array([90, 90, 90]),
      width: 1,
      height: 1,
      channels: 3 as const,
    };
    await expect(
      maple(await png(one))
        .median(3)
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/window too large/);
    await expect(
      maple(await png(impulse(4)))
        .median(5)
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/window too large/);
    expect(
      (
        await pixels(
          await maple(await png(impulse(4)))
            .median(4)
            .toFormat('png')
            .toBuffer(),
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-integer convolve scale by name', () => {
    // sharp's own `convolve()` (`lib/operation.js`) only honours `scale`
    // when `is.integer()` passes — a non-integer is silently replaced by
    // the kernel's own sum instead of erroring. Measured on sharp 0.34.5:
    // `scale: 4.5` over a flat 30 field with a box-of-9 kernel leaves the
    // field at 30 (scale silently replaced by the kernel sum of 9, not
    // applied as 4.5). Maple rejects rather than silently diverging.
    expect(() =>
      maple(DUMMY_INPUT).convolve({
        width: 3,
        height: 3,
        kernel: Array(9).fill(1),
        scale: 4.5,
      }),
    ).toThrow(/scale/);
  });

  it('rejects a non-integer convolve offset by name', () => {
    expect(() =>
      maple(DUMMY_INPUT).convolve({
        width: 3,
        height: 3,
        kernel: Array(9).fill(1),
        offset: 0.5,
      }),
    ).toThrow(/offset/);
  });

  it('still accepts integer scale and offset', async () => {
    const src = await png(stepEdge(8, 2));
    const out = await maple(src)
      .convolve({ width: 3, height: 3, kernel: Array(9).fill(1), scale: 9, offset: 0 })
      .toFormat('png')
      .toBuffer();
    // No throw, and a valid image comes back.
    expect((await pixels(out)).length).toBeGreaterThan(0);
  });
});
