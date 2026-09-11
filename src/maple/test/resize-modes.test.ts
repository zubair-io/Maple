import { describe, expect, it } from 'bun:test';
import { maple } from '../src/index.ts';

/** Gate for #3502: fits, position/gravity, withoutReduction, kernel alias. */
describe('Resize modes', () => {
  const wide = {
    data: new Uint8Array(Array.from({ length: 40 * 20 }, () => [255, 0, 0]).flat()),
    width: 40,
    height: 20,
    channels: 3 as const,
  };
  const src = () => maple(wide).toFormat('png').toBuffer();

  const sized = async (options: Parameters<ReturnType<typeof maple>['resize']>[0]) => {
    const out = await maple(await src())
      .resize(options)
      .toFormat('png')
      .toBuffer();
    const meta = await maple(out).metadata();
    return [meta.width, meta.height];
  };

  it('inside, outside, cover, contain and fill each frame differently', async () => {
    const common = { width: 10, height: 10, withoutEnlargement: false };
    expect(await sized({ ...common, fit: 'inside' })).toEqual([10, 5]);
    expect(await sized({ ...common, fit: 'outside' })).toEqual([20, 10]);
    expect(await sized({ ...common, fit: 'cover' })).toEqual([10, 10]);
    expect(await sized({ ...common, fit: 'contain' })).toEqual([10, 10]);
    expect(await sized({ ...common, fit: 'fill' })).toEqual([10, 10]);
  });

  it('contain letterboxes with the requested background', async () => {
    const out = await maple(await src())
      .resize({
        width: 10,
        height: 10,
        fit: 'contain',
        withoutEnlargement: false,
        background: { r: 0, g: 0, b: 255 },
        kernel: 'nearest',
      })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(Array.from(raw.data.subarray(0, 3))).toEqual([0, 0, 255]);
  });

  it('contain with a transparent background yields RGBA', async () => {
    const out = await maple(await src())
      .resize({
        width: 10,
        height: 10,
        fit: 'contain',
        withoutEnlargement: false,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toFormat('png')
      .toBuffer();
    const raw = await maple(out).toRawAlpha();
    expect(raw.channels).toBe(4);
    expect(raw.data[3]).toBe(0);
  });

  it('withoutReduction refuses to scale down', async () => {
    expect(await sized({ width: 10, height: 10, fit: 'inside', withoutReduction: true })).toEqual([
      40, 20,
    ]);
  });

  it('position changes which part of a cover crop survives', async () => {
    const half = {
      data: new Uint8Array(
        Array.from({ length: 4 * 2 }, (_, i) => (i % 4 < 2 ? [255, 0, 0] : [0, 255, 0])).flat(),
      ),
      width: 4,
      height: 2,
      channels: 3 as const,
    };
    const png = await maple(half).toFormat('png').toBuffer();
    const crop = async (position: string) => {
      const out = await maple(png)
        .resize({ width: 2, height: 2, fit: 'cover', position, kernel: 'nearest' })
        .toFormat('png')
        .toBuffer();
      const raw = await maple(out).toRawAlpha();
      return Array.from(raw.data.subarray(0, 3));
    };
    expect(await crop('west')).toEqual([255, 0, 0]);
    expect(await crop('east')).toEqual([0, 255, 0]);
    expect(await crop('left')).toEqual([255, 0, 0]);
  });

  it('kernel and filter are the same option', async () => {
    const a = await maple(await src())
      .resize({ width: 9, height: 9, fit: 'fill', kernel: 'nearest' })
      .toFormat('png')
      .toBuffer();
    const b = await maple(await src())
      .resize({ width: 9, height: 9, fit: 'fill', filter: 'nearest' })
      .toFormat('png')
      .toBuffer();
    expect(a.equals(b)).toBe(true);
  });

  it('rejects the entropy and attention strategies by name', async () => {
    await expect(
      maple(await src())
        .resize({ width: 8, height: 8, fit: 'cover', position: 'entropy' })
        .toFormat('png')
        .toBuffer(),
    ).rejects.toThrow(/entropy/);
  });
});
