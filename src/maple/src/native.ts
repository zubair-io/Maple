/**
 * Native bindings loader for Maple via bun:ffi.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFfiSymbols } from './ffi-symbols';
import { resolvePlatformPackageLib } from './platform';
import type { FilenameResult, FilenameTemplateArgs } from './types';

const RENDER_OUT_CAP = 1024;

export interface NativeBinding {
  exportDevelopedToFile(
    rawPath: string,
    xmpPath: string | null,
    format: string,
    quality: number,
    colorSpace: string,
    maxLongEdge: number,
    outPath: string,
  ): { ok: boolean; error?: string };

  exportRecipeToFile(
    rawPath: string,
    xmpXml: string,
    recipeJson: string,
    filmPath: string | null,
    outPath: string,
  ): { ok: boolean; error?: string };

  renderThumbnailAvifToFile(
    rawPath: string,
    outPath: string,
    maxPx: number,
    quality?: number,
  ): { ok: boolean; error?: string };

  renderThumbnailPreviewJpegToFile(
    rawPath: string,
    outPath: string,
    maxPx: number,
    quality?: number,
  ): { ok: boolean; error?: string };

  renderDevelopJpegToFile(
    rawPath: string,
    xmpPath: string | null,
    outPath: string,
    maxPx: number,
    quality?: number,
  ): { ok: boolean; error?: string };

  rasterResizeToFile(
    inputPath: string,
    outPath: string,
    width: number,
    height: number,
    fit: number,
    format: string | null,
    quality: number,
  ): { ok: boolean; error?: string };

  rasterResizeToBuf(
    inputBytes: Uint8Array,
    width: number,
    height: number,
    fit: number,
    format: string | null,
    quality: number,
  ): { ok: boolean; buffer?: Buffer; error?: string };

  rasterProbeMetadata(inputPath: string): {
    ok: boolean;
    metadata?: {
      width: number;
      height: number;
      channels: number;
      orientation: number;
      format?: string;
    };
    error?: string;
  };

  rasterProbeMetadataBuf(inputBytes: Uint8Array): {
    ok: boolean;
    metadata?: {
      width: number;
      height: number;
      channels: number;
      orientation: number;
      format: string;
    };
    error?: string;
  };

  rasterExtractTensor(
    inputBytes: Uint8Array,
    targetSize: number,
    layout: number,
    normalize: number,
  ): {
    ok: boolean;
    tensor?: Float32Array;
    error?: string;
  };

  renderFilenameTemplate(args: FilenameTemplateArgs): FilenameResult;

  validateFilename(name: string): { ok: true } | { ok: false; code: number; error: string };

  lastError(): string | null;
}

let _cachedBinding: NativeBinding | null | undefined = undefined;

/** Find the platform-specific library name */
export function nativeLibFilename(): string {
  if (process.platform === 'win32') return 'raw_ffi.dll';
  if (process.platform === 'darwin') return 'libraw_ffi.dylib';
  return 'libraw_ffi.so';
}

/** First candidate path that exists on disk, or null. */
function firstExisting(candidates: readonly string[]): string | null {
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  return hit ? path.resolve(hit) : null;
}

/**
 * Locate the native shared library.
 *
 * Order: the explicit `MAPLE_NATIVE_LIB` override, then a binary built from
 * this checkout, then the installed `@justmaple/maple-<platform>` package,
 * then generic runtime locations. The source-built paths point at sibling
 * crates/packages that only exist inside the monorepo (an installed npm
 * package never has them), so they are an explicit "use what `cargo build`
 * just produced" selection, not a search of arbitrary local files — a local
 * pipeline change is what `bun test` and the API exercise, never a stale
 * prebuilt pulled in by `bun install`.
 */
export function findNativeLib(): string | null {
  if (process.env.MAPLE_NATIVE_LIB && fs.existsSync(process.env.MAPLE_NATIVE_LIB)) {
    return process.env.MAPLE_NATIVE_LIB;
  }

  const libName = nativeLibFilename();
  const currentDir =
    (import.meta as { dir?: string }).dir || path.dirname(fileURLToPath(import.meta.url));
  const cargoTarget = path.join(currentDir, '..', '..', 'raw-pipeline', 'target');

  const sourceBuilt = [
    path.join(cargoTarget, 'release', libName),
    path.join(cargoTarget, 'aarch64-apple-darwin', 'release', libName),
    path.join(cargoTarget, 'x86_64-apple-darwin', 'release', libName),
    path.join(cargoTarget, 'x86_64-unknown-linux-gnu', 'release', libName),
    path.join(cargoTarget, 'aarch64-unknown-linux-gnu', 'release', libName),
    path.join(cargoTarget, 'x86_64-pc-windows-msvc', 'release', libName),
    // src/api/native/ — written by src/api/scripts/build-raw-ffi.sh
    path.join(currentDir, '..', '..', 'api', 'native', libName),
  ];

  const runtime = [
    // Pre-bundled in native/ inside package
    path.join(currentDir, '..', 'native', libName),
    // Current working directory native/ (e.g. /app/native in Docker or server root)
    path.join(process.cwd(), 'native', libName),
    // Direct Docker runtime container path
    path.join('/app', 'native', libName),
    // Standard Linux system library locations
    path.join('/usr/local/lib', libName),
    path.join('/usr/lib', libName),
  ];

  return firstExisting(sourceBuilt) ?? resolvePlatformPackageLib() ?? firstExisting(runtime);
}

export function loadNativeBinding(): NativeBinding {
  if (_cachedBinding !== undefined && _cachedBinding !== null) {
    return _cachedBinding;
  }

  const libPath = findNativeLib();
  if (!libPath) {
    throw new Error(
      `Maple native library (${nativeLibFilename()}) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.`,
    );
  }

  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    throw new Error('Maple native bindings currently require Bun (bun:ffi).');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dlopen, FFIType, ptr } = require('bun:ffi');

  const lib = dlopen(libPath, getFfiSymbols(FFIType));

  function getLastError(): string | null {
    const res = lib.symbols.maple_last_error();
    return res ? String(res) : null;
  }

  const binding: NativeBinding = {
    exportDevelopedToFile(rawPath, xmpPath, format, quality, colorSpace, maxLongEdge, outPath) {
      const rawBuf = Buffer.from(rawPath + '\0', 'utf-8');
      const xmpBuf = xmpPath ? Buffer.from(xmpPath + '\0', 'utf-8') : null;
      const formatBuf = Buffer.from(format + '\0', 'utf-8');
      const csBuf = Buffer.from(colorSpace + '\0', 'utf-8');
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');

      const rc = lib.symbols.maple_export_developed_to_file(
        ptr(rawBuf),
        xmpBuf ? ptr(xmpBuf) : null,
        ptr(formatBuf),
        quality & 0xff,
        ptr(csBuf),
        maxLongEdge >>> 0,
        ptr(outBuf),
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Export failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    exportRecipeToFile(rawPath, xmpXml, recipeJson, filmPath, outPath) {
      const rawBuf = Buffer.from(rawPath + '\0', 'utf-8');
      const xmpBuf = Buffer.from(xmpXml + '\0', 'utf-8');
      const recipeBuf = Buffer.from(recipeJson + '\0', 'utf-8');
      const filmBuf = filmPath ? Buffer.from(filmPath + '\0', 'utf-8') : null;
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');

      const rc = lib.symbols.maple_export_recipe_to_file(
        ptr(rawBuf),
        ptr(xmpBuf),
        ptr(recipeBuf),
        filmBuf ? ptr(filmBuf) : null,
        ptr(outBuf),
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Recipe export failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    renderThumbnailAvifToFile(rawPath, outPath, maxPx, quality = 55) {
      const rawBuf = Buffer.from(rawPath + '\0', 'utf-8');
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');
      const rc = lib.symbols.maple_render_thumbnail_avif_to_file(
        ptr(rawBuf),
        ptr(outBuf),
        maxPx >>> 0,
        quality & 0xff,
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Thumbnail render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    renderThumbnailPreviewJpegToFile(rawPath, outPath, maxPx, quality = 85) {
      const rawBuf = Buffer.from(rawPath + '\0', 'utf-8');
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');
      const rc = lib.symbols.maple_render_thumbnail_preview_jpeg_to_file(
        ptr(rawBuf),
        ptr(outBuf),
        maxPx >>> 0,
        quality & 0xff,
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Preview render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    renderDevelopJpegToFile(rawPath, xmpPath, outPath, maxPx, quality = 85) {
      const rawBuf = Buffer.from(rawPath + '\0', 'utf-8');
      const xmpBuf = xmpPath ? Buffer.from(xmpPath + '\0', 'utf-8') : null;
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');
      const rc = lib.symbols.maple_render_develop_jpeg_to_file(
        ptr(rawBuf),
        xmpBuf ? ptr(xmpBuf) : null,
        maxPx >>> 0,
        quality & 0xff,
        ptr(outBuf),
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Develop render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    rasterResizeToFile(inputPath, outPath, width, height, fit, format, quality) {
      const inBuf = Buffer.from(inputPath + '\0', 'utf-8');
      const outBuf = Buffer.from(outPath + '\0', 'utf-8');
      const fmtBuf = format ? Buffer.from(format + '\0', 'utf-8') : null;

      const rc = lib.symbols.maple_raster_resize_to_file(
        ptr(inBuf),
        ptr(outBuf),
        width >>> 0,
        height >>> 0,
        fit >>> 0,
        fmtBuf ? ptr(fmtBuf) : null,
        quality & 0xff,
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Raster resize failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },

    rasterResizeToBuf(inputBytes, width, height, fit, format, quality) {
      const fmtBuf = format ? Buffer.from(format + '\0', 'utf-8') : null;
      let cap = Math.max(65536, inputBytes.byteLength * 2);
      let outBuf = Buffer.alloc(cap);
      const outLenBuf = Buffer.alloc(8);

      let rc = lib.symbols.maple_raster_resize_to_buf(
        ptr(inputBytes),
        BigInt(inputBytes.byteLength),
        width >>> 0,
        height >>> 0,
        fit >>> 0,
        fmtBuf ? ptr(fmtBuf) : null,
        quality & 0xff,
        ptr(outBuf),
        BigInt(cap),
        ptr(outLenBuf),
      ) as number;

      if (rc === 100) {
        cap = Number(outLenBuf.readBigUInt64LE(0));
        outBuf = Buffer.alloc(cap);
        rc = lib.symbols.maple_raster_resize_to_buf(
          ptr(inputBytes),
          BigInt(inputBytes.byteLength),
          width >>> 0,
          height >>> 0,
          fit >>> 0,
          fmtBuf ? ptr(fmtBuf) : null,
          quality & 0xff,
          ptr(outBuf),
          BigInt(cap),
          ptr(outLenBuf),
        ) as number;
      }

      if (rc !== 0) {
        const err = getLastError() || `Raster resize failed with code ${rc}`;
        return { ok: false, error: err };
      }

      const outLen = Number(outLenBuf.readBigUInt64LE(0));
      return { ok: true, buffer: outBuf.subarray(0, outLen) };
    },

    rasterProbeMetadata(inputPath) {
      try {
        const bytes = fs.readFileSync(inputPath);
        return this.rasterProbeMetadataBuf(bytes);
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },

    rasterProbeMetadataBuf(inputBytes) {
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const cBuf = Buffer.alloc(4);
      const oBuf = Buffer.alloc(4);
      const fmtBuf = Buffer.alloc(32);

      const rc = lib.symbols.maple_raster_probe_metadata_buf(
        ptr(inputBytes),
        BigInt(inputBytes.byteLength),
        ptr(wBuf),
        ptr(hBuf),
        ptr(cBuf),
        ptr(oBuf),
        ptr(fmtBuf),
        BigInt(32),
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Metadata probe failed with code ${rc}`;
        return { ok: false, error: err };
      }

      const nullIdx = fmtBuf.indexOf(0);
      const format = (nullIdx >= 0 ? fmtBuf.subarray(0, nullIdx) : fmtBuf).toString('utf-8');

      return {
        ok: true,
        metadata: {
          width: wBuf.readUInt32LE(0),
          height: hBuf.readUInt32LE(0),
          channels: cBuf.readUInt32LE(0),
          orientation: oBuf.readUInt32LE(0),
          format,
        },
      };
    },

    rasterExtractTensor(inputBytes, targetSize, layout, normalize) {
      const targetW = targetSize || 640;
      const targetH = targetSize || 640;
      const totalFloats = 3 * targetW * targetH;
      const floatArr = new Float32Array(totalFloats);
      const outLenBuf = Buffer.alloc(8);

      const rc = lib.symbols.maple_raster_extract_tensor_buf(
        ptr(inputBytes),
        BigInt(inputBytes.byteLength),
        targetSize >>> 0,
        layout >>> 0,
        normalize >>> 0,
        ptr(floatArr),
        BigInt(totalFloats),
        ptr(outLenBuf),
      ) as number;

      if (rc !== 0) {
        const err = getLastError() || `Tensor extraction failed with code ${rc}`;
        return { ok: false, error: err };
      }

      return { ok: true, tensor: floatArr };
    },

    renderFilenameTemplate(args) {
      const templateBuf = Buffer.from(args.template + '\0', 'utf-8');
      const stemBuf = Buffer.from(args.originalStem + '\0', 'utf-8');
      const extBuf = Buffer.from(args.ext + '\0', 'utf-8');
      const capturedBuf = args.capturedAt ? Buffer.from(args.capturedAt + '\0', 'utf-8') : null;

      const outBuf = Buffer.alloc(RENDER_OUT_CAP);
      const outLenBuf = Buffer.alloc(8);

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
        const err = getLastError() || `Filename render failed with code ${rc}`;
        return { ok: false, code: rc, error: err };
      }

      const outLen = Number(outLenBuf.readBigUInt64LE(0));
      const rendered = outBuf.subarray(0, outLen).toString('utf-8');
      return { ok: true, name: rendered };
    },

    validateFilename(name) {
      const nameBuf = Buffer.from(name + '\0', 'utf-8');
      const rc = lib.symbols.maple_validate_filename(ptr(nameBuf)) as number;
      if (rc !== 0) {
        const err = getLastError() || `Filename validation failed with code ${rc}`;
        return { ok: false, code: rc, error: err };
      }
      return { ok: true };
    },

    lastError: getLastError,
  };

  _cachedBinding = binding;
  return binding;
}

/**
 * Render one filename from a batch-rename template.
 */
export function renderFilenameTemplate(args: FilenameTemplateArgs): FilenameResult {
  return loadNativeBinding().renderFilenameTemplate(args);
}

/**
 * Validate a filename against standard file system naming rules.
 */
export function validateFilename(
  name: string,
): { ok: true } | { ok: false; code: number; error: string } {
  return loadNativeBinding().validateFilename(name);
}

/**
 * Check if the native library is available on disk.
 */
export function isNativeAvailable(): boolean {
  try {
    return findNativeLib() !== null;
  } catch {
    return false;
  }
}
