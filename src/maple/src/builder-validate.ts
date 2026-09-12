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

/**
 * sharp options Maple's pure-Rust encoders do not implement, rejected by
 * name at call time rather than silently ignored (#3506 F5, extended F6).
 *
 * Cross-checked against sharp 0.34.5's `lib/output.js` (`jpeg()`, `png()`,
 * `webp()`, `avif()`→`heif()`, `tiff()`) option by option:
 *
 * - `force` is a real option on every one of those methods ("force this
 *   container, otherwise attempt to keep the input format"); Maple always
 *   forces the container the caller named by calling `.jpeg()`/etc, so
 *   `force: false` (asking to fall back to the input format) has no
 *   equivalent and must not be silently accepted as a no-op.
 * - JPEG: sharp accepts BOTH the British and American spelling of
 *   `trellisQuantisation`/`trellisQuantization` as synonyms; F5 only ever
 *   named the British one.
 * - PNG: `quality`/`effort` drive sharp's palette-quantisation step (they
 *   only take effect once `palette` is implied); Maple's PNG encoder has no
 *   quantiser at all, so both are real, silently-droppable options.
 * - WebP: `quality` (lossy quality, irrelevant to Maple's lossless-only
 *   encoder) and the animation-only knobs (`smartDeblock`, `loop`, `delay`,
 *   `minSize`, `mixed`) — Maple's WebP encoder never handles animated input.
 * - AVIF: `tune` is not a sharp option at all (dropped, F6) — `avif()`
 *   delegates to `heif({ ...options, compression: 'av1' })`, whose
 *   documented surface is `quality`/`lossless`/`effort`/`chromaSubsampling`/
 *   `bitdepth` only, and every one of those five is honoured. `bitdepth` is
 *   NOT in this list: `ravif` exposes 8- and 10-bit output, so `8`/`10` are
 *   real and only sharp's third value, `12`, is rejected — by name, from
 *   `encode_avif_opts`, where the error can quote the value.
 * - TIFF: `quality` (sharp's JPEG-in-TIFF quality knob — moot without a
 *   JPEG-in-TIFF encoder, see the README parity note), `tileWidth`/
 *   `tileHeight` (meaningless without `tile`, already rejected), and
 *   `resolutionUnit` (no xres/yres to apply it to, also already rejected).
 */
const UNSUPPORTED: Record<string, string[]> = {
  jpeg: [
    'mozjpeg',
    'trellisQuantisation',
    'trellisQuantization',
    'overshootDeringing',
    'optimiseScans',
    'optimizeScans',
    'quantisationTable',
    'quantizationTable',
    'force',
  ],
  png: ['progressive', 'quality', 'effort', 'force'],
  webp: [
    'alphaQuality',
    'nearLossless',
    'smartSubsample',
    'smartDeblock',
    'preset',
    'effort',
    'quality',
    'loop',
    'delay',
    'minSize',
    'mixed',
    'force',
  ],
  avif: ['force'],
  tiff: [
    'tile',
    'pyramid',
    'bigtiff',
    'xres',
    'yres',
    'miniswhite',
    'quality',
    'tileWidth',
    'tileHeight',
    'resolutionUnit',
    'force',
  ],
};

/** Throw if the caller passed an option this encoder cannot honour. */
export function rejectUnsupported(format: string, options: Record<string, unknown>): void {
  const offender = (UNSUPPORTED[format] ?? []).find((key) => options[key] !== undefined);
  if (offender !== undefined) {
    throw new Error(
      `${format}({ ${offender} }) is not supported by Maple's pure-Rust encoder. ` +
        `See the sharp parity table in the @justmaple/maple README.`,
    );
  }
}

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
export function checkIntegerRange(
  name: string,
  value: number | undefined,
  lo: number,
  hi: number,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < lo || value > hi) {
    throw new Error(
      `Expected integer between ${lo} and ${hi} for ${name} ` +
        `but received ${value} of type ${typeof value}`,
    );
  }
}

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
export function checkOptionRanges(format: string, options: Record<string, unknown>): void {
  const num = (key: string) => options[key] as number | undefined;
  if (format === 'jpeg' || format === 'avif') {
    checkIntegerRange('quality', num('quality'), 1, 100);
  }
  if (format === 'avif') {
    checkIntegerRange('effort', num('effort'), 0, 9);
  }
  if (format === 'png') {
    checkIntegerRange('compressionLevel', num('compressionLevel'), 0, 9);
    checkIntegerRange('colours', num('colours') ?? num('colors'), 2, 256);
  }
}

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
export function assertRawDevelopOutput(state: BuilderState): void {
  const offender = Object.keys(state.outputOptions ?? {}).find((key) => key !== 'quality');
  if (offender !== undefined) {
    throw new Error(
      `${offender} is not supported on a RAW develop input yet — see #3579. ` +
        `Develop to a bitmap first, then re-encode it with the per-format options.`,
    );
  }
}
