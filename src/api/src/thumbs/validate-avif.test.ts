/**
 * Coverage for the decode-based AVIF cache validation gate (#2011): a
 * completed-but-corrupt encode (truncated write, wrong dimensions, an
 * unexpected embedded profile or colourspace, a stray orientation tag) must
 * be rejected before it's treated as a good `.maple/thumbs|previews` cache
 * entry, and `publishValidatedAvif` must never leave an invalid file at the
 * real cache path.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import type { Logger } from 'pino';
import { validateAvifOutput, publishValidatedAvif, finalizeAvifRender } from './validate-avif.ts';
import type * as ValidateAvifModule from './validate-avif.ts';

/** Build a genuine AVIF via the real sharp/libheif encoder — same shape as
 * `thumbs/render.ts`'s pipeline: a raw RGB buffer, optionally resized with
 * `fit: 'inside', withoutEnlargement: true` (this pipeline's resize
 * contract), optionally with an ICC profile attached. `effort: 2` keeps the
 * AV1 encode fast; correctness here doesn't depend on encode effort. */
async function encodeAvif(opts: {
  width: number;
  height: number;
  resizeToLongEdge?: number;
  withIcc?: boolean;
}): Promise<Buffer> {
  const { width, height } = opts;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 251;
  let pipeline = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.resizeToLongEdge) {
    pipeline = pipeline.resize(opts.resizeToLongEdge, opts.resizeToLongEdge, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  if (opts.withIcc) pipeline = pipeline.withIccProfile('srgb');
  return pipeline.avif({ quality: 60, effort: 2 }).toBuffer();
}

interface FakeLog {
  log: Logger;
  warnCalls: Array<[Record<string, unknown>, string]>;
}

function fakeLogger(): FakeLog {
  const warnCalls: Array<[Record<string, unknown>, string]> = [];
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) => {
      warnCalls.push([obj, msg]);
    },
    info: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  } as unknown as Logger;
  return { log, warnCalls };
}

/** Swap in a fake `sharp` default export that returns fixed metadata and a
 * successful raw decode, for the two colour/orientation edge cases the real
 * AV1 encoder can't actually produce (AVIF has no non-RGB colour mode, and
 * this sharp/libheif build never round-trips an orientation tag into AVIF —
 * confirmed empirically against the pinned sharp version). Restores the real
 * module in `finally`. */
async function withStubbedMetadata<T>(
  metadata: Record<string, unknown>,
  fn: (mod: typeof ValidateAvifModule) => Promise<T>,
): Promise<T> {
  const realSharp = (await import('sharp')).default;
  const stub = ((_input: unknown, _opts?: unknown) => ({
    metadata: async () => metadata,
    raw: () => ({ toBuffer: async () => Buffer.alloc(4) }),
  })) as unknown as typeof realSharp;
  mock.module('sharp', () => ({ default: stub }));
  try {
    const mod = await import('./validate-avif.ts');
    return await fn(mod);
  } finally {
    mock.module('sharp', () => ({ default: realSharp }));
  }
}

describe('validateAvifOutput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'validate-avif-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a genuine AVIF downscaled to the tier target', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const file = path.join(dir, 'ok.avif');
    await writeFile(file, buf);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(true);
  });

  it('accepts a source smaller than the tier target (no upscale)', async () => {
    const buf = await encodeAvif({ width: 300, height: 150, resizeToLongEdge: 1280 });
    const file = path.join(dir, 'small.avif');
    await writeFile(file, buf);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(true);
  });

  it('rejects a truncated/corrupt encode even though the header still parses', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const truncated = buf.subarray(0, Math.floor(buf.length / 2));
    const file = path.join(dir, 'truncated.avif');
    await writeFile(file, truncated);

    // Sanity check on the premise this test guards: metadata() alone must
    // NOT already catch this, or the "full pixel decode" step is dead code.
    const headerOnly = await sharp(file, { failOn: 'none' }).metadata();
    expect(headerOnly.width).toBeGreaterThan(0);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pixel decode failed/i);
  });

  it('rejects dimensions that exceed the tier target beyond tolerance', async () => {
    // No resize applied — simulates a bug where the encoder ignored maxPx.
    const buf = await encodeAvif({ width: 2000, height: 1000 });
    const file = path.join(dir, 'oversized.avif');
    await writeFile(file, buf);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/dimensions/i);
  });

  it('rejects an AVIF carrying an embedded ICC profile', async () => {
    // This pipeline's AVIF outputs are untagged sRGB by convention — an
    // attached profile means the encoder did something we didn't ask for.
    const buf = await encodeAvif({ width: 800, height: 400, withIcc: true });
    const file = path.join(dir, 'icc.avif');
    await writeFile(file, buf);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/icc profile/i);
  });

  it('rejects non-AVIF bytes written to an AVIF-named path', async () => {
    const jpegBuf = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const file = path.join(dir, 'not-really-avif.avif');
    await writeFile(file, jpegBuf);

    const result = await validateAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/format|compression/i);
  });

  it('rejects a HEIC file (same "heif" format family, wrong compression) at an AVIF-named path', async () => {
    const result = await withStubbedMetadata(
      {
        format: 'heif',
        compression: 'hevc',
        width: 1280,
        height: 640,
        orientation: 1,
        space: 'srgb',
        hasProfile: false,
      },
      (mod: typeof ValidateAvifModule) =>
        mod.validateAvifOutput(path.join(dir, 'whatever.avif'), 1280),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/format|compression/i);
  });

  it('rejects an unexpected orientation tag', async () => {
    const result = await withStubbedMetadata(
      {
        format: 'heif',
        compression: 'av1',
        width: 1280,
        height: 640,
        orientation: 6,
        space: 'srgb',
        hasProfile: false,
      },
      (mod: typeof ValidateAvifModule) =>
        mod.validateAvifOutput(path.join(dir, 'whatever.avif'), 1280),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/orientation/i);
  });

  it('rejects an unexpected decoded colourspace', async () => {
    const result = await withStubbedMetadata(
      {
        format: 'heif',
        compression: 'av1',
        width: 1280,
        height: 640,
        orientation: 1,
        space: 'cmyk',
        hasProfile: false,
      },
      (mod: typeof ValidateAvifModule) =>
        mod.validateAvifOutput(path.join(dir, 'whatever.avif'), 1280),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/colourspace/i);
  });
});

describe('publishValidatedAvif', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'publish-avif-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes a valid temp file to the final path and removes the temp file', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const tmp = path.join(dir, 'final.avif.tmp.123.abc');
    const final = path.join(dir, 'final.avif');
    await writeFile(tmp, buf);
    const { log, warnCalls } = fakeLogger();

    const ok = await publishValidatedAvif(tmp, final, 1280, log, {
      assetPath: '/library/photo.jpg',
      tier: 'preview',
    });

    expect(ok).toBe(true);
    expect(warnCalls).toEqual([]);
    const published = await readFile(final);
    expect(published.equals(buf)).toBe(true);
    await expect(stat(tmp)).rejects.toThrow();
  });

  it('discards an invalid temp file, never creates the final path, and logs context', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const truncated = buf.subarray(0, Math.floor(buf.length / 2));
    const tmp = path.join(dir, 'final2.avif.tmp.123.abc');
    const final = path.join(dir, 'final2.avif');
    await writeFile(tmp, truncated);
    const { log, warnCalls } = fakeLogger();

    const ok = await publishValidatedAvif(tmp, final, 1280, log, {
      assetPath: '/library/photo2.jpg',
      tier: 'thumb',
    });

    expect(ok).toBe(false);
    await expect(stat(tmp)).rejects.toThrow();
    await expect(stat(final)).rejects.toThrow();

    expect(warnCalls.length).toBe(1);
    const [fields, msg] = warnCalls[0];
    expect(fields.assetPath).toBe('/library/photo2.jpg');
    expect(fields.tier).toBe('thumb');
    expect(fields.finalPath).toBe(final);
    expect(typeof fields.reason).toBe('string');
    expect(msg).toMatch(/validation failed/i);
  });
});

describe('finalizeAvifRender', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'finalize-avif-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discards the temp file without validating when the render itself failed', async () => {
    // A render function that reports failure but still left bytes at
    // tmpPath (e.g. a partial write before the failure) — finalizeAvifRender
    // must not treat that leftover as worth validating; it just cleans up.
    const tmp = path.join(dir, 'x.avif.tmp.1.a');
    const final = path.join(dir, 'x.avif');
    await writeFile(tmp, 'partial garbage from a failed render');
    const { log, warnCalls } = fakeLogger();

    const ok = await finalizeAvifRender(false, tmp, final, 1280, log, {
      assetPath: '/library/photo3.jpg',
      tier: 'thumb',
    });

    expect(ok).toBe(false);
    expect(warnCalls).toEqual([]); // the render-failure path logs elsewhere, not here
    await expect(stat(tmp)).rejects.toThrow();
    await expect(stat(final)).rejects.toThrow();
  });

  it('validates and publishes when the render succeeded', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const tmp = path.join(dir, 'y.avif.tmp.1.a');
    const final = path.join(dir, 'y.avif');
    await writeFile(tmp, buf);
    const { log } = fakeLogger();

    const ok = await finalizeAvifRender(true, tmp, final, 1280, log, {
      assetPath: '/library/photo4.jpg',
      tier: 'preview',
    });

    expect(ok).toBe(true);
    await expect(stat(final)).resolves.toBeDefined();
    await expect(stat(tmp)).rejects.toThrow();
  });
});
