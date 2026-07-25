/**
 * Coverage for the decode-based AVIF check predicate (#2011, extracted from
 * `thumbs/validate-avif.ts` into its own module by #2257 so the parent
 * process never imports sharp): a completed-but-corrupt encode (truncated
 * write, wrong dimensions, an unexpected embedded profile or colourspace, a
 * stray orientation tag) must be rejected. This file tests `checkAvifOutput`
 * directly — no IPC, no child process — the same real-decode assertions
 * `validate-avif.test.ts` used to make against `validateAvifOutput` before
 * that function became a pool dispatcher. Dispatch/publish behaviour (the
 * parent-side half) is covered in `validate-avif.test.ts`.
 *
 * Uses `node:fs/promises` directly (mkdtemp/writeFile/rm temp fixtures) —
 * allowlisted in `.oxlintrc.json`, same as the rest of `src/thumbs/`: these
 * are throwaway test fixtures, not durable derived-artefact writes, so the
 * backup-mirror machinery in `fs/mirrored.ts` doesn't apply.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { checkAvifOutput } from './avif-checks.ts';
import type * as AvifChecksModule from './avif-checks.ts';

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

/** Swap in a fake `sharp` default export that returns fixed metadata and a
 * successful raw decode, for the two colour/orientation edge cases the real
 * AV1 encoder can't actually produce (AVIF has no non-RGB colour mode, and
 * this sharp/libheif build never round-trips an orientation tag into AVIF —
 * confirmed empirically against the pinned sharp version). Restores the real
 * module in `finally`. */
async function withStubbedMetadata<T>(
  metadata: Record<string, unknown>,
  fn: (mod: typeof AvifChecksModule) => Promise<T>,
): Promise<T> {
  const realSharp = (await import('sharp')).default;
  const stub = ((_input: unknown, _opts?: unknown) => ({
    metadata: async () => metadata,
    raw: () => ({ toBuffer: async () => Buffer.alloc(4) }),
  })) as unknown as typeof realSharp;
  mock.module('sharp', () => ({ default: stub }));
  try {
    const mod = await import('./avif-checks.ts');
    return await fn(mod);
  } finally {
    mock.module('sharp', () => ({ default: realSharp }));
  }
}

describe('checkAvifOutput', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'avif-checks-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a genuine AVIF downscaled to the tier target', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const file = path.join(dir, 'ok.avif');
    await writeFile(file, buf);

    const result = await checkAvifOutput(file, 1280);
    expect(result.ok).toBe(true);
  });

  it('accepts a source smaller than the tier target (no upscale)', async () => {
    const buf = await encodeAvif({ width: 300, height: 150, resizeToLongEdge: 1280 });
    const file = path.join(dir, 'small.avif');
    await writeFile(file, buf);

    const result = await checkAvifOutput(file, 1280);
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

    const result = await checkAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/pixel decode failed/i);
  });

  it('rejects dimensions that exceed the tier target beyond tolerance', async () => {
    // No resize applied — simulates a bug where the encoder ignored maxPx.
    const buf = await encodeAvif({ width: 2000, height: 1000 });
    const file = path.join(dir, 'oversized.avif');
    await writeFile(file, buf);

    const result = await checkAvifOutput(file, 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/dimensions/i);
  });

  it('rejects an oversized image WITHOUT performing a full pixel decode', async () => {
    // Regression for jules review on PR #2011/#2014: the dimension check
    // must run before `.raw().toBuffer()`, not after — otherwise a wildly
    // oversized AVIF (e.g. from `copyImageAsThumb`'s fallback handing this
    // validator arbitrary-but-AVIF-shaped bytes, or the exact class of
    // resize bug this validator exists to catch) gets fully decoded into
    // memory before being rejected for being oversized, an OOM/DoS risk.
    // Stubs sharp to report huge declared dimensions and tracks whether
    // `.raw()` is ever reached.
    const realSharp = (await import('sharp')).default;
    let rawCalled = false;
    const stub = ((_input: unknown, _opts?: unknown) => ({
      metadata: async () => ({
        format: 'heif',
        compression: 'av1',
        width: 50000,
        height: 50000,
        orientation: 1,
        space: 'srgb',
        hasProfile: false,
      }),
      raw: () => {
        rawCalled = true;
        return { toBuffer: async () => Buffer.alloc(4) };
      },
    })) as unknown as typeof realSharp;
    mock.module('sharp', () => ({ default: stub }));
    try {
      const mod = await import('./avif-checks.ts');
      const result = await mod.checkAvifOutput(path.join(dir, 'huge.avif'), 1280);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/dimensions/i);
      expect(rawCalled).toBe(false);
    } finally {
      mock.module('sharp', () => ({ default: realSharp }));
    }
  });

  it('rejects an AVIF carrying an embedded ICC profile', async () => {
    // This pipeline's AVIF outputs are untagged sRGB by convention — an
    // attached profile means the encoder did something we didn't ask for.
    const buf = await encodeAvif({ width: 800, height: 400, withIcc: true });
    const file = path.join(dir, 'icc.avif');
    await writeFile(file, buf);

    const result = await checkAvifOutput(file, 1280);
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

    const result = await checkAvifOutput(file, 1280);
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
      (mod: typeof AvifChecksModule) => mod.checkAvifOutput(path.join(dir, 'whatever.avif'), 1280),
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
      (mod: typeof AvifChecksModule) => mod.checkAvifOutput(path.join(dir, 'whatever.avif'), 1280),
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
      (mod: typeof AvifChecksModule) => mod.checkAvifOutput(path.join(dir, 'whatever.avif'), 1280),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/colourspace/i);
  });
});
