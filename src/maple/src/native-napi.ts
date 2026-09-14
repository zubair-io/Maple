/**
 * `NativeBinding` implemented via the `raw-napi` N-API addon (#3509), when
 * one is resolvable for the current platform. Every method here is a thin
 * wrapper around one napi export — the actual off-thread execution happens
 * inside the addon itself (napi-rs's `Task`/`AsyncTask` pair, running on
 * N-API's own libuv worker pool), so no JS-level `Worker` pool is needed on
 * this path at all; `worker-pool.ts`'s pool (#3508) is the fallback for a
 * platform with no matching addon.
 *
 * Two real shape mismatches surfaced empirically while wiring this up — both
 * fixed here rather than left as "the napi path behaves slightly
 * differently":
 *
 * 1. `renderFilenameTemplate`'s `capturedAt` argument is `string | null` on
 *    the `NativeBinding` interface (`types.ts`'s `FilenameTemplateArgs`), and
 *    the `bun:ffi` backend accepts a literal `null` for "no captured date".
 *    The napi addon's `FilenameTemplateArgs` is a `#[napi(object)]` struct
 *    whose `Option<String>` field rejects a literal JS `null` outright
 *    (`Failed to convert JavaScript value 'Null' into rust type 'String'`) —
 *    confirmed empirically; only `undefined` (or the key being absent) is
 *    accepted for an `Option` field on an object argument. A plain
 *    positional `Option<String>` function parameter (`format`, `xmpPath`,
 *    `filmPath` below) does NOT have this restriction — `null` works fine
 *    there — so this conversion is needed for exactly this one field.
 *
 * 2. `renderThumbnailAvifToFile` / `renderThumbnailPreviewJpegToFile` /
 *    `renderDevelopJpegToFile`'s `quality` parameter is optional on
 *    `NativeBinding`; the `bun:ffi` backend (`native.ts`) supplies its own
 *    JS-level default (55 / 85 / 85) when a caller omits it, before the
 *    value ever reaches native code. The napi addon requires an actual
 *    number for every one of these (a missing/`undefined` argument throws
 *    `Failed to convert napi value Undefined into rust type 'u8'` — confirmed
 *    empirically), and separately treats `0` as its OWN "use my default"
 *    sentinel — but the addon's built-in default for
 *    `renderDevelopJpegToFile` is 82, not 85, so passing `0` through
 *    unchanged would silently produce a different JPEG quality than the
 *    `bun:ffi` backend does for the exact same omitted argument. Applying
 *    `native.ts`'s own defaults here, before calling the addon, keeps the
 *    two backends byte-identical for an omitted `quality`.
 */
import { resolvePlatformNapiAddon } from './platform';
import type { NativeBinding } from './native';

/** Wraps a plain function as `NativeBinding[K]`, discarding the async/sync
 *  return-type mismatch between this addon's real `Promise`-returning
 *  exports and `NativeBinding`'s (mostly historical, bun:ffi-shaped) sync
 *  return types — `callNative` always `await`s its result regardless, so
 *  awaiting a non-Promise value there is a no-op and this is safe in
 *  practice. Parameters stay fully type-checked against the real
 *  `NativeBinding` signature; only the return type is widened. */
function wrap<K extends keyof NativeBinding>(
  fn: (...args: Parameters<NativeBinding[K]>) => unknown,
): NativeBinding[K] {
  return fn as unknown as NativeBinding[K];
}

/** The addon's raw exports — every value is a plain function; some return a
 *  value directly (`renderFilenameTemplate`, `validateFilename`), the rest
 *  return a real `Promise` (napi-rs `AsyncTask`). Untyped beyond that here;
 *  each `wrap(...)` call below is where a specific call gets its real
 *  parameter/return shape back. */
type NapiExports = Record<string, (...args: unknown[]) => unknown>;

/** Loads `addonPath` and returns its exports. `process.dlopen`, not
 *  `require(addonPath)`: a locally-built dev artifact is a bare `.dylib`/
 *  `.so` (see `resolvePlatformNapiAddon`'s doc), and neither Node's nor
 *  Bun's `require()` recognizes that extension — both pick a loader by file
 *  extension and only register one for `.node`, so `require()` on a
 *  `.dylib`-suffixed path throws `Invalid or unexpected token` (confirmed
 *  empirically on both runtimes). `process.dlopen` is the same primitive
 *  their own `.node` loader calls internally; it loads correctly regardless
 *  of what the file is named, on both runtimes, and is what Node's own docs
 *  recommend over `require()` specifically for loading a native addon from
 *  an ES module — which this package is (`"type": "module"`). */
function loadNapiModule(addonPath: string): NapiExports {
  const mod = { exports: {} as NapiExports };
  process.dlopen(mod, addonPath);
  return mod.exports;
}

let cached: NativeBinding | null | undefined;

export function tryLoadNapiBinding(): NativeBinding | null {
  if (cached !== undefined) return cached;
  const addonPath = resolvePlatformNapiAddon();
  if (!addonPath) {
    cached = null;
    return null;
  }
  try {
    const addon = loadNapiModule(addonPath);
    const binding = {
      // -- filename (synchronous, no I/O) --------------------------------
      renderFilenameTemplate: wrap<'renderFilenameTemplate'>((args) =>
        addon.renderFilenameTemplate({ ...args, capturedAt: args.capturedAt ?? undefined }),
      ),
      validateFilename: wrap<'validateFilename'>((name) => addon.validateFilename(name)),

      // -- raster header probe / native-size decode ----------------------
      rasterProbeMetadata: wrap<'rasterProbeMetadata'>((inputPath) =>
        addon.rasterProbeMetadata(inputPath),
      ),
      rasterProbeMetadataBuf: wrap<'rasterProbeMetadataBuf'>((inputBytes) =>
        addon.rasterProbeMetadataBuf(inputBytes),
      ),
      rasterDecodeRgb8Buf: wrap<'rasterDecodeRgb8Buf'>((inputBytes, autoOrient) =>
        addon.rasterDecodeRgb8Buf(inputBytes, autoOrient),
      ),

      // -- v2 render entry points -----------------------------------------
      rasterRenderBuf: wrap<'rasterRenderBuf'>(
        (inputBytes, width, height, flags, filter, format, quality, effort) =>
          addon.rasterRenderBuf(inputBytes, width, height, flags, filter, format, quality, effort),
      ),
      rasterFromRawRenderBuf: wrap<'rasterFromRawRenderBuf'>(
        (
          pixels,
          srcWidth,
          srcHeight,
          channels,
          width,
          height,
          flags,
          filter,
          format,
          quality,
          effort,
        ) =>
          addon.rasterFromRawRenderBuf(
            pixels,
            srcWidth,
            srcHeight,
            channels,
            width,
            height,
            flags,
            filter,
            format,
            quality,
            effort,
          ),
      ),

      // -- Tier-1 resize / tensor ------------------------------------------
      rasterResizeToFile: wrap<'rasterResizeToFile'>(
        (inputPath, outPath, width, height, fit, format, quality) =>
          addon.rasterResizeToFile(inputPath, outPath, width, height, fit, format, quality),
      ),
      rasterResizeToBuf: wrap<'rasterResizeToBuf'>(
        (inputBytes, width, height, fit, format, quality) =>
          addon.rasterResizeToBuf(inputBytes, width, height, fit, format, quality),
      ),
      rasterExtractTensor: wrap<'rasterExtractTensor'>(
        (inputBytes, targetSize, layout, normalize) =>
          addon.rasterExtractTensor(inputBytes, targetSize, layout, normalize),
      ),

      // -- bitmap recipe executor + analyze --------------------------------
      rasterPipelineBuf: wrap<'rasterPipelineBuf'>((input, recipeJson, aux) =>
        addon.rasterPipelineBuf(input, recipeJson, aux),
      ),
      rasterAnalyzeBuf: wrap<'rasterAnalyzeBuf'>((input, requestJson) =>
        addon.rasterAnalyzeBuf(input, requestJson),
      ),

      // -- RAW-develop export -----------------------------------------------
      exportDevelopedToFile: wrap<'exportDevelopedToFile'>(
        (rawPath, xmpPath, format, quality, colorSpace, maxLongEdge, outPath) =>
          addon.exportDevelopedToFile(
            rawPath,
            xmpPath,
            format,
            quality,
            colorSpace,
            maxLongEdge,
            outPath,
          ),
      ),
      exportRecipeToFile: wrap<'exportRecipeToFile'>(
        (rawPath, xmpXml, recipeJson, filmPath, outPath) =>
          addon.exportRecipeToFile(rawPath, xmpXml, recipeJson, filmPath, outPath),
      ),

      // -- thumbnail extraction + develop preview ----------------------------
      // See the module doc's point 2: these three apply the SAME JS-level
      // default `native.ts` applies when `quality` is omitted, rather than
      // relying on the addon's own "0 means use my built-in default" —
      // `renderDevelopJpegToFile`'s addon-side default (82) differs from
      // `native.ts`'s (85).
      renderThumbnailAvifToFile: wrap<'renderThumbnailAvifToFile'>(
        (rawPath, outPath, maxPx, quality) =>
          addon.renderThumbnailAvifToFile(rawPath, outPath, maxPx, quality ?? 55),
      ),
      renderThumbnailPreviewJpegToFile: wrap<'renderThumbnailPreviewJpegToFile'>(
        (rawPath, outPath, maxPx, quality) =>
          addon.renderThumbnailPreviewJpegToFile(rawPath, outPath, maxPx, quality ?? 85),
      ),
      renderDevelopJpegToFile: wrap<'renderDevelopJpegToFile'>(
        (rawPath, xmpPath, outPath, maxPx, quality) =>
          addon.renderDevelopJpegToFile(rawPath, xmpPath, outPath, maxPx, quality ?? 85),
      ),

      // No napi counterpart: every real `NativeBinding` method already
      // returns its own `{ ok, error? }` / throws its own message, so
      // nothing in this package ever calls `callNative('lastError', ...)`
      // (confirmed by grep across `src/maple/src/` during planning) — this
      // is a harmless, honest stub for interface completeness.
      lastError: (() => null) as NativeBinding['lastError'],
    } satisfies NativeBinding;
    cached = binding;
    return binding;
  } catch {
    cached = null;
    return null;
  }
}

/** Test-only: drop the cached binding so the next call re-resolves and
 *  re-loads the addon from scratch. */
export function _resetNapiBindingForTests(): void {
  cached = undefined;
}
