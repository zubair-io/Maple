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
 * differently" — plus one deliberate, documented decision about what IS and
 * isn't part of the cross-backend contract (point 3 below):
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
 *    sentinel. Correction to an earlier version of this comment: there is
 *    NO Rust-level divergence here — `raw-ffi`'s own C ABI (`render_develop.rs`)
 *    defaults `renderDevelopJpegToFile`'s quality-0 case to 82 as well, same
 *    as `raw-napi`; nobody should ever change either Rust crate's 82 to
 *    "match" 85. The actual mismatch lives entirely at the TypeScript layer:
 *    `native.ts`'s bun:ffi wrapper applies its OWN JS-level default of 85
 *    for this one operation before the value ever reaches the C ABI, so the
 *    C ABI's built-in 82 default is never actually exercised via bun:ffi in
 *    practice. Applying `native.ts`'s own defaults here, before calling the
 *    napi addon, keeps the two backends byte-identical for an omitted
 *    `quality` — matching what bun:ffi callers actually observe, not what
 *    either native crate's own internal fallback happens to be.
 *
 * 3. A deliberate decision, not a bug: exact error-message TEXT is NOT
 *    part of the cross-backend contract `callNative` promises callers. A
 *    differential run across both backends found ~9 of 38 cases where the
 *    human-readable `error` string differs in wording (`bun:ffi`'s messages
 *    are built from a C ABI's `maple_last_error()` string and sometimes
 *    prefix a symbol/context name; napi's come straight from Rust's own
 *    `Result`/`Error` machinery) while `ok`/`code` — the fields real callers
 *    actually branch on (see `types.ts`'s `FilenameResult`/`validateFilename`
 *    return types, the only `NativeBinding` shapes with a numeric `code`) —
 *    were identical in every case. Only `ok`/`code` are the contract;
 *    `error` is a best-effort diagnostic string that may read differently
 *    depending on which backend answered, and that is expected, not a
 *    defect to chase.
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

/**
 * The real reason the most recent `tryLoadNapiBinding()` call returned
 * `null`, when it did — `undefined` while a binding is still cached/hasn't
 * been resolved yet. `callNative` reads this to build an informative error
 * for a Node caller with no working backend at all (see `worker-pool.ts`)
 * instead of silently falling through to the Bun-only worker pool and
 * crashing on a bare `Worker is not defined`. Kept as the ACTUAL caught
 * error (not swallowed in a bare `catch {}`) precisely so that message can
 * name what went wrong — a missing addon, an ABI mismatch, a corrupted
 * file, or an explicit opt-out (see `MAPLE_NAPI` below) each read
 * differently to whoever has to debug this.
 */
let lastLoadError: Error | null = null;

export function getNapiLoadError(): Error | null {
  return lastLoadError;
}

/**
 * Resolves and loads the napi addon, caching the outcome — `null` (never
 * throws) when no addon is resolvable, ABI-compatible, or loadable, or when
 * explicitly disabled via `MAPLE_NAPI=0`. That env var is the napi-side
 * counterpart to `native.ts`'s `MAPLE_NATIVE_LIB`: an escape hatch to force
 * every `callNative` dispatch onto the `bun:ffi`/worker-pool backend even
 * when a napi addon IS present and working — needed both for a real
 * napi-specific production incident (skip straight to the known-good
 * fallback without an addon-uninstall step) and for tests that need to
 * exercise the worker pool's own machinery on a machine where a napi addon
 * happens to be built (see `worker-pool.test.ts`).
 */
export function tryLoadNapiBinding(): NativeBinding | null {
  if (cached !== undefined) return cached;
  if (process.env.MAPLE_NAPI === '0') {
    lastLoadError = new Error('napi disabled via MAPLE_NAPI=0');
    cached = null;
    return null;
  }
  const addonPath = resolvePlatformNapiAddon();
  if (!addonPath) {
    lastLoadError = new Error(`no raw-napi addon found for ${process.platform}-${process.arch}`);
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
      // relying on the addon's own "0 means use my built-in default" — for
      // `renderDevelopJpegToFile` specifically, `native.ts`'s own JS-level
      // default (85) differs from what BOTH raw-ffi and raw-napi fall back
      // to internally for a literal `quality: 0` (82, matching each other) —
      // there is no Rust-level mismatch to fix, only this TS-layer one.
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
    lastLoadError = null;
    return binding;
  } catch (e) {
    // Preserve the REAL failure (a `process.dlopen` error — a missing file,
    // an ABI/architecture mismatch, a corrupted addon, ...) rather than
    // swallowing it in a bare `catch {}`. Discarding this here was the root
    // cause of a real bug: with no addon and no preserved reason why,
    // `callNative` had nothing informative to surface on plain Node and
    // fell straight through to the Bun-only worker pool, crashing on a bare
    // `Worker is not defined` instead of naming what actually went wrong.
    lastLoadError = e instanceof Error ? e : new Error(String(e));
    cached = null;
    return null;
  }
}

/** Test-only: drop the cached binding (and its remembered load error) so the
 *  next call re-resolves and re-loads the addon from scratch. */
export function _resetNapiBindingForTests(): void {
  cached = undefined;
  lastLoadError = null;
}
