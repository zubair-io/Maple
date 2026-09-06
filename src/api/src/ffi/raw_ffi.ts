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

/** Batch-rename filename-template render result, mirroring
 * `raw_core::filename::render_filename`'s error taxonomy (#2628). One-to-one
 * with `MapleFilenameResult`'s `error_code` values. `-1` (bad pointer/UTF-8)
 * never surfaces here (`Buffer.from`/`+ '\0'` always produces valid UTF-8 C
 * strings). `9` (buffer-too-small) IS reachable — templates may repeat tokens
 * without bound, so a degenerate template can render past `RENDER_OUT_CAP` —
 * and maps to the same clean `{ ok: false }` shape as any other engine
 * rejection; any name that long would fail `validate_filename`'s length rule
 * regardless. The HTTP schema additionally caps `template` at 512 chars. */
type FilenameTemplateResult =
  | { ok: true; name: string }
  | { ok: false; code: number; error: string };

/** Caller-owned output buffer size for `maple_render_filename_template_buf`.
 * 1 KiB comfortably covers any output that could ever pass filename
 * validation (every target filesystem caps names near 255 bytes); a
 * degenerate token-repeating template that overflows it gets a clean
 * buffer-too-small error (code 9), not a truncated name. */
const RENDER_OUT_CAP = 1024;

interface RawFfi {
  /** Null means success; errors carry the native encoder's actionable message. */
  exportRecipeToFile?(
    rawPath: string,
    xmp: string,
    recipeJson: string,
    filmPath: string | null,
    outPath: string,
  ): string | null;
  asShotWhiteBalance(rawAbsPath: string): { temperature: number; tint: number } | null;
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
  /** Extract an embedded RAW preview, downscale to `maxPx`, JPEG-encode, and
   * write atomically to `outAbsPath` (.tmp + rename). The JPEG counterpart to
   * `renderThumbnailAvifToFile` (same embedded-preview extraction, no
   * adjustments) — used by the 1280px VLM describe/OCR preview tier
   * (`indexer/previewer.ts`), which must keep emitting real JPEG since every
   * describe provider hardcodes `image/jpeg` as the media type it sends
   * upstream. Quality defaults to 85. */
  renderThumbnailPreviewJpegToFile(
    rawAbsPath: string,
    outAbsPath: string,
    maxPx: number,
    quality?: number,
  ): boolean;
  /** Develop `rawAbsPath` with `xmpAbsPath`'s adjustments applied (null =
   * neutral), downscale to `maxPx`, JPEG-encode, and write atomically to
   * `outAbsPath`. The DEVELOPED counterpart to `renderThumbnailAvifToFile`
   * (embedded-preview extraction, no adjustments). Used for headless
   * develop-to-JPEG rendering of edited assets. Same file-output rationale. */
  renderDevelopJpegToFile(
    rawAbsPath: string,
    xmpAbsPath: string | null,
    outAbsPath: string,
    maxPx: number,
    quality?: number,
  ): boolean;
  /** Render one filename from a batch-rename template (#2628/#2636) — the
   * shared `raw-core` engine, so a server-rendered name is byte-identical to
   * what the Apple/Windows/Web clients would render from the same template
   * (the FFI/WASM shims over `raw_core::filename::render_filename`).
   * `capturedAt` is EXIF `DateTimeOriginal`'s wire format
   * (`"YYYY:MM:DD HH:MM:SS"`) — convert from the API's stored ISO 8601
   * before calling; null/unparseable renders `{date:FORMAT}` as the
   * documented fallback text rather than failing. */
  renderFilenameTemplate(args: {
    template: string;
    originalStem: string;
    ext: string;
    capturedAt: string | null;
    sequenceStart: number;
    sequenceIndex: number;
    sequencePadWidth: number;
  }): FilenameTemplateResult;
  /** Validate a filename against the same rules `renderFilenameTemplate`
   * enforces on its output — used for a manually-typed single-file rename
   * (no template), so it gets byte-identical rejection behaviour
   * (Windows-reserved names, trailing dot/space, path separators) on every
   * platform. */
  validateFilename(name: string): { ok: true } | { ok: false; code: number; error: string };
}

let _ffi: RawFfi | null | undefined = undefined; // undefined = not yet attempted
let _ffiOverride: RawFfi | null | undefined = undefined; // undefined = no override active

/** Returns the FFI wrapper, or null if the native library is unavailable. */
export function tryGetRawFfi(): RawFfi | null {
  if (_ffiOverride !== undefined) return _ffiOverride;
  if (_ffi !== undefined) return _ffi;
  _ffi = loadFfi();
  return _ffi;
}

/**
 * Test-only: force `tryGetRawFfi()`'s return value, so a suite can exercise
 * the "engine unavailable" fail-closed path (e.g.
 * `routes/assets/rename.test.ts`) without deleting the dylib out from under
 * every other test in the same process. Pass `undefined` to clear the
 * override and fall back to the real load/cache behaviour. Same pattern as
 * `setLibraryRootsForTests` (`indexer/libraries.cache.ts`).
 */
export function setRawFfiForTests(ffi: RawFfi | null | undefined): void {
  _ffiOverride = ffi;
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
  const libName =
    process.platform === 'win32'
      ? 'raw_ffi.dll'
      : process.platform === 'darwin'
        ? 'libraw_ffi.dylib'
        : 'libraw_ffi.so';
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
      maple_as_shot_white_balance_file: {
        args: [FFIType.cstring, FFIType.ptr],
        returns: FFIType.i32,
      },
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
      maple_render_thumbnail_preview_jpeg_to_file: {
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
      maple_export_recipe_to_file: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring, FFIType.cstring],
        returns: FFIType.i32,
      },
      maple_last_error: {
        args: [],
        returns: FFIType.cstring,
      },
      maple_render_filename_template_buf: {
        args: [
          FFIType.cstring, // template
          FFIType.cstring, // original_stem
          FFIType.cstring, // ext
          FFIType.cstring, // captured_at (nullable)
          FFIType.u64, // sequence_start
          FFIType.u64, // sequence_index
          FFIType.u64, // sequence_pad_width (usize)
          FFIType.ptr, // out_buf: caller-owned [u8; RENDER_OUT_CAP]
          FFIType.u64, // out_cap (usize)
          FFIType.ptr, // out_len: *mut usize
        ],
        returns: FFIType.i32,
      },
      maple_validate_filename: {
        args: [FFIType.cstring],
        returns: FFIType.i32,
      },
    });

    // Shared by `renderThumbnailAvifToFile` and `renderThumbnailPreviewJpegToFile`
    // — both are `(raw_path, out_path, max_px, quality) -> rc` externs that
    // extract the embedded RAW preview and differ only in output codec.
    function renderRawToOutFile(
      symbolFn: (
        rawPath: ReturnType<typeof ptr>,
        outPath: ReturnType<typeof ptr>,
        maxPx: number,
        quality: number,
      ) => unknown,
      symbolLabel: string,
      rawAbsPath: string,
      outAbsPath: string,
      maxPx: number,
      quality: number,
    ): boolean {
      const rawPathBuf = Buffer.from(rawAbsPath + '\0', 'utf-8');
      const outPathBuf = Buffer.from(outAbsPath + '\0', 'utf-8');
      const rc = symbolFn(ptr(rawPathBuf), ptr(outPathBuf), maxPx >>> 0, quality & 0xff) as number;
      if (rc !== 0) {
        const errStr = lib.symbols.maple_last_error() as unknown as string | null;
        log.error({ rc, err: errStr }, `${symbolLabel} failed`);
        return false;
      }
      return true;
    }

    return {
      asShotWhiteBalance(rawAbsPath) {
        const raw = Buffer.from(rawAbsPath + '\0');
        const pair = Buffer.alloc(8);
        const rc = lib.symbols.maple_as_shot_white_balance_file(ptr(raw), ptr(pair));
        if (rc !== 0) return null;
        const temperature = pair.readFloatLE(0);
        const tint = pair.readFloatLE(4);
        return Number.isFinite(temperature) && temperature > 0 && Number.isFinite(tint)
          ? { temperature, tint }
          : null;
      },
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

      exportRecipeToFile(rawPath, xmp, recipeJson, filmPath, outPath) {
        const buffers = [rawPath, xmp, recipeJson, filmPath, outPath].map((value) =>
          value === null ? null : Buffer.from(value + '\0'),
        );
        const code = lib.symbols.maple_export_recipe_to_file(
          ptr(buffers[0]!),
          ptr(buffers[1]!),
          ptr(buffers[2]!),
          buffers[3] ? ptr(buffers[3]) : null,
          ptr(buffers[4]!),
        );
        return code === 0 ? null : String(lib.symbols.maple_last_error() || 'Native export failed');
      },

      renderThumbnailAvifToFile(
        rawAbsPath: string,
        outAbsPath: string,
        maxPx: number,
        quality: number = 55,
      ): boolean {
        return renderRawToOutFile(
          lib.symbols.maple_render_thumbnail_avif_to_file,
          'maple_render_thumbnail_avif_to_file',
          rawAbsPath,
          outAbsPath,
          maxPx,
          quality,
        );
      },

      renderThumbnailPreviewJpegToFile(
        rawAbsPath: string,
        outAbsPath: string,
        maxPx: number,
        quality: number = 85,
      ): boolean {
        return renderRawToOutFile(
          lib.symbols.maple_render_thumbnail_preview_jpeg_to_file,
          'maple_render_thumbnail_preview_jpeg_to_file',
          rawAbsPath,
          outAbsPath,
          maxPx,
          quality,
        );
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

      renderFilenameTemplate(args): FilenameTemplateResult {
        const templateBuf = Buffer.from(args.template + '\0', 'utf-8');
        const stemBuf = Buffer.from(args.originalStem + '\0', 'utf-8');
        const extBuf = Buffer.from(args.ext + '\0', 'utf-8');
        const capturedBuf = args.capturedAt ? Buffer.from(args.capturedAt + '\0', 'utf-8') : null;
        const outBuf = Buffer.alloc(RENDER_OUT_CAP, 0);
        const outLenBuf = Buffer.alloc(8, 0); // *mut usize (64-bit)

        const rc = lib.symbols.maple_render_filename_template_buf(
          ptr(templateBuf),
          ptr(stemBuf),
          ptr(extBuf),
          capturedBuf ? ptr(capturedBuf) : null,
          BigInt(args.sequenceStart),
          BigInt(args.sequenceIndex),
          BigInt(args.sequencePadWidth),
          ptr(outBuf),
          BigInt(RENDER_OUT_CAP),
          ptr(outLenBuf),
        ) as number;

        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          return {
            ok: false,
            code: rc,
            error: errStr ?? `render failed with code ${rc}`,
          };
        }
        const outLen = Number(outLenBuf.readBigUInt64LE(0));
        return { ok: true, name: outBuf.subarray(0, outLen).toString('utf-8') };
      },

      validateFilename(name: string) {
        const nameBuf = Buffer.from(name + '\0', 'utf-8');
        const rc = lib.symbols.maple_validate_filename(ptr(nameBuf)) as number;
        if (rc !== 0) {
          const errStr = lib.symbols.maple_last_error() as unknown as string | null;
          return {
            ok: false as const,
            code: rc,
            error: errStr ?? `invalid filename (code ${rc})`,
          };
        }
        return { ok: true as const };
      },
    };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'failed to load native library');
    return null;
  }
}
