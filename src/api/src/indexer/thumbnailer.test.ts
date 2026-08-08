/**
 * Regression coverage for the critical thumbnailer guard: video containers,
 * metadata-only stub images (eip/braw/afphoto/ai), and audio (mp3/wav/m4a/aac)
 * must never fall through to `copyImageAsThumb`, which would copy the raw
 * source bytes verbatim to a `.jpg`-named thumb path — served by
 * `/api/thumb/...` as garbage `image/jpeg`. See #1835.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateThumb } from './thumbnailer.ts';
import { generatePreview } from './previewer.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';

const NO_PREVIEW_SOURCES = [
  ['clip.mov', 'not a real quicktime file'],
  ['scan.eip', 'not a real phase one file'],
  ['session.braw', 'not a real blackmagic raw file'],
  ['project.afphoto', 'not a real affinity photo file'],
  ['logo.ai', 'not a real illustrator file'],
  ['track.mp3', 'not a real mp3 file'],
  ['voice.wav', 'not a real wav file'],
  ['memo.m4a', 'not a real m4a file'],
  ['song.aac', 'not a real aac file'],
] as const;

describe('generateThumb — no-preview guard', () => {
  for (const [filename, contents] of NO_PREVIEW_SOURCES) {
    it(`never copies raw source bytes to the thumb path for ${filename}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnailer-guard-'));
      try {
        const srcPath = path.join(dir, filename);
        const thumbPath = path.join(dir, 'thumb.jpg');
        await fs.writeFile(srcPath, contents);

        await generateThumb(srcPath, thumbPath);

        // The critical assertion: no thumb file was written at all — the
        // guard must return before `copyImageAsThumb` ever runs. If this
        // regresses, the raw non-image bytes get copied to thumbPath and
        // served as fake image/jpeg.
        await expect(fs.stat(thumbPath)).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('generateThumb — X3F (Sigma Foveon) regression (#2413)', () => {
  // test_0016.X3F always failed: extract_embedded_preview unconditionally
  // called rawler's `X3fDecoder::raw_metadata`, which is a `todo!()` — the
  // panic degraded to a hard Err, so the FFI call returned rc 11 and no
  // thumb was ever written, no matter how many times the route was hit.
  // Fixture-gated (matches the repo's soft-pass convention): skips cleanly
  // when `test-fixtures/raws/test_0016.X3F` or the built libraw_ffi dylib
  // isn't present on this machine.
  it('writes a non-empty AVIF thumb for test_0016.X3F when fixtures + FFI are available', async () => {
    const x3fPath = path.resolve(process.cwd(), '../../test-fixtures/raws/test_0016.X3F');
    try {
      await fs.stat(x3fPath);
    } catch {
      return; // soft pass: no fixture
    }
    if (!ffiPool().available()) {
      return; // soft pass: libraw_ffi.dylib not built on this machine
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnailer-x3f-'));
    try {
      const thumbPath = path.join(dir, 'thumb.avif');

      await generateThumb(x3fPath, thumbPath);

      const s = await fs.stat(thumbPath);
      expect(s.size).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('generatePreview — no-preview guard', () => {
  for (const [filename, contents] of NO_PREVIEW_SOURCES) {
    it(`never copies raw source bytes to the preview path for ${filename}`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'previewer-guard-'));
      try {
        const srcPath = path.join(dir, filename);
        const previewPath = path.join(dir, 'preview_1280.jpg');
        await fs.writeFile(srcPath, contents);

        await generatePreview(srcPath, previewPath);

        await expect(fs.stat(previewPath)).rejects.toThrow();
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * Dispatch coverage for the no-embedded-preview demosaic fallback (#2733).
 *
 * The bug this pins: extraction failure REJECTS rather than returning false,
 * because the FFI pool marshals the child's error across the process
 * boundary as a throw. A fallback written only on the false branch is never
 * reached — which is exactly how the first version of this fix shipped
 * nothing while looking correct in a direct-FFI probe.
 *
 * Deliberately stops at the develop call. Returning false there
 * short-circuits before `renderBitmapThumbToFile`, so these tests need no
 * imgdecode child and no native dylib — they verify the decision, and the
 * end-to-end behaviour is covered by rendering real RAWs.
 */
describe('renderRawThumbToFile — demosaic fallback dispatch', () => {
  function fakePool(extract: () => Promise<boolean>) {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const pool = {
      available: () => true,
      renderThumbnailAvifToFile: (...args: unknown[]) => {
        calls.push({ fn: 'extract', args });
        return extract();
      },
      renderDevelopJpegToFile: (...args: unknown[]) => {
        calls.push({ fn: 'develop', args });
        return Promise.resolve(false); // stop here — see block comment
      },
    };
    return { pool, calls };
  }

  async function withPool<T>(pool: unknown, run: () => Promise<T>): Promise<T> {
    const { _setFfiPoolForTests } = await import('../ffi/ffi-pool.ts');
    _setFfiPoolForTests(pool as never);
    try {
      return await run();
    } finally {
      _setFfiPoolForTests(null);
    }
  }

  async function thumbOf(pool: unknown): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fallback-'));
    const src = path.join(dir, 'shot.dng');
    await fs.writeFile(src, 'not a real dng');
    await withPool(pool, () => generateThumb(src, path.join(dir, 'out.avif')));
    await fs.rm(dir, { recursive: true, force: true });
  }

  it('falls back to develop when extraction THROWS', async () => {
    const { pool, calls } = fakePool(() =>
      Promise.reject(new Error('render-failed (see child stderr)')),
    );
    await thumbOf(pool);
    expect(calls.map((c) => c.fn)).toEqual(['extract', 'develop']);
  });

  it('falls back to develop when extraction returns false', async () => {
    const { pool, calls } = fakePool(() => Promise.resolve(false));
    await thumbOf(pool);
    expect(calls.map((c) => c.fn)).toEqual(['extract', 'develop']);
  });

  // The fast path must stay fast: a RAW that HAS an embedded preview must
  // never pay for a demosaic. Measured, that is 168ms vs ~970ms.
  it('does NOT develop when extraction succeeds', async () => {
    const { pool, calls } = fakePool(() => Promise.resolve(true));
    await thumbOf(pool);
    expect(calls.map((c) => c.fn)).toEqual(['extract']);
  });

  it('develops neutrally — null xmp, so no adjustments are applied', async () => {
    const { pool, calls } = fakePool(() => Promise.resolve(false));
    await thumbOf(pool);
    const develop = calls.find((c) => c.fn === 'develop');
    expect(develop?.args[1]).toBeNull();
  });
});
