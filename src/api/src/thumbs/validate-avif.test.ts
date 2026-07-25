/**
 * Coverage for the parent-side AVIF validation dispatcher (#2011, reworked by
 * #2257 to dispatch to the isolated `imgdecode` child instead of calling
 * `sharp` inline in the API process): `validateAvifOutput` must forward to
 * the pool and map its result faithfully, a dispatch failure (child spawn
 * failure or crash) must be caught and turned into a validation failure
 * rather than an unhandled rejection, and `publishValidatedAvif` must never
 * leave an invalid (or unverified) file at the real cache path.
 *
 * The actual decode-based check semantics (format/dimensions/orientation/
 * colourspace/full-decode) now live in `thumbs/avif-checks.ts` and are tested
 * directly there (`avif-checks.test.ts`) — this file only exercises the
 * dispatch + publish wiring. `validateAvifViaPool` is stubbed via `spyOn` to
 * call the real `checkAvifOutput` predicate in-process (never a real child
 * process) so the "happy path" tests below stay decode-verified rather than
 * asserted-by-mock, without spawning a real `imgdecode` child from this unit
 * test file — see `routes/preview.test.ts`'s module doc for why spawning real
 * decode children from several test files destabilises the shared pool
 * singleton under CI's constrained resources. The real IPC round-trip
 * (`validate` dispatched over Bun IPC to the actual child) is covered by
 * `imgdecode-pool.test.ts`'s own integration test.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import type { Logger } from 'pino';
import { validateAvifOutput, publishValidatedAvif, finalizeAvifRender } from './validate-avif.ts';
import { checkAvifOutput } from './avif-checks.ts';
import * as imgdecodePoolModule from './imgdecode-pool.ts';

/** Build a genuine AVIF via the real sharp/libheif encoder — same shape as
 * `thumbs/render.ts`'s pipeline. `effort: 2` keeps the AV1 encode fast;
 * correctness here doesn't depend on encode effort. */
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

/**
 * Installed fresh for every test (not at module scope) so a test that
 * overrides it (the dispatch-failure cases below) can't leak its override
 * into a sibling test — same discipline `routes/preview.test.ts` documents
 * at length for its own `renderImageThumbToFileViaPool` stub.
 */
let poolSpy: ReturnType<typeof spyOn> | null = null;

/** Default stub: forward to the real predicate in-process — decode-verified,
 * never a real child process. Individual tests override this via
 * `poolSpy?.mockImplementation(...)` / `mockRejectedValue(...)` to exercise
 * the dispatch-failure path. */
beforeEach(() => {
  poolSpy = spyOn(imgdecodePoolModule, 'validateAvifViaPool').mockImplementation(
    (filePath: string, expectedLongEdgePx: number) => checkAvifOutput(filePath, expectedLongEdgePx),
  );
});

afterEach(() => {
  poolSpy?.mockRestore();
  poolSpy = null;
});

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

  it('never imports sharp — the decode moved off-process (#2257)', () => {
    // Structural regression guard: if someone moves the decode back inline,
    // this file will re-acquire a static `import sharp from 'sharp'`. Assert
    // against the source text rather than a runtime hook, since the whole
    // point is that this module must not even reference the sharp package —
    // a full pixel decode of a freshly-written, possibly-malformed AVIF has
    // no business running inside the HTTP server process (see this file's
    // module doc, and `imgdecode-pool.ts`'s "Why off-PROCESS" doc).
    const src = readFileSync(path.join(import.meta.dir, 'validate-avif.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]sharp['"]/);
  });
});

describe('validateAvifOutput — dispatch failure', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'validate-avif-dispatch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a validation failure (not a throw) when the child fails to spawn', async () => {
    poolSpy?.mockRejectedValueOnce(
      new Error('imgdecode-pool: failed to spawn worker — spawn ENOENT'),
    );

    const result = await validateAvifOutput(path.join(dir, 'whatever.avif'), 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/validation dispatch failed/i);
      expect(result.reason).toMatch(/spawn ENOENT/);
    }
  });

  it('reports a validation failure when the child crashes mid-decode', async () => {
    poolSpy?.mockRejectedValueOnce(new Error('imgdecode-pool: worker errored — segfault'));

    const result = await validateAvifOutput(path.join(dir, 'whatever.avif'), 1280);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/validation dispatch failed/i);
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

  it('discards the temp file and never publishes when the child crashes (dispatch failure)', async () => {
    // The critical crash-surface guarantee this ticket exists for: a
    // validation dispatch failure must degrade exactly like a validation
    // FAILURE, never like a validation success. `tmpPath` is removed and
    // `finalPath` is never touched.
    const buf = await encodeAvif({ width: 800, height: 400, resizeToLongEdge: 1280 });
    const tmp = path.join(dir, 'crash.avif.tmp.123.abc');
    const final = path.join(dir, 'crash.avif');
    await writeFile(tmp, buf);
    const { log, warnCalls } = fakeLogger();
    poolSpy?.mockRejectedValueOnce(new Error('imgdecode-pool: worker errored — segfault'));

    const ok = await publishValidatedAvif(tmp, final, 1280, log, {
      assetPath: '/library/photo-crash.jpg',
      tier: 'thumb',
    });

    expect(ok).toBe(false);
    await expect(stat(tmp)).rejects.toThrow();
    await expect(stat(final)).rejects.toThrow(); // never published

    expect(warnCalls.length).toBe(1);
    const [fields] = warnCalls[0];
    expect(fields.reason).toMatch(/validation dispatch failed/i);
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

  it('never publishes when the render succeeded but validation dispatch crashes', async () => {
    const buf = await encodeAvif({ width: 2000, height: 1000, resizeToLongEdge: 1280 });
    const tmp = path.join(dir, 'z.avif.tmp.1.a');
    const final = path.join(dir, 'z.avif');
    await writeFile(tmp, buf);
    const { log } = fakeLogger();
    poolSpy?.mockRejectedValueOnce(new Error('imgdecode-pool: failed to spawn worker'));

    const ok = await finalizeAvifRender(true, tmp, final, 1280, log, {
      assetPath: '/library/photo5.jpg',
      tier: 'preview',
    });

    expect(ok).toBe(false);
    await expect(stat(final)).rejects.toThrow();
    await expect(stat(tmp)).rejects.toThrow(); // still cleaned up
  });
});
