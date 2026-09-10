import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);
// src/maple/src/platform.ts
import * as fs from "node:fs";
import * as path from "node:path";
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
    if (fs.existsSync("/etc/alpine-release")) {
      return true;
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
  try {
    const bun = globalThis.Bun;
    if (bun) {
      const res = bun.spawnSync(["ldd", "--version"]);
      const text = (res.stdout?.toString() || "") + (res.stderr?.toString() || "");
      if (text.toLowerCase().includes("musl")) {
        return true;
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
  const currentDir = import.meta.dir || path.dirname(new URL(import.meta.url).pathname);
  const candidateDirs = [
    path.join(currentDir, "..", "..", pkgName, libName),
    path.join(currentDir, "..", "node_modules", pkgName, libName),
    path.join(process.cwd(), "node_modules", pkgName, libName)
  ];
  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}
// src/maple/src/native.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// src/maple/src/ffi-symbols.ts
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
    maple_last_error: {
      args: [],
      returns: FFIType.cstring
    }
  };
}

// src/maple/src/native.ts
var RENDER_OUT_CAP = 1024;
var _cachedBinding = undefined;
function nativeLibFilename() {
  if (process.platform === "win32")
    return "raw_ffi.dll";
  if (process.platform === "darwin")
    return "libraw_ffi.dylib";
  return "libraw_ffi.so";
}
function findNativeLib() {
  if (process.env.MAPLE_NATIVE_LIB && fs2.existsSync(process.env.MAPLE_NATIVE_LIB)) {
    return process.env.MAPLE_NATIVE_LIB;
  }
  const platformLib = resolvePlatformPackageLib();
  if (platformLib) {
    return platformLib;
  }
  const libName = nativeLibFilename();
  const currentDir = import.meta.dir || path2.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path2.join(currentDir, "..", "native", libName),
    path2.join(process.cwd(), "native", libName),
    path2.join("/app", "native", libName),
    path2.join(currentDir, "..", "..", "api", "native", libName),
    path2.join(currentDir, "..", "..", "raw-pipeline", "target", "release", libName),
    path2.join(currentDir, "..", "..", "raw-pipeline", "target", "aarch64-apple-darwin", "release", libName),
    path2.join(currentDir, "..", "..", "raw-pipeline", "target", "x86_64-apple-darwin", "release", libName),
    path2.join(currentDir, "..", "..", "raw-pipeline", "target", "x86_64-unknown-linux-gnu", "release", libName),
    path2.join(currentDir, "..", "..", "raw-pipeline", "target", "aarch64-unknown-linux-gnu", "release", libName),
    path2.join("/usr/local/lib", libName),
    path2.join("/usr/lib", libName)
  ];
  for (const candidate of candidates) {
    if (fs2.existsSync(candidate)) {
      return path2.resolve(candidate);
    }
  }
  return null;
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
// src/maple/src/export.ts
import * as fs3 from "node:fs/promises";
import * as path3 from "node:path";
function inferFormatFromExt(filePath) {
  const ext = path3.extname(filePath).toLowerCase();
  if (ext === ".tif" || ext === ".tiff")
    return "tiff";
  if (ext === ".png")
    return "png";
  return "jpeg";
}
async function exportImage(options) {
  const native = loadNativeBinding();
  const format = options.format ?? inferFormatFromExt(options.outPath);
  const quality = options.quality ?? 92;
  const colorSpace = options.colorSpace ?? "srgb";
  const maxLongEdge = options.maxLongEdge ?? 0;
  const parentDir = path3.dirname(options.outPath);
  await fs3.mkdir(parentDir, { recursive: true });
  const res = native.exportDevelopedToFile(path3.resolve(options.rawPath), options.xmpPath ? path3.resolve(options.xmpPath) : null, format, quality, colorSpace, maxLongEdge, path3.resolve(options.outPath));
  if (!res.ok) {
    return { ok: false, outPath: options.outPath, error: res.error };
  }
  return { ok: true, outPath: options.outPath };
}
async function exportRecipe(options) {
  const native = loadNativeBinding();
  const recipeJson = typeof options.recipe === "string" ? options.recipe : JSON.stringify(options.recipe);
  let xmpXml = options.xmpXml ?? "";
  if (!xmpXml) {
    const candidateXmp = options.rawPath.replace(/\.[^.]+$/, ".xmp");
    try {
      xmpXml = await fs3.readFile(candidateXmp, "utf-8");
    } catch {
      xmpXml = "";
    }
  }
  const parentDir = path3.dirname(options.outPath);
  await fs3.mkdir(parentDir, { recursive: true });
  const res = native.exportRecipeToFile(path3.resolve(options.rawPath), xmpXml, recipeJson, options.filmPath ? path3.resolve(options.filmPath) : null, path3.resolve(options.outPath));
  if (!res.ok) {
    return { ok: false, outPath: options.outPath, error: res.error };
  }
  return { ok: true, outPath: options.outPath };
}
async function renderThumbnail(options) {
  const native = loadNativeBinding();
  await fs3.mkdir(path3.dirname(options.outPath), { recursive: true });
  const res = native.renderThumbnailAvifToFile(path3.resolve(options.rawPath), path3.resolve(options.outPath), options.maxPx ?? 512, options.quality ?? 55);
  if (!res.ok) {
    throw new Error(res.error);
  }
  return true;
}
async function renderPreview(options) {
  const native = loadNativeBinding();
  await fs3.mkdir(path3.dirname(options.outPath), { recursive: true });
  const res = native.renderThumbnailPreviewJpegToFile(path3.resolve(options.rawPath), path3.resolve(options.outPath), options.maxPx ?? 1280, options.quality ?? 85);
  if (!res.ok) {
    throw new Error(res.error);
  }
  return true;
}
// src/maple/src/builder.ts
import * as crypto from "node:crypto";
import * as fs4 from "node:fs/promises";
import * as os from "node:os";
import * as path4 from "node:path";
var RAW_EXTENSIONS = new Set([
  ".dng",
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".pef",
  ".ptx",
  ".raf",
  ".rw2",
  ".orf",
  ".srw",
  ".erf",
  ".kdc",
  ".mos",
  ".mrw",
  ".3fr",
  ".fff"
]);
function isRawPath(filePath) {
  const ext = path4.extname(filePath).toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

class MapleImageBuilder {
  _inputPath = null;
  _inputBytes = null;
  _xmpPath = null;
  _xmpXml = null;
  _format = null;
  _quality = 92;
  _colorSpace = "srgb";
  _maxLongEdge = 0;
  _filmPath = null;
  _recipe = null;
  _resizeWidth = 0;
  _resizeHeight = 0;
  _resizeFit = "inside";
  _withoutEnlargement = true;
  _autoOrient = false;
  _removeAlpha = false;
  constructor(input) {
    if (typeof input === "string") {
      this._inputPath = input;
    } else {
      this._inputBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    }
  }
  xmp(xmpPath) {
    this._xmpPath = xmpPath;
    return this;
  }
  applyXmp(xml) {
    this._xmpXml = xml;
    return this;
  }
  xmpContent(xml) {
    this._xmpXml = xml;
    return this;
  }
  resize(optionsOrWidth, height) {
    if (typeof optionsOrWidth === "number") {
      this._resizeWidth = Math.max(0, optionsOrWidth);
      this._resizeHeight = Math.max(0, height ?? 0);
    } else {
      this._resizeWidth = Math.max(0, optionsOrWidth.width ?? 0);
      this._resizeHeight = Math.max(0, optionsOrWidth.height ?? 0);
      if (optionsOrWidth.fit) {
        this._resizeFit = optionsOrWidth.fit === "fill" ? "fill" : "inside";
      }
      if (optionsOrWidth.withoutEnlargement !== undefined) {
        this._withoutEnlargement = optionsOrWidth.withoutEnlargement;
      }
    }
    return this;
  }
  rotate() {
    this._autoOrient = true;
    return this;
  }
  toFormat(format, options) {
    this._format = format;
    if (options?.quality !== undefined) {
      this._quality = Math.max(1, Math.min(100, options.quality));
    }
    return this;
  }
  format(format) {
    this._format = format;
    return this;
  }
  quality(quality) {
    this._quality = Math.max(1, Math.min(100, quality));
    return this;
  }
  colorSpace(space) {
    this._colorSpace = space;
    return this;
  }
  toColourspace(space) {
    if (space === "display-p3" || space === "p3") {
      this._colorSpace = "display-p3";
    } else {
      this._colorSpace = "srgb";
    }
    return this;
  }
  removeAlpha() {
    this._removeAlpha = true;
    return this;
  }
  maxLongEdge(px) {
    this._maxLongEdge = Math.max(0, px);
    return this;
  }
  filmPath(dir) {
    this._filmPath = dir;
    return this;
  }
  recipe(recipe) {
    this._recipe = recipe;
    return this;
  }
  exportRecipe(recipe) {
    this._recipe = recipe;
    return this;
  }
  async metadata() {
    const native = loadNativeBinding();
    if (this._inputBytes) {
      const res2 = native.rasterProbeMetadataBuf(this._inputBytes);
      if (!res2.ok || !res2.metadata) {
        throw new Error(res2.error || "Failed to probe metadata");
      }
      return {
        width: res2.metadata.width,
        height: res2.metadata.height,
        format: res2.metadata.format,
        channels: res2.metadata.channels,
        orientation: res2.metadata.orientation,
        isRaw: res2.metadata.format === "dng"
      };
    }
    if (!this._inputPath) {
      throw new Error("No input provided to MapleImageBuilder");
    }
    const res = native.rasterProbeMetadata(this._inputPath);
    if (!res.ok || !res.metadata) {
      throw new Error(res.error || `Failed to probe metadata for ${this._inputPath}`);
    }
    return {
      width: res.metadata.width,
      height: res.metadata.height,
      format: res.metadata.format || path4.extname(this._inputPath).replace(".", "").toLowerCase(),
      channels: res.metadata.channels,
      orientation: res.metadata.orientation,
      isRaw: isRawPath(this._inputPath) || res.metadata.format === "dng"
    };
  }
  async validateIntegrity() {
    try {
      const meta = await this.metadata();
      if (meta.width <= 0 || meta.height <= 0)
        return false;
      await this.toBuffer();
      return true;
    } catch {
      return false;
    }
  }
  async normalizeOrientationInPlace() {
    if (!this._inputPath) {
      throw new Error("normalizeOrientationInPlace requires a file path input");
    }
    const meta = await this.metadata();
    if (meta.orientation <= 1) {
      return true;
    }
    const ext = path4.extname(this._inputPath) || ".jpg";
    const tempOut = `${this._inputPath}.orient_tmp.${Date.now()}.${crypto.randomUUID()}${ext}`;
    const targetFmt = this._format || meta.format || "jpeg";
    const res = await this.rotate().format(targetFmt).toFile(tempOut);
    if (!res.ok) {
      try {
        await fs4.unlink(tempOut);
      } catch {}
      throw new Error(res.error || "Failed to normalize orientation");
    }
    await fs4.rename(tempOut, this._inputPath);
    return true;
  }
  async toRawRgb(options) {
    const native = loadNativeBinding();
    let bytes = this._inputBytes;
    if (!bytes && this._inputPath) {
      bytes = await fs4.readFile(this._inputPath);
    }
    if (!bytes || bytes.length === 0) {
      throw new Error("Input image is empty");
    }
    const targetSize = options?.targetSize ?? (this._resizeWidth || 640);
    const layoutNum = options?.layout === "hwc" ? 1 : 0;
    const normNum = options?.normalize === "insightface" ? 1 : options?.normalize === "zeroToOne" ? 2 : 0;
    const res = native.rasterExtractTensor(bytes, targetSize, layoutNum, normNum);
    if (!res.ok || !res.tensor) {
      throw new Error(res.error || "Failed to extract tensor");
    }
    return {
      data: res.tensor,
      width: targetSize,
      height: targetSize,
      channels: 3
    };
  }
  async toBuffer() {
    const native = loadNativeBinding();
    let bytes = this._inputBytes;
    if (!bytes && this._inputPath && !isRawPath(this._inputPath)) {
      bytes = await fs4.readFile(this._inputPath);
    }
    if (bytes) {
      let fitMask = this._resizeFit === "fill" ? 1 : 0;
      if (this._autoOrient)
        fitMask |= 2;
      if (!this._withoutEnlargement)
        fitMask |= 4;
      const formatStr = this._format || "jpeg";
      const res = native.rasterResizeToBuf(bytes, this._resizeWidth, this._resizeHeight, fitMask, formatStr, this._quality);
      if (!res.ok || !res.buffer) {
        throw new Error(res.error || "Failed to transcode image to buffer");
      }
      return res.buffer;
    }
    if (this._inputPath) {
      const ext = this._format ? `.${this._format === "jpeg" ? "jpg" : this._format}` : ".jpg";
      const tmpFile = path4.join(os.tmpdir(), `maple_buf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
      try {
        const fileRes = await this.toFile(tmpFile);
        if (!fileRes.ok) {
          throw new Error(fileRes.error || "Failed to develop RAW to buffer");
        }
        const buf = await fs4.readFile(tmpFile);
        return buf;
      } finally {
        try {
          await fs4.unlink(tmpFile);
        } catch {}
      }
    }
    throw new Error("No input provided to MapleImageBuilder");
  }
  async toFile(outputPath) {
    if (this._recipe && this._inputPath) {
      return exportRecipe({
        rawPath: this._inputPath,
        xmpXml: this._xmpXml ?? undefined,
        recipe: this._recipe,
        filmPath: this._filmPath,
        outPath: outputPath
      });
    }
    if (this._inputPath && (isRawPath(this._inputPath) || this._xmpPath || this._xmpXml)) {
      return exportImage({
        rawPath: this._inputPath,
        xmpPath: this._xmpPath,
        format: this._format ?? undefined,
        quality: this._quality,
        colorSpace: this._colorSpace,
        maxLongEdge: this._maxLongEdge || this._resizeWidth || 0,
        outPath: outputPath
      });
    }
    const native = loadNativeBinding();
    const parentDir = path4.dirname(outputPath);
    await fs4.mkdir(parentDir, { recursive: true });
    let fitMask = this._resizeFit === "fill" ? 1 : 0;
    if (this._autoOrient)
      fitMask |= 2;
    if (!this._withoutEnlargement)
      fitMask |= 4;
    const targetFormat = this._format || null;
    if (this._inputPath) {
      const res = native.rasterResizeToFile(path4.resolve(this._inputPath), path4.resolve(outputPath), this._resizeWidth, this._resizeHeight, fitMask, targetFormat, this._quality);
      if (!res.ok) {
        return { ok: false, outPath: outputPath, error: res.error };
      }
      return { ok: true, outPath: outputPath };
    }
    if (this._inputBytes) {
      const bufRes = native.rasterResizeToBuf(this._inputBytes, this._resizeWidth, this._resizeHeight, fitMask, targetFormat, this._quality);
      if (!bufRes.ok || !bufRes.buffer) {
        return { ok: false, outPath: outputPath, error: bufRes.error };
      }
      await fs4.writeFile(outputPath, bufRes.buffer);
      return { ok: true, outPath: outputPath };
    }
    return { ok: false, outPath: outputPath, error: "No input provided" };
  }
}
function maple(input) {
  return new MapleImageBuilder(input);
}
// src/maple/src/cli.ts
import * as fs5 from "node:fs/promises";
import * as path5 from "node:path";
function printHelp() {
  console.log(`
maple - Professional RAW photo development and export engine by Just Maple

USAGE:
  npx maple <command> [options]

COMMANDS:
  export <photo> [options]        Develop and export a RAW photo
  recipe <recipe.json> <photos..> Batch export photos using a saved recipe
  thumb <photo> [options]         Extract and render an optimized thumbnail or preview
  resize <image> [options]        Resize and transcode a raster image with SIMD
  inspect <image>                 Inspect dimensions, format, and EXIF metadata
  help                            Show this help message
  version                         Show Maple package version

OPTIONS FOR "export":
  -o, --out <file>                Output image destination (required)
  -x, --xmp <file>                Path to XMP sidecar containing adjustments
  -f, --format <format>           Output container format: jpeg, tiff, png, avif, webp
  -q, --quality <1-100>           JPEG/WebP compression quality (default: 92)
  -c, --color-space <space>       Output primaries / ICC: srgb, display-p3 (default: srgb)
  -m, --max-edge <pixels>         Cap long edge dimension in pixels (default: native)
  -r, --recipe <recipe.json>      Apply a saved ExportRecipe JSON
  --film-dir <dir>                Directory of .mlut film LUTs (default: resources/film-luts)

OPTIONS FOR "resize":
  -o, --out <file>                Output destination path (required)
  -w, --width <pixels>            Target width (default: 0 = preserve aspect ratio)
  -h, --height <pixels>           Target height (default: 0 = preserve aspect ratio)
  --fit <inside|fill>             Fit mode (default: inside)
  -f, --format <format>           Output container: jpeg, png, webp, avif, tiff
  -q, --quality <1-100>           Quality (default: 85)
  --rotate                        Automatically rotate according to EXIF orientation

OPTIONS FOR "thumb":
  -o, --out <file>                Output thumbnail destination (required)
  -s, --size <pixels>             Target long edge in pixels (default: 512)
  -q, --quality <1-100>           Quality (default: 55 for AVIF, 85 for JPEG)
  -f, --format <avif|jpeg>        Thumbnail codec: avif, jpeg (default: avif)

OPTIONS FOR "inspect":
  --json                          Output technical details as raw JSON

EXAMPLES:
  # Export a RAW file to a Display P3 JPEG
  npx maple export DSC_0001.NEF -o output.jpg -c display-p3 -q 95

  # Export a RAW file with XMP adjustments
  npx maple export IMG_001.CR3 -x IMG_001.xmp -o output.jpg

  # Export using a Maple recipe
  npx maple export photo.dng -r web-sharing.json -o deliverable.jpg

  # Batch export photos with a recipe into a directory
  npx maple recipe web-sharing.json ./photos/*.ARW --out-dir ./exports/

  # Generate a 512px AVIF thumbnail
  npx maple thumb photo.dng -o thumb.avif
`);
}
async function runCli(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args.includes("--help") || args[0] === "help") {
    printHelp();
    return 0;
  }
  if (args.includes("-v") || args.includes("--version") || args[0] === "version") {
    console.log("maple 0.1.0 (Maple raw-core engine)");
    return 0;
  }
  const command = args[0];
  if (command === "export") {
    const rawPath = args[1];
    if (!rawPath || rawPath.startsWith("-")) {
      console.error('Error: "export" requires an input photo path as the first argument.');
      return 1;
    }
    let outPath = null;
    let xmpPath = null;
    let format;
    let quality;
    let colorSpace;
    let maxLongEdge;
    let recipePath = null;
    let filmDir = null;
    for (let i = 2;i < args.length; i++) {
      const arg = args[i];
      if ((arg === "-o" || arg === "--out") && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === "-x" || arg === "--xmp") && i + 1 < args.length) {
        xmpPath = args[++i];
      } else if ((arg === "-f" || arg === "--format") && i + 1 < args.length) {
        format = args[++i];
      } else if ((arg === "-q" || arg === "--quality") && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      } else if ((arg === "-c" || arg === "--color-space") && i + 1 < args.length) {
        colorSpace = args[++i];
      } else if ((arg === "-m" || arg === "--max-edge") && i + 1 < args.length) {
        maxLongEdge = parseInt(args[++i], 10);
      } else if ((arg === "-r" || arg === "--recipe") && i + 1 < args.length) {
        recipePath = args[++i];
      } else if (arg === "--film-dir" && i + 1 < args.length) {
        filmDir = args[++i];
      }
    }
    if (!outPath) {
      console.error("Error: Missing required argument: -o, --out <path>");
      return 1;
    }
    console.log(`Exporting ${rawPath} -> ${outPath}...`);
    const start = Date.now();
    if (recipePath) {
      const recipeContent = await fs5.readFile(recipePath, "utf-8");
      const res = await exportRecipe({
        rawPath,
        recipe: recipeContent,
        filmPath: filmDir,
        outPath
      });
      if (!res.ok) {
        console.error(`Export failed: ${res.error}`);
        return 1;
      }
    } else {
      const res = await exportImage({
        rawPath,
        xmpPath,
        format,
        quality,
        colorSpace,
        maxLongEdge,
        outPath
      });
      if (!res.ok) {
        console.error(`Export failed: ${res.error}`);
        return 1;
      }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const stat2 = await fs5.stat(outPath);
    console.log(`✓ Exported: ${outPath} (${(stat2.size / 1024).toFixed(1)} KB in ${elapsed}s)`);
    return 0;
  }
  if (command === "recipe") {
    const recipePath = args[1];
    if (!recipePath || recipePath.startsWith("-")) {
      console.error('Error: "recipe" requires a recipe JSON file as the first argument.');
      return 1;
    }
    let outDir = null;
    const photoFiles = [];
    for (let i = 2;i < args.length; i++) {
      const arg = args[i];
      if ((arg === "-d" || arg === "--out-dir") && i + 1 < args.length) {
        outDir = args[++i];
      } else if (!arg.startsWith("-")) {
        photoFiles.push(arg);
      }
    }
    if (!outDir) {
      console.error("Error: Missing required argument: -d, --out-dir <dir>");
      return 1;
    }
    if (photoFiles.length === 0) {
      console.error("Error: No photo files specified for batch recipe export.");
      return 1;
    }
    const recipeContent = await fs5.readFile(recipePath, "utf-8");
    const recipe = JSON.parse(recipeContent);
    await fs5.mkdir(outDir, { recursive: true });
    console.log(`Batch exporting ${photoFiles.length} photo(s) with recipe "${recipe.name}"...`);
    let succeeded = 0;
    let failed = 0;
    for (const file of photoFiles) {
      const stem = path5.basename(file, path5.extname(file));
      const ext = recipe.format === "tiff" ? "tif" : recipe.format === "png" ? "png" : "jpg";
      const dest = path5.join(outDir, `${stem}.${ext}`);
      process.stdout.write(`  Rendering ${stem}... `);
      const res = await exportRecipe({
        rawPath: file,
        recipe: recipeContent,
        outPath: dest
      });
      if (res.ok) {
        console.log("✓");
        succeeded++;
      } else {
        console.log(`✗ (${res.error})`);
        failed++;
      }
    }
    console.log(`Done. ${succeeded} succeeded, ${failed} failed.`);
    return failed > 0 ? 1 : 0;
  }
  if (command === "thumb") {
    const rawPath = args[1];
    if (!rawPath || rawPath.startsWith("-")) {
      console.error('Error: "thumb" requires an input photo path as the first argument.');
      return 1;
    }
    let outPath = null;
    let size = 512;
    let format = "avif";
    let quality;
    for (let i = 2;i < args.length; i++) {
      const arg = args[i];
      if ((arg === "-o" || arg === "--out") && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === "-s" || arg === "--size") && i + 1 < args.length) {
        size = parseInt(args[++i], 10);
      } else if ((arg === "-f" || arg === "--format") && i + 1 < args.length) {
        format = args[++i];
      } else if ((arg === "-q" || arg === "--quality") && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      }
    }
    if (!outPath) {
      console.error("Error: Missing required argument: -o, --out <path>");
      return 1;
    }
    if (format === "jpeg" || format === "jpg") {
      await renderPreview({ rawPath, outPath, maxPx: size, quality: quality ?? 85 });
    } else {
      await renderThumbnail({ rawPath, outPath, maxPx: size, quality: quality ?? 55 });
    }
    console.log(`✓ Thumbnail written: ${outPath}`);
    return 0;
  }
  if (command === "resize") {
    const inputPath = args[1];
    if (!inputPath || inputPath.startsWith("-")) {
      console.error('Error: "resize" requires an input image path as the first argument.');
      return 1;
    }
    let outPath = null;
    let width = 0;
    let height = 0;
    let fit = "inside";
    let format;
    let quality = 85;
    let rotate = false;
    for (let i = 2;i < args.length; i++) {
      const arg = args[i];
      if ((arg === "-o" || arg === "--out") && i + 1 < args.length) {
        outPath = args[++i];
      } else if ((arg === "-w" || arg === "--width") && i + 1 < args.length) {
        width = parseInt(args[++i], 10);
      } else if ((arg === "-h" || arg === "--height") && i + 1 < args.length) {
        height = parseInt(args[++i], 10);
      } else if (arg === "--fit" && i + 1 < args.length) {
        fit = args[++i] === "fill" ? "fill" : "inside";
      } else if ((arg === "-f" || arg === "--format") && i + 1 < args.length) {
        format = args[++i];
      } else if ((arg === "-q" || arg === "--quality") && i + 1 < args.length) {
        quality = parseInt(args[++i], 10);
      } else if (arg === "--rotate") {
        rotate = true;
      }
    }
    if (!outPath) {
      console.error("Error: Missing required argument: -o, --out <path>");
      return 1;
    }
    const start = Date.now();
    const builder = maple(inputPath).resize({ width, height, fit }).quality(quality);
    if (format) {
      builder.toFormat(format);
    }
    if (rotate) {
      builder.rotate();
    }
    const res = await builder.toFile(outPath);
    if (!res.ok) {
      console.error(`Resize failed: ${res.error}`);
      return 1;
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    const stat2 = await fs5.stat(outPath);
    console.log(`✓ Resized: ${outPath} (${(stat2.size / 1024).toFixed(1)} KB in ${elapsed}s)`);
    return 0;
  }
  if (command === "inspect") {
    const inputPath = args[1];
    if (!inputPath || inputPath.startsWith("-")) {
      console.error('Error: "inspect" requires an image path as the first argument.');
      return 1;
    }
    const isJson = args.includes("--json");
    try {
      const meta = await maple(inputPath).metadata();
      if (isJson) {
        console.log(JSON.stringify(meta, null, 2));
      } else {
        console.log(`
Maple Image Inspection: ${inputPath}`);
        console.log(`  Dimensions:  ${meta.width} × ${meta.height} px`);
        console.log(`  Format:      ${meta.format.toUpperCase()}`);
        console.log(`  Channels:    ${meta.channels}`);
        console.log(`  Orientation: ${meta.orientation}`);
        console.log(`  Is RAW:      ${meta.isRaw ? "Yes" : "No"}
`);
      }
      return 0;
    } catch (e) {
      console.error(`Error inspecting ${inputPath}: ${e?.message || String(e)}`);
      return 1;
    }
  }
  console.error(`Unknown command: "${command}". Run "npx maple help" for usage.`);
  return 1;
}
export {
  validateFilename,
  runCli,
  resolvePlatformPackageLib,
  renderThumbnail,
  renderPreview,
  renderFilenameTemplate,
  nativeLibFilename,
  maple,
  loadNativeBinding,
  isRawPath,
  isNativeAvailable,
  isMusl,
  getPlatformPackageName,
  getPlatformBinaryFilename,
  findNativeLib,
  exportRecipe,
  exportImage,
  MapleImageBuilder
};
