/**
 * Per-format encoder sugar for `MapleImageBuilder` — `jpeg()`, `png()`,
 * `webp()`, `avif()`, `tiff()` (#3506). Split out of `builder.ts` for the
 * file-size budget, same lane split as `builder-colour.ts`'s colour ops:
 * each function here mutates the builder state's `format`/`output` fields
 * and `builder.ts`'s methods are thin wrappers that call these and `return
 * this`.
 *
 * Every function first runs `rejectUnsupported`, which throws synchronously
 * (before the value ever reaches `state.output`, let alone the wire) for a
 * real sharp option this format's pure-Rust encoder cannot honour — see
 * that function's doc in `builder-state.ts` for the full cross-checked list
 * per format (#3506 F5/F6). Values these encoders CAN accept but reject for
 * a particular setting (e.g. an unsupported `chromaSubsampling` string, or
 * WebP `lossless: false`) are validated raw-core side instead, where the
 * error already names the offending value — not duplicated here.
 */

import { rejectUnsupported } from './builder-state';
import type { BuilderState } from './builder-state';
import type {
  AvifOutputOptions,
  JpegOutputOptions,
  PngOutputOptions,
  TiffOutputOptions,
  WebpOutputOptions,
} from './types';

/** Encode as JPEG with sharp's options. */
export function setJpegOutput(state: BuilderState, options?: JpegOutputOptions): void {
  const passed = (options ?? {}) as Record<string, unknown>;
  rejectUnsupported('jpeg', passed);
  state.format = 'jpeg';
  state.outputOptions = passed;
  // Also the RAW-develop field: `exportImage` reads `state.quality`, never
  // `state.output`, so a `.jpeg({ quality })` on a RAW input would otherwise
  // export at the builder's own 92 default.
  state.quality = options?.quality ?? 80;
  state.output = {
    format: 'jpeg',
    quality: options?.quality ?? 80,
    progressive: options?.progressive ?? false,
    chromaSubsampling: options?.chromaSubsampling ?? '4:2:0',
    optimiseCoding: options?.optimiseCoding ?? options?.optimizeCoding ?? true,
  };
}

/**
 * Encode as PNG with sharp's options.
 *
 * `colours`/`colors`/`dither` imply `palette: true`, exactly as sharp's own
 * `png()` does (`lib/output.js`: `else if ([quality, effort, colours, colors,
 * dither].some(is.defined)) this._setBooleanOption('pngPalette', true)`).
 * Maple's encoder only reaches the quantiser when `palette` is set, so
 * without the implication `png({ colours: 4 })` wrote a plain 24-bit RGB PNG
 * with no `PLTE` chunk at all while sharp wrote an indexed one. An explicit
 * `palette` always wins, in either direction.
 */
export function setPngOutput(state: BuilderState, options?: PngOutputOptions): void {
  const passed = (options ?? {}) as Record<string, unknown>;
  rejectUnsupported('png', passed);
  const impliesPalette = [options?.colours, options?.colors, options?.dither].some(
    (value) => value !== undefined,
  );
  state.format = 'png';
  state.outputOptions = passed;
  state.output = {
    format: 'png',
    compressionLevel: options?.compressionLevel ?? 6,
    adaptiveFiltering: options?.adaptiveFiltering ?? false,
    palette: options?.palette ?? impliesPalette,
    colours: options?.colours ?? options?.colors ?? 256,
    dither: options?.dither ?? 1.0,
  };
}

/** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
export function setWebpOutput(state: BuilderState, options?: WebpOutputOptions): void {
  const passed = (options ?? {}) as Record<string, unknown>;
  rejectUnsupported('webp', passed);
  state.format = 'webp';
  state.outputOptions = passed;
  state.output = { format: 'webp', lossless: options?.lossless ?? true };
}

/** Encode as AVIF with sharp's options. */
export function setAvifOutput(state: BuilderState, options?: AvifOutputOptions): void {
  const passed = (options ?? {}) as Record<string, unknown>;
  rejectUnsupported('avif', passed);
  state.format = 'avif';
  state.outputOptions = passed;
  // See `setJpegOutput`: `state.quality`/`state.effort` are what the
  // RAW-develop export and `stateToOutput`'s fallback read.
  state.quality = options?.quality ?? 50;
  state.effort = options?.effort ?? 4;
  state.output = {
    format: 'avif',
    quality: options?.quality ?? 50,
    effort: options?.effort ?? 4,
    lossless: options?.lossless ?? false,
    chromaSubsampling: options?.chromaSubsampling ?? '4:4:4',
    bitdepth: options?.bitdepth ?? 8,
  };
}

/** Encode as TIFF with sharp's options. */
export function setTiffOutput(state: BuilderState, options?: TiffOutputOptions): void {
  const passed = (options ?? {}) as Record<string, unknown>;
  rejectUnsupported('tiff', passed);
  state.format = 'tiff';
  state.outputOptions = passed;
  state.output = {
    format: 'tiff',
    compression: options?.compression ?? 'lzw',
    bitdepth: options?.bitdepth ?? 8,
    predictor: options?.predictor ?? 'horizontal',
  };
}
