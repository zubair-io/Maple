import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/native.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/ffi-symbols.ts
function getFfiSymbols(FFIType) {
  return {
    maple_export_developed_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u8,
        FFIType.cstring,
        FFIType.u32,
        FFIType.cstring
      ],
      returns: FFIType.i32
    },
    maple_export_recipe_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring
      ],
      returns: FFIType.i32
    },
    maple_render_thumbnail_avif_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u8
      ],
      returns: FFIType.i32
    },
    maple_render_thumbnail_preview_jpeg_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u8
      ],
      returns: FFIType.i32
    },
    maple_render_develop_jpeg_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u8,
        FFIType.cstring
      ],
      returns: FFIType.i32
    },
    maple_render_filename_template_buf: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u64,
        FFIType.u64,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_validate_filename: {
      args: [FFIType.cstring],
      returns: FFIType.i32
    },
    maple_raster_resize_to_file: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.cstring,
        FFIType.u8
      ],
      returns: FFIType.i32
    },
    maple_raster_probe_metadata: {
      args: [
        FFIType.cstring,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_resize_to_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.cstring,
        FFIType.u8,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_probe_metadata_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.u64
      ],
      returns: FFIType.i32
    },
    maple_raster_extract_tensor_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_render_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.cstring,
        FFIType.u8,
        FFIType.u8,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_from_raw_render_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.cstring,
        FFIType.u8,
        FFIType.u8,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_decode_rgb8_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_pipeline_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.cstring,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_raster_analyze_buf: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.cstring,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    maple_last_error: {
      args: [],
      returns: FFIType.cstring
    }
  };
}

// src/native-raster-analyze.ts
var NEED_LARGER_BUFFER = 100;
var MAX_ANALYZE_REPLY_BYTES = 64 * 1024 * 1024;
function createRasterAnalyzeBinding(lib, ptr, getLastError) {
  return {
    rasterAnalyzeBuf(input, requestJson) {
      const requestBuf = Buffer.from(requestJson + "\x00", "utf-8");
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf) => lib.symbols.maple_raster_analyze_buf(ptr(input), BigInt(input.byteLength), ptr(requestBuf), outBuf ? ptr(outBuf) : null, BigInt(outBuf ? outBuf.byteLength : 0), ptr(outLenBuf));
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      const first = Buffer.alloc(65536);
      const rc0 = call(first);
      if (rc0 === 0) {
        return { ok: true, json: first.subarray(0, needed()).toString("utf-8") };
      }
      if (rc0 !== NEED_LARGER_BUFFER) {
        return { ok: false, error: getLastError() || `Analyze failed with code ${rc0}` };
      }
      if (needed() > MAX_ANALYZE_REPLY_BYTES) {
        return {
          ok: false,
          error: `Analyze reply of ${needed()} bytes exceeds the ${MAX_ANALYZE_REPLY_BYTES}-byte limit`
        };
      }
      const grown = Buffer.alloc(needed());
      const rc = call(grown);
      return rc === 0 ? { ok: true, json: grown.subarray(0, needed()).toString("utf-8") } : { ok: false, error: getLastError() || `Analyze failed with code ${rc}` };
    }
  };
}

// src/native-raster-pipeline.ts
var NEED_LARGER_BUFFER2 = 100;
var EMPTY_AUX = Buffer.alloc(1);
function createRasterPipelineBinding(lib, ptr, getLastError) {
  return {
    rasterPipelineBuf(input, recipeJson, aux) {
      const recipeBuf = Buffer.from(recipeJson + "\x00", "utf-8");
      const auxBuf = aux.byteLength > 0 ? aux : EMPTY_AUX;
      const auxLen = aux.byteLength;
      const outLenBuf = Buffer.alloc(8);
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const cBuf = Buffer.alloc(4);
      const call = (outBuf) => lib.symbols.maple_raster_pipeline_buf(ptr(input), BigInt(input.byteLength), ptr(recipeBuf), ptr(auxBuf), BigInt(auxLen), outBuf ? ptr(outBuf) : null, BigInt(outBuf ? outBuf.byteLength : 0), ptr(outLenBuf), ptr(wBuf), ptr(hBuf), ptr(cBuf));
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      const failed = (rc) => ({
        ok: false,
        error: getLastError() || `Raster pipeline failed with code ${rc}`
      });
      const first = Buffer.alloc(Math.max(65536, input.byteLength * 2));
      const rc0 = call(first);
      if (rc0 === 0) {
        return {
          ok: true,
          buffer: first.subarray(0, needed()),
          width: wBuf.readUInt32LE(0),
          height: hBuf.readUInt32LE(0),
          channels: cBuf.readUInt32LE(0)
        };
      }
      if (rc0 !== NEED_LARGER_BUFFER2) {
        return failed(rc0);
      }
      const grown = Buffer.alloc(needed());
      const rc = call(grown);
      return rc === 0 ? {
        ok: true,
        buffer: grown.subarray(0, needed()),
        width: wBuf.readUInt32LE(0),
        height: hBuf.readUInt32LE(0),
        channels: cBuf.readUInt32LE(0)
      } : failed(rc);
    }
  };
}

// src/native-raster-v2.ts
var NEED_LARGER_BUFFER3 = 100;
var MAX_PROBE_SIZED_PIXELS = 268000000;
function rgb8SizeFromProbe(probe, autoOrient) {
  const meta = probe.ok ? probe.metadata : undefined;
  if (!meta || meta.width <= 0 || meta.height <= 0 || meta.format === "dng") {
    return 0;
  }
  if (meta.width * meta.height > MAX_PROBE_SIZED_PIXELS) {
    return 0;
  }
  const swapped = autoOrient && meta.orientation >= 5 && meta.orientation <= 8;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  return width * height * 3;
}
function createRasterV2Binding(lib, ptr, getLastError, probeMetadata) {
  return {
    rasterRenderBuf(inputBytes, width, height, flags, filter, format, quality, effort) {
      const fmtBuf = format ? Buffer.from(format + "\x00", "utf-8") : null;
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf) => lib.symbols.maple_raster_render_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), width >>> 0, height >>> 0, flags >>> 0, filter >>> 0, fmtBuf ? ptr(fmtBuf) : null, quality & 255, effort & 255, ptr(outBuf), BigInt(outBuf.byteLength), ptr(outLenBuf));
      const first = Buffer.alloc(Math.max(65536, inputBytes.byteLength * 2));
      const rc0 = call(first);
      const outBuf = rc0 === NEED_LARGER_BUFFER3 ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === NEED_LARGER_BUFFER3 ? call(outBuf) : rc0;
      if (rc !== 0) {
        return { ok: false, error: getLastError() || `Raster render failed with code ${rc}` };
      }
      return { ok: true, buffer: outBuf.subarray(0, Number(outLenBuf.readBigUInt64LE(0))) };
    },
    rasterFromRawRenderBuf(pixels, srcWidth, srcHeight, channels, width, height, flags, filter, format, quality, effort) {
      const fmtBuf = format ? Buffer.from(format + "\x00", "utf-8") : null;
      const outLenBuf = Buffer.alloc(8);
      const call = (outBuf) => lib.symbols.maple_raster_from_raw_render_buf(ptr(pixels), BigInt(pixels.byteLength), srcWidth >>> 0, srcHeight >>> 0, channels >>> 0, width >>> 0, height >>> 0, flags >>> 0, filter >>> 0, fmtBuf ? ptr(fmtBuf) : null, quality & 255, effort & 255, ptr(outBuf), BigInt(outBuf.byteLength), ptr(outLenBuf));
      const first = Buffer.alloc(Math.max(65536, pixels.byteLength));
      const rc0 = call(first);
      const outBuf = rc0 === NEED_LARGER_BUFFER3 ? Buffer.alloc(Number(outLenBuf.readBigUInt64LE(0))) : first;
      const rc = rc0 === NEED_LARGER_BUFFER3 ? call(outBuf) : rc0;
      if (rc !== 0) {
        return { ok: false, error: getLastError() || `Raw raster render failed with code ${rc}` };
      }
      return { ok: true, buffer: outBuf.subarray(0, Number(outLenBuf.readBigUInt64LE(0))) };
    },
    rasterDecodeRgb8Buf(inputBytes, autoOrient) {
      const outLenBuf = Buffer.alloc(8);
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const call = (outBuf) => lib.symbols.maple_raster_decode_rgb8_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), autoOrient ? 1 : 0, outBuf ? ptr(outBuf) : null, BigInt(outBuf ? outBuf.byteLength : 0), ptr(outLenBuf), ptr(wBuf), ptr(hBuf));
      const needed = () => Number(outLenBuf.readBigUInt64LE(0));
      const failed = (rc) => ({
        ok: false,
        error: getLastError() || `RGB8 decode failed with code ${rc}`
      });
      const decoded = (outBuf) => ({
        ok: true,
        buffer: outBuf.subarray(0, needed()),
        width: wBuf.readUInt32LE(0),
        height: hBuf.readUInt32LE(0)
      });
      const sized = rgb8SizeFromProbe(probeMetadata(inputBytes), autoOrient);
      if (sized > 0) {
        const outBuf = Buffer.alloc(sized);
        const rc = call(outBuf);
        if (rc === 0) {
          return decoded(outBuf);
        }
        if (rc !== NEED_LARGER_BUFFER3) {
          return failed(rc);
        }
        const grown = Buffer.alloc(needed());
        const rcGrown = call(grown);
        return rcGrown === 0 ? decoded(grown) : failed(rcGrown);
      }
      const rc0 = call(null);
      if (rc0 !== NEED_LARGER_BUFFER3) {
        return failed(rc0);
      }
      const outBuf = Buffer.alloc(needed());
      const rc = call(outBuf);
      return rc === 0 ? decoded(outBuf) : failed(rc);
    }
  };
}

// src/platform.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
function isMusl() {
  if (process.platform !== "linux")
    return false;
  try {
    const report = process.report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) {
      return false;
    }
  } catch {}
  try {
    if (fs.existsSync("/proc/self/maps")) {
      const maps = fs.readFileSync("/proc/self/maps", "utf-8");
      if (maps.includes("libc.so") || maps.includes("ld-linux")) {
        return false;
      }
      if (maps.includes("ld-musl-") || maps.includes("libc.musl-")) {
        return true;
      }
    }
  } catch {}
  try {
    if (fs.existsSync("/etc/alpine-release")) {
      return true;
    }
  } catch {}
  try {
    const bun = globalThis.Bun;
    if (bun) {
      const res = bun.spawnSync(["ldd", "--version"]);
      const text = ((res.stdout?.toString() || "") + (res.stderr?.toString() || "")).toLowerCase();
      if (text.includes("musl")) {
        return true;
      }
      if (text.includes("glibc") || text.includes("gnu libc")) {
        return false;
      }
    }
  } catch {}
  try {
    for (const dir of ["/lib", "/lib64", "/usr/lib"]) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        if (files.some((f) => f.startsWith("ld-musl-"))) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}
function getPlatformPackageName(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (platform === "darwin") {
    if (arch === "arm64")
      return "@justmaple/maple-darwin-arm64";
    if (arch === "x64")
      return "@justmaple/maple-darwin-x64";
  } else if (platform === "linux") {
    const libc = musl ? "musl" : "gnu";
    if (arch === "x64")
      return `@justmaple/maple-linux-x64-${libc}`;
    if (arch === "arm64")
      return `@justmaple/maple-linux-arm64-${libc}`;
  } else if (platform === "win32") {
    if (arch === "x64")
      return "@justmaple/maple-win32-x64-msvc";
  }
  return null;
}
function getPlatformBinaryFilename(platform = process.platform) {
  if (platform === "win32")
    return "raw_ffi.dll";
  if (platform === "darwin")
    return "libraw_ffi.dylib";
  return "libraw_ffi.so";
}
function getPlatformNapiFilename(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (platform === "darwin")
    return `raw-napi.darwin-${arch === "arm64" ? "arm64" : "x64"}.node`;
  if (platform === "win32")
    return "raw-napi.win32-x64-msvc.node";
  const libc = musl ? "musl" : "gnu";
  return `raw-napi.linux-${arch === "arm64" ? "arm64" : "x64"}-${libc}.node`;
}
function napiCargoLibFilename(platform = process.platform) {
  if (platform === "win32")
    return "raw_napi.dll";
  if (platform === "darwin")
    return "libraw_napi.dylib";
  return "libraw_napi.so";
}
function resolvePlatformNapiAddon() {
  const pkgName = getPlatformPackageName();
  if (!pkgName)
    return null;
  const napiName = getPlatformNapiFilename();
  try {
    const resolved = __require.resolve(`${pkgName}/${napiName}`);
    if (fs.existsSync(resolved))
      return path.resolve(resolved);
  } catch {}
  const currentDir = import.meta.dir || path.dirname(fileURLToPath(import.meta.url));
  const shortName = pkgName.replace("@justmaple/maple-", "");
  const napiCargoTarget = path.join(currentDir, "..", "..", "raw-pipeline", "target");
  const napiLibName = napiCargoLibFilename();
  const candidates = [
    path.join(currentDir, "..", "..", pkgName, napiName),
    path.join(currentDir, "..", "node_modules", pkgName, napiName),
    path.join(process.cwd(), "node_modules", pkgName, napiName),
    path.join(currentDir, "..", "npm", shortName, napiName),
    path.join(process.cwd(), "npm", shortName, napiName),
    path.join(napiCargoTarget, "release", napiLibName),
    path.join(napiCargoTarget, "aarch64-apple-darwin", "release", napiLibName),
    path.join(napiCargoTarget, "x86_64-apple-darwin", "release", napiLibName),
    path.join(napiCargoTarget, "x86_64-unknown-linux-gnu", "release", napiLibName),
    path.join(napiCargoTarget, "aarch64-unknown-linux-gnu", "release", napiLibName),
    path.join(napiCargoTarget, "x86_64-pc-windows-msvc", "release", napiLibName)
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}
function resolvePlatformPackageLib() {
  const pkgName = getPlatformPackageName();
  if (!pkgName)
    return null;
  const libName = getPlatformBinaryFilename();
  try {
    const resolvedMain = __require.resolve(pkgName);
    if (fs.existsSync(resolvedMain) && fs.statSync(resolvedMain).isFile()) {
      return path.resolve(resolvedMain);
    }
  } catch {}
  try {
    const resolvedFile = __require.resolve(`${pkgName}/${libName}`);
    if (fs.existsSync(resolvedFile)) {
      return path.resolve(resolvedFile);
    }
  } catch {}
  const currentDir = import.meta.dir || path.dirname(fileURLToPath(import.meta.url));
  const shortName = pkgName.replace("@justmaple/maple-", "");
  const candidateDirs = [
    path.join(currentDir, "..", "..", pkgName, libName),
    path.join(currentDir, "..", "node_modules", pkgName, libName),
    path.join(process.cwd(), "node_modules", pkgName, libName),
    path.join(currentDir, "..", "npm", shortName, libName),
    path.join(process.cwd(), "npm", shortName, libName)
  ];
  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

// src/native.ts
var RENDER_OUT_CAP = 1024;
var _cachedBinding = undefined;
function nativeLibFilename() {
  if (process.platform === "win32")
    return "raw_ffi.dll";
  if (process.platform === "darwin")
    return "libraw_ffi.dylib";
  return "libraw_ffi.so";
}
function firstExisting(candidates) {
  const hit = candidates.find((candidate) => fs2.existsSync(candidate));
  return hit ? path2.resolve(hit) : null;
}
function findNativeLib() {
  if (process.env.MAPLE_NATIVE_LIB && fs2.existsSync(process.env.MAPLE_NATIVE_LIB)) {
    return process.env.MAPLE_NATIVE_LIB;
  }
  const libName = nativeLibFilename();
  const currentDir = import.meta.dir || path2.dirname(fileURLToPath2(import.meta.url));
  const cargoTarget = path2.join(currentDir, "..", "..", "raw-pipeline", "target");
  const sourceBuilt = [
    path2.join(cargoTarget, "release", libName),
    path2.join(cargoTarget, "aarch64-apple-darwin", "release", libName),
    path2.join(cargoTarget, "x86_64-apple-darwin", "release", libName),
    path2.join(cargoTarget, "x86_64-unknown-linux-gnu", "release", libName),
    path2.join(cargoTarget, "aarch64-unknown-linux-gnu", "release", libName),
    path2.join(cargoTarget, "x86_64-pc-windows-msvc", "release", libName),
    path2.join(currentDir, "..", "..", "api", "native", libName)
  ];
  const runtime = [
    path2.join(currentDir, "..", "native", libName),
    path2.join(process.cwd(), "native", libName),
    path2.join("/app", "native", libName),
    path2.join("/usr/local/lib", libName),
    path2.join("/usr/lib", libName)
  ];
  return firstExisting(sourceBuilt) ?? resolvePlatformPackageLib() ?? firstExisting(runtime);
}
function loadNativeBinding() {
  if (_cachedBinding !== undefined && _cachedBinding !== null) {
    return _cachedBinding;
  }
  const libPath = findNativeLib();
  if (!libPath) {
    throw new Error(`Maple native library (${nativeLibFilename()}) not found. Build it with cargo build --release -p raw-ffi or set MAPLE_NATIVE_LIB.`);
  }
  if (typeof globalThis.Bun === "undefined") {
    throw new Error("Maple native bindings currently require Bun (bun:ffi).");
  }
  const { dlopen, FFIType, ptr } = __require("bun:ffi");
  const lib = dlopen(libPath, getFfiSymbols(FFIType));
  function getLastError() {
    const res = lib.symbols.maple_last_error();
    return res ? String(res) : null;
  }
  const binding = {
    exportDevelopedToFile(rawPath, xmpPath, format, quality, colorSpace, maxLongEdge, outPath) {
      const rawBuf = Buffer.from(rawPath + "\x00", "utf-8");
      const xmpBuf = xmpPath ? Buffer.from(xmpPath + "\x00", "utf-8") : null;
      const formatBuf = Buffer.from(format + "\x00", "utf-8");
      const csBuf = Buffer.from(colorSpace + "\x00", "utf-8");
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const rc = lib.symbols.maple_export_developed_to_file(ptr(rawBuf), xmpBuf ? ptr(xmpBuf) : null, ptr(formatBuf), quality & 255, ptr(csBuf), maxLongEdge >>> 0, ptr(outBuf));
      if (rc !== 0) {
        const err = getLastError() || `Export failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    exportRecipeToFile(rawPath, xmpXml, recipeJson, filmPath, outPath) {
      const rawBuf = Buffer.from(rawPath + "\x00", "utf-8");
      const xmpBuf = Buffer.from(xmpXml + "\x00", "utf-8");
      const recipeBuf = Buffer.from(recipeJson + "\x00", "utf-8");
      const filmBuf = filmPath ? Buffer.from(filmPath + "\x00", "utf-8") : null;
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const rc = lib.symbols.maple_export_recipe_to_file(ptr(rawBuf), ptr(xmpBuf), ptr(recipeBuf), filmBuf ? ptr(filmBuf) : null, ptr(outBuf));
      if (rc !== 0) {
        const err = getLastError() || `Recipe export failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    renderThumbnailAvifToFile(rawPath, outPath, maxPx, quality = 55) {
      const rawBuf = Buffer.from(rawPath + "\x00", "utf-8");
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const rc = lib.symbols.maple_render_thumbnail_avif_to_file(ptr(rawBuf), ptr(outBuf), maxPx >>> 0, quality & 255);
      if (rc !== 0) {
        const err = getLastError() || `Thumbnail render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    renderThumbnailPreviewJpegToFile(rawPath, outPath, maxPx, quality = 85) {
      const rawBuf = Buffer.from(rawPath + "\x00", "utf-8");
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const rc = lib.symbols.maple_render_thumbnail_preview_jpeg_to_file(ptr(rawBuf), ptr(outBuf), maxPx >>> 0, quality & 255);
      if (rc !== 0) {
        const err = getLastError() || `Preview render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    renderDevelopJpegToFile(rawPath, xmpPath, outPath, maxPx, quality = 85) {
      const rawBuf = Buffer.from(rawPath + "\x00", "utf-8");
      const xmpBuf = xmpPath ? Buffer.from(xmpPath + "\x00", "utf-8") : null;
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const rc = lib.symbols.maple_render_develop_jpeg_to_file(ptr(rawBuf), xmpBuf ? ptr(xmpBuf) : null, maxPx >>> 0, quality & 255, ptr(outBuf));
      if (rc !== 0) {
        const err = getLastError() || `Develop render failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    rasterResizeToFile(inputPath, outPath, width, height, fit, format, quality) {
      const inBuf = Buffer.from(inputPath + "\x00", "utf-8");
      const outBuf = Buffer.from(outPath + "\x00", "utf-8");
      const fmtBuf = format ? Buffer.from(format + "\x00", "utf-8") : null;
      const rc = lib.symbols.maple_raster_resize_to_file(ptr(inBuf), ptr(outBuf), width >>> 0, height >>> 0, fit >>> 0, fmtBuf ? ptr(fmtBuf) : null, quality & 255);
      if (rc !== 0) {
        const err = getLastError() || `Raster resize failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true };
    },
    rasterResizeToBuf(inputBytes, width, height, fit, format, quality) {
      const fmtBuf = format ? Buffer.from(format + "\x00", "utf-8") : null;
      let cap = Math.max(65536, inputBytes.byteLength * 2);
      let outBuf = Buffer.alloc(cap);
      const outLenBuf = Buffer.alloc(8);
      let rc = lib.symbols.maple_raster_resize_to_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), width >>> 0, height >>> 0, fit >>> 0, fmtBuf ? ptr(fmtBuf) : null, quality & 255, ptr(outBuf), BigInt(cap), ptr(outLenBuf));
      if (rc === 100) {
        cap = Number(outLenBuf.readBigUInt64LE(0));
        outBuf = Buffer.alloc(cap);
        rc = lib.symbols.maple_raster_resize_to_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), width >>> 0, height >>> 0, fit >>> 0, fmtBuf ? ptr(fmtBuf) : null, quality & 255, ptr(outBuf), BigInt(cap), ptr(outLenBuf));
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
        const bytes = fs2.readFileSync(inputPath);
        return this.rasterProbeMetadataBuf(bytes);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    rasterProbeMetadataBuf(inputBytes) {
      const wBuf = Buffer.alloc(4);
      const hBuf = Buffer.alloc(4);
      const cBuf = Buffer.alloc(4);
      const oBuf = Buffer.alloc(4);
      const fmtBuf = Buffer.alloc(32);
      const rc = lib.symbols.maple_raster_probe_metadata_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), ptr(wBuf), ptr(hBuf), ptr(cBuf), ptr(oBuf), ptr(fmtBuf), BigInt(32));
      if (rc !== 0) {
        const err = getLastError() || `Metadata probe failed with code ${rc}`;
        return { ok: false, error: err };
      }
      const nullIdx = fmtBuf.indexOf(0);
      const format = (nullIdx >= 0 ? fmtBuf.subarray(0, nullIdx) : fmtBuf).toString("utf-8");
      return {
        ok: true,
        metadata: {
          width: wBuf.readUInt32LE(0),
          height: hBuf.readUInt32LE(0),
          channels: cBuf.readUInt32LE(0),
          orientation: oBuf.readUInt32LE(0),
          format
        }
      };
    },
    rasterExtractTensor(inputBytes, targetSize, layout, normalize) {
      const targetW = targetSize || 640;
      const targetH = targetSize || 640;
      const totalFloats = 3 * targetW * targetH;
      const floatArr = new Float32Array(totalFloats);
      const outLenBuf = Buffer.alloc(8);
      const rc = lib.symbols.maple_raster_extract_tensor_buf(ptr(inputBytes), BigInt(inputBytes.byteLength), targetSize >>> 0, layout >>> 0, normalize >>> 0, ptr(floatArr), BigInt(totalFloats), ptr(outLenBuf));
      if (rc !== 0) {
        const err = getLastError() || `Tensor extraction failed with code ${rc}`;
        return { ok: false, error: err };
      }
      return { ok: true, tensor: floatArr };
    },
    ...createRasterV2Binding(lib, ptr, getLastError, (bytes) => binding.rasterProbeMetadataBuf(bytes)),
    ...createRasterPipelineBinding(lib, ptr, getLastError),
    ...createRasterAnalyzeBinding(lib, ptr, getLastError),
    renderFilenameTemplate(args) {
      const templateBuf = Buffer.from(args.template + "\x00", "utf-8");
      const stemBuf = Buffer.from(args.originalStem + "\x00", "utf-8");
      const extBuf = Buffer.from(args.ext + "\x00", "utf-8");
      const capturedBuf = args.capturedAt ? Buffer.from(args.capturedAt + "\x00", "utf-8") : null;
      const outBuf = Buffer.alloc(RENDER_OUT_CAP);
      const outLenBuf = Buffer.alloc(8);
      const rc = lib.symbols.maple_render_filename_template_buf(ptr(templateBuf), ptr(stemBuf), ptr(extBuf), capturedBuf ? ptr(capturedBuf) : null, BigInt(args.sequenceStart), BigInt(args.sequenceIndex), BigInt(args.sequencePadWidth), ptr(outBuf), BigInt(RENDER_OUT_CAP), ptr(outLenBuf));
      if (rc !== 0) {
        const err = getLastError() || `Filename render failed with code ${rc}`;
        return { ok: false, code: rc, error: err };
      }
      const outLen = Number(outLenBuf.readBigUInt64LE(0));
      const rendered = outBuf.subarray(0, outLen).toString("utf-8");
      return { ok: true, name: rendered };
    },
    validateFilename(name) {
      const nameBuf = Buffer.from(name + "\x00", "utf-8");
      const rc = lib.symbols.maple_validate_filename(ptr(nameBuf));
      if (rc !== 0) {
        const err = getLastError() || `Filename validation failed with code ${rc}`;
        return { ok: false, code: rc, error: err };
      }
      return { ok: true };
    },
    lastError: getLastError
  };
  _cachedBinding = binding;
  return binding;
}
function renderFilenameTemplate(args) {
  return loadNativeBinding().renderFilenameTemplate(args);
}
function validateFilename(name) {
  return loadNativeBinding().validateFilename(name);
}
function isNativeAvailable() {
  try {
    return findNativeLib() !== null;
  } catch {
    return false;
  }
}

// src/worker-protocol.ts
var TRANSFER_MARK = "__mapleTransfer__";
function transferKindOf(value) {
  if (Buffer.isBuffer(value))
    return "Buffer";
  if (value instanceof Float32Array)
    return "Float32Array";
  return "Uint8Array";
}
function isTypedArray(value) {
  return value instanceof Uint8Array || value instanceof Float32Array;
}
function isTransferPlaceholder(value) {
  return typeof value === "object" && value !== null && TRANSFER_MARK in value;
}
function prepareForTransfer(value, transferList = []) {
  if (isTypedArray(value)) {
    const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    transferList.push(buffer);
    const placeholder = {
      [TRANSFER_MARK]: transferKindOf(value),
      buffer,
      byteOffset: 0,
      byteLength: value.byteLength
    };
    return { value: placeholder, transferList };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((entry) => prepareForTransfer(entry, transferList).value),
      transferList
    };
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = prepareForTransfer(entry, transferList).value;
    }
    return { value: out, transferList };
  }
  return { value, transferList };
}
function restoreFromTransfer(value) {
  if (isTransferPlaceholder(value)) {
    if (value[TRANSFER_MARK] === "Buffer") {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value[TRANSFER_MARK] === "Float32Array") {
      return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    return value.map(restoreFromTransfer);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = restoreFromTransfer(entry);
    }
    return out;
  }
  return value;
}

// src/native-worker-entry.ts
var cachedNative = null;
function native() {
  if (!cachedNative) {
    cachedNative = loadNativeBinding();
  }
  return cachedNative;
}
globalThis.onmessage = (event) => {
  const { id, method, args } = event.data;
  try {
    const fn = native()[method];
    if (typeof fn !== "function") {
      throw new Error(`Maple worker: unknown native method '${method}'`);
    }
    const result = fn.apply(native(), args);
    const { value, transferList } = prepareForTransfer(result);
    const response = { id, ok: true, result: value };
    postMessage(response, transferList);
  } catch (error) {
    const response = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    postMessage(response);
  }
};
