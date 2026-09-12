/**
 * Every rejection a per-format encoder method can raise, in one place:
 * options Maple's pure-Rust encoders do not implement, numeric options
 * outside sharp's ranges, and options the RAW-develop export cannot carry.
 *
 * Split out of `builder-state.ts` for the file-size budget as this fix wave
 * added the range checks and the RAW-develop guard; that file is back to
 * describing the builder's state and the wire recipe it assembles, and this
 * one to what a caller is allowed to pass. `builder-encoders.ts` calls the
 * first two at option-set time and `builder.ts` the third at the terminal.
 */
import type { BuilderState } from './builder-state';
/** Throw if the caller passed an option this encoder cannot honour. */
export declare function rejectUnsupported(format: string, options: Record<string, unknown>): void;
/**
 * Range-check one numeric encoder option, throwing in sharp's own wording.
 *
 * sharp's `is.invalidParameterError` produces "Expected integer between 1 and
 * 100 for quality but received 500 of type number", and a caller migrating
 * off sharp should see the message they already know rather than Maple's
 * serde error naming a JSON column. `undefined` passes (the option is simply
 * absent); a non-integer fails, as it does in sharp.
 *
 * Exported so `builder-state.ts`'s `applyQuality`/`applyEffort` — which back
 * `.quality()`, `.toFormat(fmt, { quality, effort })` and the `options.quality`
 * branch of `.toFormat()` — throw the same message rather than the silent
 * `Math.max`/`Math.min` clamp those two used before this fix.
 */
export declare function checkIntegerRange(name: string, value: number | undefined, lo: number, hi: number): void;
/**
 * Every numeric option each per-format encoder accepts, range-checked at call
 * time. Ranges are sharp's, option for option (`lib/output.js`): JPEG/AVIF
 * `quality` 1-100, PNG `compressionLevel` 0-9, PNG `colours`/`colors` 2-256,
 * AVIF `effort` 0-9. WebP and TIFF have no numeric option left once
 * `rejectUnsupported` has run, so they never call this. Before this, out-of-range values were variously clamped
 * (`quality: 0` encoded at 1), silently ignored (`compressionLevel: 42`
 * behaved as 6, `colours: 999` did nothing) or reported by wire position
 * rather than by name (`quality: 500`).
 *
 * `dither`, `bitdepth` and the string-typed fields are validated raw-core
 * side, where the error already names both the field and the value.
 */
export declare function checkOptionRanges(format: string, options: Record<string, unknown>): void;
/**
 * Throw if a per-format encoder option cannot survive the RAW-develop export.
 *
 * That path goes through `exportImage`, whose surface is
 * `format`/`quality`/`colorSpace`/`maxLongEdge` — it never sees the wire
 * recipe `state.output` describes. Everything else a per-format method
 * accepts (`progressive`, `chromaSubsampling`, `palette`, `compression`,
 * `effort`, …) was therefore silently dropped on a RAW input; naming it is
 * the only honest option until #3579 routes RAW develops through the same
 * recipe the bitmap path already uses.
 *
 * Reads `outputOptions` (what the caller passed), not `output` (that merged
 * over every default), so an unset `progressive` never trips it.
 */
export declare function assertRawDevelopOutput(state: BuilderState): void;
