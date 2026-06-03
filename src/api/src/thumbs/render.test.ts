import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { renderImageThumbToFile, renderHeicThumbToFile } from './render.ts';

// `import.meta.dir` is src/api/src/thumbs; fixture lives under src/api/tests/fixtures.
const FIXTURE_HEIC = path.resolve(import.meta.dir, '..', '..', 'tests', 'fixtures', 'sample.heic');

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
    .jpeg({ quality: 82, mozjpeg: true })
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

  it('renders an uncompressed TIFF down to a bounded JPEG thumb', async () => {
    // Pipeline smoke test against the real sharp/libvips: a TIFF in, a
    // size-bounded JPEG out. Guards the decode → rotate → resize → encode
    // chain itself (the options guard below can't catch a broken pipeline).
    const src = path.join(dir, 'x.tif');
    const out = path.join(dir, 'x_1280.jpg');
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
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1280);
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
        jpeg: () => chain,
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), // minimal JPEG SOI/EOI
      };
      return chain;
    }) as unknown as typeof realSharp;

    mock.module('sharp', () => ({ default: stub }));
    try {
      const mod = await import('./render.ts');
      const ok = await mod.renderImageThumbToFile(
        path.join(dir, 'y.tif'),
        path.join(dir, 'y_1280.jpg'),
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

    const viaRender = path.join(dir, 'via-render.jpg');
    const viaInline = path.join(dir, 'via-inline.jpg');

    const ok = await renderImageThumbToFile(FIXTURE_HEIC, viaRender, 48, 'heic');
    expect(ok).toBe(true);

    await renderHeicInlineReference(FIXTURE_HEIC, viaInline, 48);

    const renderBytes = await readFile(viaRender);
    const inlineBytes = await readFile(viaInline);
    expect(renderBytes.equals(inlineBytes)).toBe(true);
  });

  it('renderHeicThumbToFile writes a valid JPEG (fixture-gated)', async () => {
    if (!(await fixturePresent(FIXTURE_HEIC))) return;

    const out = path.join(dir, 'heic.jpg');
    await renderHeicThumbToFile(FIXTURE_HEIC, out, 48);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(48);
  });
});
