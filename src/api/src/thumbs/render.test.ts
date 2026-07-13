import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { writePsdBuffer } from 'ag-psd';
import {
  renderImageThumbToFile,
  renderHeicThumbToFile,
  THUMB_AVIF_QUALITY,
  THUMB_AVIF_EFFORT,
} from './render.ts';

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

async function fixturePresent(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The exact HEIC chain as it stood before the child-process offload — inlined
 * here so the equivalence assertion compares the production path against an
 * independent reference, not a tautology against the shared helper.
 */
async function renderHeicInlineReference(
  srcPath: string,
  thumbPath: string,
  sizePx: number,
): Promise<void> {
  const inputBuffer = await readFile(srcPath);
  const jpegBuffer = (await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.9,
  })) as Buffer;
  const buf = await sharp(jpegBuffer, { failOn: 'none' })
    .rotate()
    .resize(sizePx, sizePx, { fit: 'inside', withoutEnlargement: true })
    .avif({ quality: THUMB_AVIF_QUALITY, effort: THUMB_AVIF_EFFORT })
    .toBuffer();
  const tmp = `${thumbPath}.${process.pid}.inline.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, thumbPath);
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
    const pngBuf = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer();
    await writeFile(src, pngBuf);

    await renderImageThumbToFile(src, hi, 64, 'png', 95);
    await renderImageThumbToFile(src, lo, 64, 'png', 20);

    const hiBytes = await readFile(hi);
    const loBytes = await readFile(lo);
    // High quality → larger file; low quality → smaller. Different bytes.
    expect(hiBytes.length).toBeGreaterThan(loBytes.length);
    expect(hiBytes.equals(loBytes)).toBe(false);
  });

  it('renders an uncompressed TIFF down to a bounded AVIF thumb', async () => {
    // Pipeline smoke test against the real sharp/libvips: a TIFF in, a
    // size-bounded AVIF out. Guards the decode → rotate → resize → encode
    // chain itself (the options guard below can't catch a broken pipeline).
    const src = path.join(dir, 'x.tif');
    const out = path.join(dir, 'x_1280.avif');
    const buf = await sharp({
      create: {
        width: 2048,
        height: 1536,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    })
      .tiff({ compression: 'none' })
      .toBuffer();
    await writeFile(src, buf);

    const ok = await renderImageThumbToFile(src, out, 1280, 'tif');
    expect(ok).toBe(true);

    const meta = await sharp(out).metadata();
    // sharp has no distinct "avif" format label — AVIF is a HEIF profile, so
    // a real AVIF file reports format:"heif" here (confirmed against this
    // sharp build: `sharp.format.heif.output.alias` includes "avif").
    expect(meta.format).toBe('heif');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1280);
  });

  it('dispatches PSD through the ag-psd decode branch to a bounded AVIF thumb', async () => {
    const src = path.join(dir, 'x.psd');
    const out = path.join(dir, 'x_256.avif');
    await writeFile(src, buildSyntheticPsd(64, 48, [200, 60, 30, 255]));

    const ok = await renderImageThumbToFile(src, out, 256, 'psd');
    expect(ok).toBe(true);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('heif');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });

  it('dispatches HDR through the tone-mapping decode branch to a bounded AVIF thumb (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HDR))) return; // fixture missing → soft pass
    const out = path.join(dir, 'hdr_256.avif');

    const ok = await renderImageThumbToFile(FIXTURE_HDR, out, 256, 'hdr');
    expect(ok).toBe(true);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('heif');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });

  // The regression this file exists for: large single-strip TIFFs were
  // aborting decode against libvips' 50 MiB cumulated-malloc cap
  // (TIFFOpenOptionsSetMaxCumulatedMemAlloc), lifted only by the loader's
  // `unlimited` flag. A "bigger fixture" test can't pin this down — that cap
  // fires on libtiff's directory-array path, not on normal pixel decode, so a
  // large valid TIFF still decodes with the flag removed (and the size at
  // which it would trip is libtiff-version-specific). Instead, assert the
  // contract directly: the render path opens inputs with `unlimited: true`
  // (and `failOn: "none"`). Drop the flag and this fails deterministically,
  // regardless of the libvips/libtiff build CI happens to ship.
  it('opens decode inputs with libvips DoS caps lifted (unlimited)', async () => {
    const realSharp = (await import('sharp')).default;
    const seenOpts: unknown[] = [];
    const stub = ((_input: unknown, opts?: unknown) => {
      seenOpts.push(opts);
      const chain = {
        rotate: () => chain,
        resize: () => chain,
        avif: () => chain,
        toBuffer: async () => Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]), // minimal AVIF ftyp box
      };
      return chain;
    }) as unknown as typeof realSharp;

    mock.module('sharp', () => ({ default: stub }));
    try {
      const mod = await import('./render.ts');
      const ok = await mod.renderImageThumbToFile(
        path.join(dir, 'y.tif'),
        path.join(dir, 'y_1280.avif'),
        1280,
        'tif',
      );
      expect(ok).toBe(true);
      expect(seenOpts).toContainEqual({ failOn: 'none', unlimited: true });
    } finally {
      // Restore the real module so other suites in the run keep real sharp.
      mock.module('sharp', () => ({ default: realSharp }));
    }
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

  // Moved from the deleted heic-pool.test.ts. render.ts now owns the HEIC
  // chain directly (no Worker-thread indirection), so the parity assertion
  // lives here alongside the other render.ts tests.
  it('produces bytes identical to the pre-offload inline chain (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HEIC))) return; // fixture missing → soft pass

    const viaRender = path.join(dir, 'via-render.avif');
    const viaInline = path.join(dir, 'via-inline.avif');

    const ok = await renderImageThumbToFile(FIXTURE_HEIC, viaRender, 48, 'heic');
    expect(ok).toBe(true);

    await renderHeicInlineReference(FIXTURE_HEIC, viaInline, 48);

    const renderBytes = await readFile(viaRender);
    const inlineBytes = await readFile(viaInline);
    expect(renderBytes.equals(inlineBytes)).toBe(true);
  });

  it('renderHeicThumbToFile writes a valid AVIF (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HEIC))) return;

    const out = path.join(dir, 'heic.avif');
    await renderHeicThumbToFile(FIXTURE_HEIC, out, 48);
    const meta = await sharp(out).metadata();
    // sharp has no distinct "avif" format label — AVIF is a HEIF profile, so
    // a real AVIF file reports format:"heif" here (confirmed against this
    // sharp build: `sharp.format.heif.output.alias` includes "avif").
    expect(meta.format).toBe('heif');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(48);
  });
});
