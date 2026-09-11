/**
 * Coverage for the decode-based AVIF check predicate (#2011, extracted from
 * `thumbs/validate-avif.ts` into its own module by #2257 so the parent
 * process never imports the native bitmap bindings): a completed-but-corrupt
 * encode (truncated write, wrong dimensions, a stray orientation tag) must
 * be rejected. This file tests `checkAvifOutput` directly — no IPC, no
 * child process — the same real-decode assertions `validate-avif.test.ts`
 * used to make against `validateAvifOutput` before that function became a
 * pool dispatcher. Dispatch/publish behaviour (the parent-side half) is
 * covered in `validate-avif.test.ts`.
 *
 * Fixtures come from `test-support/synth-image.ts` (Maple-encoded), not disk
 * files or `sharp({ create: … })` (#3499/#3500).
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maple } from 'maple';
import { checkAvifOutput } from './avif-checks.ts';
import { solidAvif, solidJpeg } from '../test-support/synth-image.ts';

describe('checkAvifOutput (maple)', () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), 'avif-checks-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('accepts a well-formed AVIF within the size bound', () =>
    withDir(async (dir) => {
      const p = join(dir, 'ok.avif');
      await writeFile(p, await solidAvif(200, 100, [10, 20, 30]));
      expect(await checkAvifOutput(p, 256)).toEqual({ ok: true });
    }));

  it('rejects a non-AVIF container', () =>
    withDir(async (dir) => {
      const p = join(dir, 'not.avif');
      await writeFile(p, await solidJpeg(20, 20, [1, 1, 1]));
      const r = await checkAvifOutput(p, 256);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('unexpected format');
    }));

  it('rejects dimensions over the expected long edge (+4px tolerance)', () =>
    withDir(async (dir) => {
      const p = join(dir, 'big.avif');
      await writeFile(p, await solidAvif(300, 50, [5, 5, 5]));
      const r = await checkAvifOutput(p, 256);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('exceed expected long edge');
    }));

  it('rejects a truncated AVIF on the pixel-decode check', () =>
    withDir(async (dir) => {
      const full = await solidAvif(120, 80, [200, 100, 50]);
      const p = join(dir, 'trunc.avif');
      await writeFile(p, full.subarray(0, Math.floor(full.length * 0.6)));
      const r = await checkAvifOutput(p, 256);
      expect(r.ok).toBe(false);
    }));

  // #2011/#2014 ordering guard: the cheap dimension check must reject BEFORE
  // the expensive full pixel decode ever runs — otherwise a wildly-oversized
  // AVIF (the exact class of resize bug this validator exists to catch) gets
  // fully decoded into memory before being rejected, an OOM/DoS risk. Build
  // an AVIF larger than the expected long edge, then corrupt its tail
  // (same length, so the container/`ispe` header still parses) — if the
  // dimension check ran AFTER (or instead of) the pixel-decode check, this
  // file would surface a decode-failure reason instead of a dimensions one.
  it('rejects an oversized AVIF on dimensions even when its tail is corrupted', () =>
    withDir(async (dir) => {
      const full = await solidAvif(300, 50, [5, 5, 5]);
      const corrupted = Buffer.from(full);
      corrupted.fill(0, corrupted.length - 40, corrupted.length);
      const p = join(dir, 'big-corrupt.avif');
      await writeFile(p, corrupted);

      // Sanity check the premise: the header/`ispe` probe must still
      // succeed despite the tail corruption, or this test isn't actually
      // exercising the ordering guard (it'd just be re-testing "rejects a
      // truncated AVIF on the pixel-decode check" above under a different
      // name).
      const probed = await maple(p).metadata();
      expect(probed.width).toBeGreaterThan(0);

      const r = await checkAvifOutput(p, 256);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('exceed expected long edge');
    }));
});
