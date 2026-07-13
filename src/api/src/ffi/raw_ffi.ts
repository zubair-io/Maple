/**
 * Bun FFI wrapper for libraw_ffi.dylib (macOS) / libraw_ffi.so (Linux).
 *
 * The shared library must be present at:
 *   src/api/native/libraw_ffi.dylib  (macOS)
 *   src/api/native/libraw_ffi.so     (Linux)
 *
 * Build it with: bun run scripts/build-raw-ffi.sh
 *
 * If the library is not present, tryGetRawFfi() returns null and all
 * callers degrade gracefully (thumbs are skipped).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { child as childLogger } from '../log.ts';
import type { HistogramBins } from '../thumbs/histogram.ts';
import type * as BunFfi from 'bun:ffi';

const log = childLogger('raw-ffi');

/** Bins per channel in a Maple RGB histogram (8-bit → 256 levels). */
const HISTOGRAM_BIN_COUNT = 256;

/**
 * Decode the channel-major `u32` histogram buffer that `maple_histogram_file`
 * writes into `{ r, g, b }`. The native side writes 3 × 256 little-endian
 * `u32` counts: `[0,256)` = R, `[256,512)` = G, `[512,768)` = B. Pure and
 * exported so the read-back layout (offsets + endianness) is unit-testable
 * without the native dylib in scope. All Maple runtime targets are
 * little-endian (x86_64 / aarch64), matching Rust's native `u32` write.
 */
export function histogramBinsFromBuffer(buf: Buffer): HistogramBins {
  const r = new Array<number>(HISTOGRAM_BIN_COUNT);
  const g = new Array<number>(HISTOGRAM_BIN_COUNT);
  const b = new Array<number>(HISTOGRAM_BIN_COUNT);
  for (let i = 0; i < HISTOGRAM_BIN_COUNT; i++) {
    r[i] = buf.readUInt32LE(i * 4);
    g[i] = buf.readUInt32LE((HISTOGRAM_BIN_COUNT + i) * 4);
    b[i] = buf.readUInt32LE((2 * HISTOGRAM_BIN_COUNT + i) * 4);
  }
  return { r, g, b };
}

interface RawFfi {
  /**
   * Render a RAW+XMP and return a 3×256 RGB histogram (R/G/B channel counts),
   * computed in Rust. The rendered pixel buffer never crosses the FFI boundary
   * — Rust bins it and writes only the 3 KB counts into a JS-owned buffer — so
   * there is no `toBuffer`-over-Rust-memory lifetime trap (the GC double-free
   * the old `renderToRgb` hit) and no ~300 MB transfer per 100 MP frame.
   *
   * Pass `xmpAbsPath` to apply the user's sidecar edits; null = default
   * adjustments. Returns null on any FFI error (logged via the structured
   * logger).
   */
  computeHistogramBins(rawAbsPath: string, xmpAbsPath?: string | null): HistogramBins | null;
  /** Extract an embedded RAW preview, downscale to `maxPx`, AVIF-encode, and
   * write atomically to `outAbsPath` (.tmp + rename). Avoids the bun:ffi
   * `toBuffer` lifetime trap that segfaults the JSC heap when Rust-allocated
   * memory is later GC'd — Rust owns the write end-to-end. Quality defaults
   * to 55 (AVIF's own scale, not JPEG's). */
  renderThumbnailAvifToFile(
    rawAbsPath: string,
    outAbsPath: string,
    maxPx: number,
    quality?: number,
  ): boolean;
  /** Develop `rawAbsPath` with `xmpAbsPath`'s adjustments applied (null =
   * neutral), downscale to `maxPx`, JPEG-encode, and write atomically to
   * `outAbsPath`. The DEVELOPED counterpart to `renderThumbnailAvifToFile`
   * (embedded-preview extraction, no adjustments) — used by the display-preview
   * stage for edited assets (#1950). Same file-output rationale. */
  renderDevelopJpegToFile(
    rawAbsPath: string,
    xmpAbsPath: string | null,
    outAbsPath: string,
    maxPx: number,
    quality?: number,
  ): boolean;
}

let _ffi: RawFfi | null | undefined = undefined; // undefined = not yet attempted

/** Returns the FFI wrapper, or null if the native library is unavailable. */
export function tryGetRawFfi(): RawFfi | null {
  if (_ffi !== undefined) return _ffi;
  _ffi = loadFfi();
  return _ffi;
}

/**
 * True iff the native lib file is present on disk. A pure existence check — it
 * does NOT `dlopen` — so callers can decide whether RAW decode is possible
 * without loading libraw into their process. The FFI decode pool uses this to
 * gate work to its isolated child processes (which do the real `dlopen`),
 * keeping native code — and any segfault it might hit — out of the main HTTP
 * process entirely.
 */
export function nativeLibAvailable(): boolean {
  return fs.existsSync(nativeLibPath());
}

function nativeLibPath(): string {
  const dir = path.join(
    import.meta.dir, // src/ffi/
    '..', // src/
    '..', // api/
    'native',
  );
  const libName = process.platform === 'darwin' ? 'libraw_ffi.dylib' : 'libraw_ffi.so';
  return path.join(dir, libName);
}

function loadFfi(): RawFfi | null {
  const libPath = nativeLibPath();

  if (!fs.existsSync(libPath)) {
    log.warn(
      { libPath },
      'native library not found. RAW thumbnail generation will be skipped. Run scripts/build-raw-ffi.sh to build it.',
    );
    return null;
  }

  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof BunFfi;

    const lib = dlopen(libPath, {
      maple_histogram_file: {
        args: [
          FFIType.cstring, // raw_path
          FFIType.cstring, // xmp_path (nullable)
          FFIType.ptr, // out_bins: *mut u32 — caller-owned [u32; 768]
        ],
        returns: FFIType.i32,
      },
      maple_render_thumbnail_avif_to_file: {
        args: [
          FFIType.cstring, // raw_path
          FFIType.cstring, // out_path
          FFIType.u32, // max_px
          FFIType.u8, // quality
        ],
        returns: FFIType.i32,
      },
      maple_render_develop_jpeg_to_file: {
        args: [
          FFIType.cstring, // raw_path
          FFIType.cstring, // xmp_path (nullable)
          FFIType.u32, // max_px
          FFIType.u8, // quality
          FFIType.cstring, // out_path
        ],
        returns: FFIType.i32,
      },
      maple_last_error: {
        args: [],
        returns: FFIType.cstring,
      },
    });

    return {
      computeHistogramBins(
        rawAbsPath: string,
        xmpAbsPath: string | null = null,
      ): HistogramBins | null {
        // 3 channels × 256 bins × 4 bytes (u32), JS-owned and zero-filled.
        // Rust writes the counts straight into this buffer — no Rust-allocated
        // memory crosses the FFI boundary, so there is nothing to free and no
        // GC-time double-free (the bug the old `renderToRgb` + `toBuffer` path
        // hit). See `maple_histogram_file` in raw-ffi/src/render.rs.
        const outBuf = Buffer.alloc(3 * HISTOGRAM_BIN_COUNT * 4, 0);
        const outPtr = ptr(outBuf);

        const rawPathBuf = Buffer.from(rawAbsPath + '\0', 'utf-8');
        // Nullable XMP path: present → the sidecar's adjustments are applied;
        // null → pipeline defaults. Threading the user's sidecar in is what
        // keeps a (raw_mtime, sidecar_mtime)-keyed histogram cache valid.
        const xmpPathBuf = xmpAbsPath ? Buffer.from(xmpAbsPath + '\0', 'utf-8') : null;

        const rc = lib.symbols.maple_histogram_file(
          ptr(rawPathBuf),
          xmpPathBuf ? ptr(xmpPathBuf) : null,
          outPtr,
        ) as number;

        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          log.error({ rc, err: errStr }, 'maple_histogram_file failed');
          return null;
        }

        return histogramBinsFromBuffer(outBuf);
      },

      renderThumbnailAvifToFile(
        rawAbsPath: string,
        outAbsPath: string,
        maxPx: number,
        quality: number = 55,
      ): boolean {
        const rawPathBuf = Buffer.from(rawAbsPath + '\0', 'utf-8');
        const outPathBuf = Buffer.from(outAbsPath + '\0', 'utf-8');
        const rc = lib.symbols.maple_render_thumbnail_avif_to_file(
          ptr(rawPathBuf),
          ptr(outPathBuf),
          maxPx >>> 0,
          quality & 0xff,
        ) as number;
        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          log.error({ rc, err: errStr }, 'maple_render_thumbnail_avif_to_file failed');
          return false;
        }
        return true;
      },

      renderDevelopJpegToFile(
        rawAbsPath: string,
        xmpAbsPath: string | null,
        outAbsPath: string,
        maxPx: number,
        quality: number = 82,
      ): boolean {
        const rawPathBuf = Buffer.from(rawAbsPath + '\0', 'utf-8');
        // Nullable XMP: present → the sidecar's adjustments are applied
        // (the whole point of the developed tier); null → neutral develop.
        const xmpPathBuf = xmpAbsPath ? Buffer.from(xmpAbsPath + '\0', 'utf-8') : null;
        const outPathBuf = Buffer.from(outAbsPath + '\0', 'utf-8');
        const rc = lib.symbols.maple_render_develop_jpeg_to_file(
          ptr(rawPathBuf),
          xmpPathBuf ? ptr(xmpPathBuf) : null,
          maxPx >>> 0,
          quality & 0xff,
          ptr(outPathBuf),
        ) as number;
        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          log.error({ rc, err: errStr }, 'maple_render_develop_jpeg_to_file failed');
          return false;
        }
        return true;
      },
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'failed to load native library');
    return null;
  }
}
