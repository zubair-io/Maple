import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { maple } from 'maple';
import { writePsdBuffer } from 'ag-psd';
import { solidPng, solidRgb } from '../test-support/synth-image.ts';
import { renderImageThumbToFile, renderHeicThumbToFile } from './render.ts';

// `import.meta.dir` is src/api/src/thumbs; fixture lives under src/api/tests/fixtures.
const FIXTURE_HEIC = path.resolve(import.meta.dir, '..', '..', 'tests', 'fixtures', 'sample.heic');
const FIXTURE_HDR = path.resolve(import.meta.dir, '..', '..', 'tests', 'fixtures', 'sample.hdr');

/** Same synthetic-PSD builder as `psd-hdr-decode.test.ts` — duplicated rather
 * than imported since it's a 15-line test fixture helper, not shared
 * production code. */
function buildSyntheticPsd(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const psd = { width, height, imageData: { data, width, height }, children: [] };
  return new Uint8Array(writePsdBuffer(psd as never, { generateThumbnail: false }));
}

/** A synthetic uncompressed TIFF, built via Maple's own raw-pixel → TIFF
 * encode path rather than a disk fixture or `sharp({ create: … })`. */
function solidTiff(width: number, height: number, rgb: [number, number, number]): Promise<Buffer> {
  return maple(solidRgb(width, height, rgb))
    .toFormat('tiff')
    .toBuffer();
}

async function fixturePresent(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('renderImageThumbToFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'render-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('quality parameter reaches the AVIF encoder — different quality → different bytes', async () => {
    // Guards that req.quality from the IPC message actually flows through to
    // the encoder; if it were silently ignored, both renders would be identical.
    const src = path.join(dir, 'q.png');
    const hi = path.join(dir, 'hi.avif');
    const lo = path.join(dir, 'lo.avif');
    await writeFile(src, await solidPng(64, 64, [100, 150, 200]));

    await renderImageThumbToFile(src, hi, 64, 'png', 95);
    await renderImageThumbToFile(src, lo, 64, 'png', 20);

    const hiBytes = await readFile(hi);
    const loBytes = await readFile(lo);
    // High quality → larger file; low quality → smaller. Different bytes.
    expect(hiBytes.length).toBeGreaterThan(loBytes.length);
    expect(hiBytes.equals(loBytes)).toBe(false);
  });

  it('renders an uncompressed TIFF down to a bounded AVIF thumb', async () => {
    // Pipeline smoke test against the real Maple decoder: a TIFF in, a
    // size-bounded AVIF out. Guards the decode → rotate → resize → encode
    // chain itself (the options guard below can't catch a broken pipeline).
    const src = path.join(dir, 'x.tif');
    const out = path.join(dir, 'x_1280.avif');
    await writeFile(src, await solidTiff(2048, 1536, [120, 80, 40]));

    const ok = await renderImageThumbToFile(src, out, 1280, 'tif');
    expect(ok).toBe(true);

    const meta = await maple(out).metadata();
    expect(meta.format).toBe('avif');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1280);
  });

  it('dispatches PSD through the ag-psd decode branch to a bounded AVIF thumb', async () => {
    const src = path.join(dir, 'x.psd');
    const out = path.join(dir, 'x_256.avif');
    await writeFile(src, buildSyntheticPsd(64, 48, [200, 60, 30, 255]));

    const ok = await renderImageThumbToFile(src, out, 256, 'psd');
    expect(ok).toBe(true);

    const meta = await maple(out).metadata();
    expect(meta.format).toBe('avif');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(256);
  });

  it('dispatches HDR through the tone-mapping decode branch to a bounded AVIF thumb (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HDR))) return; // fixture missing → soft pass
    const out = path.join(dir, 'hdr_256.avif');

    const ok = await renderImageThumbToFile(FIXTURE_HDR, out, 256, 'hdr');
    expect(ok).toBe(true);

    const meta = await maple(out).metadata();
    expect(meta.format).toBe('avif');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(256);
  });
});

describe('renderImageThumbToFile — HEIC parity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'render-heic-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // render.ts owns the HEIC chain directly (no Worker-thread indirection):
  // the generic `ext === 'heic'` dispatch through `renderImageThumbToFile`
  // must reach the exact same `renderHeicThumbToFile` chain a direct call
  // does. Guards the dispatch itself, not the codec — both calls go through
  // production code, so this is a smoke test on wiring, not a duplicate of
  // the codec-level "writes a valid AVIF" test below.
  it('dispatch through renderImageThumbToFile matches a direct renderHeicThumbToFile call (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HEIC))) return; // fixture missing → soft pass

    const viaDispatch = path.join(dir, 'via-dispatch.avif');
    const viaDirect = path.join(dir, 'via-direct.avif');

    const ok = await renderImageThumbToFile(FIXTURE_HEIC, viaDispatch, 48, 'heic');
    expect(ok).toBe(true);
    await renderHeicThumbToFile(FIXTURE_HEIC, viaDirect, 48);

    const dispatchMeta = await maple(viaDispatch).metadata();
    const directMeta = await maple(viaDirect).metadata();
    expect(dispatchMeta.format).toBe('avif');
    expect([dispatchMeta.width, dispatchMeta.height]).toEqual([
      directMeta.width,
      directMeta.height,
    ]);
  });

  it('renderHeicThumbToFile writes a valid AVIF (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HEIC))) return;

    const out = path.join(dir, 'heic.avif');
    await renderHeicThumbToFile(FIXTURE_HEIC, out, 48);
    const meta = await maple(out).metadata();
    expect(meta.format).toBe('avif');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(48);
  });
});
