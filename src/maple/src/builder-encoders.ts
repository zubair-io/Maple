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
  rejectUnsupported('jpeg', (options ?? {}) as Record<string, unknown>);
  state.format = 'jpeg';
  state.output = {
    format: 'jpeg',
    quality: options?.quality ?? 80,
    progressive: options?.progressive ?? false,
    chromaSubsampling: options?.chromaSubsampling ?? '4:2:0',
    optimiseCoding: options?.optimiseCoding ?? options?.optimizeCoding ?? true,
  };
}

/** Encode as PNG with sharp's options. */
export function setPngOutput(state: BuilderState, options?: PngOutputOptions): void {
  rejectUnsupported('png', (options ?? {}) as Record<string, unknown>);
  state.format = 'png';
  state.output = {
    format: 'png',
    compressionLevel: options?.compressionLevel ?? 6,
    adaptiveFiltering: options?.adaptiveFiltering ?? false,
    palette: options?.palette ?? false,
    colours: options?.colours ?? options?.colors ?? 256,
    dither: options?.dither ?? 1.0,
  };
}

/** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
export function setWebpOutput(state: BuilderState, options?: WebpOutputOptions): void {
  rejectUnsupported('webp', (options ?? {}) as Record<string, unknown>);
  state.format = 'webp';
  state.output = { format: 'webp', lossless: options?.lossless ?? true };
}

/** Encode as AVIF with sharp's options. */
export function setAvifOutput(state: BuilderState, options?: AvifOutputOptions): void {
  rejectUnsupported('avif', (options ?? {}) as Record<string, unknown>);
  state.format = 'avif';
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
  rejectUnsupported('tiff', (options ?? {}) as Record<string, unknown>);
  state.format = 'tiff';
  state.output = {
    format: 'tiff',
    compression: options?.compression ?? 'lzw',
    bitdepth: options?.bitdepth ?? 8,
    predictor: options?.predictor ?? 'horizontal',
  };
}
