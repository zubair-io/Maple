import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/**
 * Gate for the alpha-aware pipeline and compositing (#3505). Every case runs
 * through the real FFI against synthetic rasters with closed-form
 * expectations — no golden images, no visual judgement.
 */
describe('Alpha pipeline and composite', () => {
  const solid = (w: number, h: number, px: number[]) => ({
    data: new Uint8Array(Array.from({ length: w * h }, () => px).flat()),
    width: w,
    height: h,
    channels: px.length as 3 | 4,
  });

  it('keeps alpha through a PNG encode', async () => {
    const png = await maple(solid(2, 2, [0, 255, 0, 0]))
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRawAlpha();
    expect(raw.channels).toBe(4);
    expect(raw.data[3]).toBe(0);
  });

  it('flattens transparency over black for JPEG', async () => {
    const jpeg = await maple(solid(8, 8, [0, 255, 0, 0]))
      .toFormat('jpeg', { quality: 95 })
      .toBuffer();
    const raw = await maple(jpeg).toRawAlpha();
    expect(raw.channels).toBe(3);
    expect(raw.data[0]).toBeLessThan(24);
    expect(raw.data[1]).toBeLessThan(24);
    expect(raw.data[2]).toBeLessThan(24);
  });

  it('flatten() composites over the requested background', async () => {
    const png = await maple(solid(2, 2, [200, 0, 0, 128]))
      .flatten({ background: { r: 0, g: 0, b: 255 } })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRawAlpha();
    expect(raw.channels).toBe(3);
    expect([raw.data[0], raw.data[1], raw.data[2]]).toEqual([100, 0, 127]);
  });

  it('ensureAlpha() adds an opaque channel to an RGB source', async () => {
    const png = await maple(solid(2, 2, [10, 20, 30]))
      .ensureAlpha()
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRawAlpha();
    expect(raw.channels).toBe(4);
    expect(raw.data[3]).toBe(255);
  });

  it('removeAlpha() drops the channel without compositing', async () => {
    const png = await maple(solid(1, 1, [255, 255, 255, 0]))
      .removeAlpha()
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRawAlpha();
    expect([raw.channels, raw.data[0], raw.data[1], raw.data[2]]).toEqual([3, 255, 255, 255]);
  });

  it('composite() places a raw overlay at an explicit offset', async () => {
    const base = await maple(solid(3, 1, [0, 0, 0, 255]))
      .toFormat('png')
      .toBuffer();
    const out = await maple(base)
      .composite([{ input: solid(1, 1, [255, 255, 255, 255]), left: 1, top: 0 }])
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(Array.from(raw.data.subarray(4, 8))).toEqual([255, 255, 255, 255]);
    expect(Array.from(raw.data.subarray(0, 4))).toEqual([0, 0, 0, 255]);
  });

  it('composite() accepts an encoded overlay and a blend mode', async () => {
    const base = await maple(solid(1, 1, [200, 100, 50, 255]))
      .toFormat('png')
      .toBuffer();
    const overlay = await maple(solid(1, 1, [128, 128, 128, 255]))
      .toFormat('png')
      .toBuffer();
    const out = await maple(base)
      .composite([{ input: overlay, blend: 'multiply' }])
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([100, 50, 25]);
  });

  it('rejects an unsupported blend mode by name', async () => {
    const base = await maple(solid(1, 1, [0, 0, 0, 255]))
      .toFormat('png')
      .toBuffer();
    await expect(
      maple(base)
        .composite([{ input: solid(1, 1, [1, 1, 1, 255]), blend: 'soft-light' as never }])
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/soft-light/);
  });

  it('composite() throws when a layer sets exactly one of left/top', async () => {
    const base = await maple(solid(2, 2, [0, 0, 0, 255]))
      .toFormat('png')
      .toBuffer();
    const overlay = solid(1, 1, [255, 255, 255, 255]);
    expect(() => maple(base).composite([{ input: overlay, left: 1 }])).toThrow(
      'composite: a layer must set both left and top, or neither',
    );
    expect(() => maple(base).composite([{ input: overlay, top: 1 }])).toThrow(
      'composite: a layer must set both left and top, or neither',
    );
  });

  it('flatten() flattens a fully transparent pixel over a hex background', async () => {
    const png = await maple(solid(1, 1, [0, 0, 0, 0]))
      .flatten({ background: '#ff8000' })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(png).toRawAlpha();
    expect(raw.channels).toBe(3);
    expect([raw.data[0], raw.data[1], raw.data[2]]).toEqual([255, 128, 0]);
  });

  it('flatten() throws on a malformed hex background', () => {
    expect(() => maple(solid(1, 1, [0, 0, 0, 0])).flatten({ background: '#12' })).toThrow(
      /Unrecognised colour/,
    );
  });
});
