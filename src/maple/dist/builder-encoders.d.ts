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
 * that function's doc in `builder-validate.ts` for the full cross-checked list
 * per format (#3506 F5/F6). The three formats with numeric options then run
 * `checkOptionRanges`, which throws in sharp's own wording for a value
 * outside sharp's range. Values these encoders CAN accept but reject for
 * a particular setting (e.g. an unsupported `chromaSubsampling` string, or
 * WebP `lossless: false`) are validated raw-core side instead, where the
 * error already names the offending value — not duplicated here.
 */
import type { BuilderState } from './builder-state';
import type { AvifOutputOptions, JpegOutputOptions, PngOutputOptions, TiffOutputOptions, WebpOutputOptions } from './types';
/** Encode as JPEG with sharp's options. */
export declare function setJpegOutput(state: BuilderState, options?: JpegOutputOptions): void;
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
export declare function setPngOutput(state: BuilderState, options?: PngOutputOptions): void;
/** Encode as lossless WebP. `{ lossless: false }` throws — see the README. */
export declare function setWebpOutput(state: BuilderState, options?: WebpOutputOptions): void;
/** Encode as AVIF with sharp's options. */
export declare function setAvifOutput(state: BuilderState, options?: AvifOutputOptions): void;
/** Encode as TIFF with sharp's options. */
export declare function setTiffOutput(state: BuilderState, options?: TiffOutputOptions): void;
