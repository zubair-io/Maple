import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

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

  it('sharpen() rejects an out-of-range transfer parameter by name', async () => {
    // Controller ruling (b) on task E5: raster_recipe_filter.rs's
    // executor validates m1/m2/x1/y2/y3 to sharp's own [0, 1000000] and
    // names the offending field.
    await expect(
      maple(await png(stepEdge(4, 4)))
        .sharpen({ sigma: 1, m1: -1 })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/m1/);
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

  it('rejects an out-of-range median window by name', async () => {
    // Not oddness any more (ruling (c) dropped that restriction) — the
    // sharp-matching [1, 1000] ceiling is what still rejects.
    await expect(
      maple(await png(impulse(5)))
        .median(1001)
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/1001/);
  });

  it('rejects a kernel whose length disagrees with its dimensions', async () => {
    await expect(
      maple(await png(impulse(5)))
        .convolve({ width: 3, height: 3, kernel: [1, 2, 3] })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/expected 9/);
  });
});
