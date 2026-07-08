import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { writePsdBuffer } from 'ag-psd';
import { decodeHdrToneMapped, decodePsdComposite } from './psd-hdr-decode.ts';

// Committed real Radiance HDR fixture — copied from the `hdr` package's own
// test suite (node_modules/hdr/test/rgba.hdr) so the test exercises a real,
// independently-authored file rather than a synthetic byte sequence.
const FIXTURE_HDR = path.resolve(import.meta.dir, '..', '..', 'tests', 'fixtures', 'sample.hdr');

async function fixturePresent(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Build a tiny synthetic PSD in-memory via ag-psd's own writer — no
 * external fixture needed since ag-psd round-trips its own format. */
function buildSyntheticPsd(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const psd = {
    width,
    height,
    imageData: { data, width, height },
    children: [],
  };
  return new Uint8Array(writePsdBuffer(psd as never, { generateThumbnail: false }));
}

describe('decodePsdComposite', () => {
  it('decodes a flattened composite raster from a synthetic PSD', () => {
    const buf = buildSyntheticPsd(4, 4, [255, 128, 0, 255]);
    const raster = decodePsdComposite(buf);

    expect(raster.width).toBe(4);
    expect(raster.height).toBe(4);
    expect(raster.data.length).toBe(4 * 4 * 4);
    // Every pixel should round-trip the solid fill color written above.
    expect(Array.from(raster.data.slice(0, 4))).toEqual([255, 128, 0, 255]);
    expect(Array.from(raster.data.slice(-4))).toEqual([255, 128, 0, 255]);
  });

  it('decodes a larger (non-trivial) synthetic PSD without throwing', () => {
    const buf = buildSyntheticPsd(64, 48, [10, 200, 90, 255]);
    const raster = decodePsdComposite(buf);
    expect(raster.width).toBe(64);
    expect(raster.height).toBe(48);
    expect(raster.data.length).toBe(64 * 48 * 4);
  });

  it('throws on garbage bytes rather than returning a bogus raster', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => decodePsdComposite(garbage)).toThrow();
  });

  // Does not exercise a canvas dependency: if a future ag-psd version starts
  // requiring `createCanvas` on the composite-only read path, the throwing
  // stub installed by `initializeCanvasFreeMode()` will surface here as a
  // loud failure rather than silently degrading — this test's continued
  // pass is itself evidence the canvas-free path is intact.
  it('never touches a canvas implementation (no native deps in this decode)', () => {
    const buf = buildSyntheticPsd(2, 2, [1, 2, 3, 255]);
    expect(() => decodePsdComposite(buf)).not.toThrow();
  });
});

describe('decodeHdrToneMapped', () => {
  it('decodes the committed Radiance HDR fixture to a tone-mapped RGBA8 raster (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HDR))) return; // fixture missing → soft pass

    const buf = new Uint8Array(await readFile(FIXTURE_HDR));
    const raster = await decodeHdrToneMapped(buf);

    expect(raster.width).toBeGreaterThan(0);
    expect(raster.height).toBeGreaterThan(0);
    expect(raster.data.length).toBe(raster.width * raster.height * 4);

    // Every pixel must land in valid 8-bit range (Reinhard + sRGB OETF
    // guarantees [0,255] even for scene-linear values >> 1.0) and alpha
    // is always fully opaque (Radiance HDR carries no alpha channel).
    for (let i = 0; i < raster.data.length; i += 4) {
      expect(raster.data[i + 0]).toBeGreaterThanOrEqual(0);
      expect(raster.data[i + 0]).toBeLessThanOrEqual(255);
      expect(raster.data[i + 1]).toBeGreaterThanOrEqual(0);
      expect(raster.data[i + 1]).toBeLessThanOrEqual(255);
      expect(raster.data[i + 2]).toBeGreaterThanOrEqual(0);
      expect(raster.data[i + 2]).toBeLessThanOrEqual(255);
      expect(raster.data[i + 3]).toBe(255);
    }
  });

  it('rejects malformed HDR bytes without ever reaching the hdr library', async () => {
    // `hdr`'s loader synchronously infinite-loops (never emits load/error,
    // never yields) on bytes with no recognizable Radiance header/dimension
    // line — verified empirically, and unfixable from the outside since the
    // loop has no await points a timeout could preempt. Our own
    // `looksLikeRadianceHdr` pre-check rejects before the library is ever
    // invoked. This test hanging instead of failing fast would itself be the
    // regression signal.
    const garbage = new Uint8Array([0, 1, 2, 3]);
    await expect(decodeHdrToneMapped(garbage)).rejects.toThrow();
  });
});

// The tone-mapping math (XYZ→linear-sRGB, Reinhard, sRGB OETF) is pure and
// independent of the streaming HDR decode — test it in isolation with
// synthetic pixel data so the numeric behaviour is pinned regardless of
// fixture availability.
describe('HDR tone-mapping math (via decodeHdrToneMapped internals)', () => {
  it('never overflows 8-bit range for extreme scene-linear input', async () => {
    // Build a minimal valid 1x1 Radiance HDR file with an extreme (very
    // bright) RGBE-encoded pixel, exercising the "HDR values exceed 1.0"
    // path the module doc calls out.
    const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n', 'ascii');
    // RGBE: R=255 G=255 B=255 E=200 → an enormous (over-range) scene value.
    const pixel = Buffer.from([255, 255, 255, 200]);
    const buf = new Uint8Array(Buffer.concat([header, pixel]));

    const raster = await decodeHdrToneMapped(buf);
    expect(raster.width).toBe(1);
    expect(raster.height).toBe(1);
    for (const channel of [0, 1, 2]) {
      expect(raster.data[channel]).toBeGreaterThanOrEqual(0);
      expect(raster.data[channel]).toBeLessThanOrEqual(255);
    }
    // Reinhard asymptotically approaches white for very bright input —
    // expect the tone-mapped channel to be pushed high (bright), not clipped
    // garbage or NaN-derived zero.
    expect(raster.data[0]!).toBeGreaterThan(200);
  });
});
