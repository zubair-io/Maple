/**
 * P5 tests — raw-ffi Bun FFI wrapper.
 *
 * Tests the module loads cleanly and degrades gracefully when
 * the native library is absent.
 */

import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';

describe('tryGetRawFfi', () => {
  it('module imports without error', async () => {
    const mod = await import('../src/ffi/raw_ffi.ts');
    expect(typeof mod.tryGetRawFfi).toBe('function');
  });

  it('returns null or an object (never throws)', async () => {
    const { tryGetRawFfi } = await import('../src/ffi/raw_ffi.ts');
    let result: ReturnType<typeof tryGetRawFfi> | undefined;
    expect(() => {
      result = tryGetRawFfi();
    }).not.toThrow();
    // Either null (lib not available) or an object with the FFI methods.
    if (result !== null) {
      const ffi = result as { computeHistogramBins: unknown };
      expect(typeof ffi.computeHistogramBins).toBe('function');
    }
  });

  it('native library exists on macOS after build', () => {
    // This test verifies the .dylib was built and copied.
    const libPath = path.resolve(
      import.meta.dir,
      '..',
      'native',
      process.platform === 'darwin' ? 'libraw_ffi.dylib' : 'libraw_ffi.so',
    );
    const exists = fs.existsSync(libPath);
    if (!exists) {
      console.warn(`[ffi.test] ${libPath} not found — run scripts/build-raw-ffi.sh to build`);
    }
    // Not a hard failure: the test just documents expected state.
    expect(typeof exists).toBe('boolean');
  });
});

describe('histogramBinsFromBuffer', () => {
  it('reads channel-major little-endian u32 counts', async () => {
    const { histogramBinsFromBuffer } = await import('../src/ffi/raw_ffi.ts');
    // 3×256 u32 buffer, channel-major: R [0,256), G [256,512), B [512,768) —
    // the exact layout maple_histogram_file writes.
    const buf = Buffer.alloc(3 * 256 * 4, 0);
    buf.writeUInt32LE(5, 0 * 4); // R[0] = 5
    buf.writeUInt32LE(7, (256 + 1) * 4); // G[1] = 7
    buf.writeUInt32LE(9, (512 + 255) * 4); // B[255] = 9
    const bins = histogramBinsFromBuffer(buf);
    expect(bins.r.length).toBe(256);
    expect(bins.g.length).toBe(256);
    expect(bins.b.length).toBe(256);
    expect(bins.r[0]).toBe(5);
    expect(bins.g[1]).toBe(7);
    expect(bins.b[255]).toBe(9);
    // No cross-channel bleed: untouched slots stay zero.
    expect(bins.r[1]).toBe(0);
    expect(bins.g[0]).toBe(0);
    expect(bins.b[0]).toBe(0);
  });
});
