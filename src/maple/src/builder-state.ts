/**
 * Mutable state behind `MapleImageBuilder`, split out of `builder.ts` so that
 * file stays inside the repo's file-size budget as Tier 2 adds op methods
 * (#3505). The builder owns one `BuilderState`; every fluent method mutates
 * it and returns `this`, and the terminals in `builder-exec.ts` read it.
 */

import * as path from 'node:path';
import { checkIntegerRange } from './builder-validate';
import { AuxBlob, type Recipe, type RecipeMetadata, type RecipeOp } from './recipe';
import type { Colour, ExportColorSpace, ExportFormat, ExportRecipe, RawPixelInput } from './types';

const RAW_EXTENSIONS = new Set([
  '.dng',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.arw',
  '.srf',
  '.sr2',
  '.pef',
  '.ptx',
  '.raf',
  '.rw2',
  '.orf',
  '.srw',
  '.erf',
  '.kdc',
  '.mos',
  '.mrw',
  '.3fr',
  '.fff',
]);

export function isRawPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

/** sharp's `position` spellings collapsed onto the nine wire gravity names. */
const POSITION_TO_GRAVITY: Record<string, string> = {
  top: 'north',
  'right top': 'northeast',
  right: 'east',
  'right bottom': 'southeast',
  bottom: 'south',
  'left bottom': 'southwest',
  left: 'west',
  'left top': 'northwest',
  center: 'centre',
};

/** Translate a `position` or `gravity` value to its wire spelling. */
export function resolveGravity(value: string | undefined): string {
  return value === undefined ? 'centre' : (POSITION_TO_GRAVITY[value] ?? value);
}

/**
 * The `gamma(gamma, gammaOut)` op pair, held apart from `ops` because its
 * position is resolved at ASSEMBLY time (`stateToRecipe`), not at call time
 * — matching sharp's fixed pipeline stages, where gamma-in runs immediately
 * before the resize stage and gamma-out immediately after it, regardless of
 * where in the call chain `.gamma()` and `.resize()` were written relative
 * to each other. A second `.gamma()` call replaces the pair, as sharp does.
 */
export interface GammaPair {
  before: RecipeOp;
  after: RecipeOp;
}

export interface BuilderState {
  inputPath: string | null;
  inputBytes: Uint8Array | null;
  rawInput: RawPixelInput | null;
  /** Ordered recipe ops, in call order (gamma excepted — see `gammaPair`). */
  ops: RecipeOp[];
  /** Pending `gamma()` pair, inserted around `resize` by `stateToRecipe`. */
  gammaPair: GammaPair | null;
  aux: AuxBlob;
  format: ExportFormat | null;
  quality: number;
  /** sharp-style AVIF effort 0-9, or null for "never set". */
  effort: number | null;
  /**
   * The full per-format output object set by `.jpeg()`/`.png()`/`.webp()`/
   * `.avif()`/`.tiff()`, or null when the caller only ever used
   * `.toFormat()`/`.quality()`/`.format()` — see `stateToOutput`.
   */
  output: Record<string, unknown> | null;
  /**
   * The option object the caller actually passed to that per-format method,
   * as opposed to `output`, which is that object merged over every default.
   * Kept so `assertRawDevelopOutput` can tell "the caller asked for
   * progressive scans" from "progressive defaulted to false" — only the
   * former is worth refusing on a RAW-develop input.
   */
  outputOptions: Record<string, unknown> | null;
  autoOrient: boolean;
  /** `keepMetadata`/`withMetadata`/`withExif`/`withIccProfile`/`withXmp` state. */
  metadata: RecipeMetadata;
  /**
   * Names of the metadata methods called so far, in call order, deduped
   * (#3507 fix-round-1, item 1) — `[]` means none were called. Used only to
   * name the method in the "not supported when developing a RAW file yet"
   * error; not part of the wire `Recipe` (`stateToRecipe` never emits it).
   */
  metadataCallsUsed: string[];
  // RAW-develop fields, unchanged from Tier 1.
  xmpPath: string | null;
  xmpXml: string | null;
  colorSpace: ExportColorSpace;
  maxLongEdge: number;
  filmPath: string | null;
  exportRecipe: ExportRecipe | string | null;
}

export function createBuilderState(
  input: string | Uint8Array | Buffer | RawPixelInput,
): BuilderState {
  const base: Omit<BuilderState, 'inputPath' | 'inputBytes' | 'rawInput'> = {
    ops: [],
    gammaPair: null,
    aux: new AuxBlob(),
    format: null,
    quality: 92,
    effort: null,
    output: null,
    outputOptions: null,
    autoOrient: false,
    metadata: { keep: false },
    metadataCallsUsed: [],
    xmpPath: null,
    xmpXml: null,
    colorSpace: 'srgb',
    maxLongEdge: 0,
    filmPath: null,
    exportRecipe: null,
  };
  if (typeof input === 'string') {
    return { ...base, inputPath: input, inputBytes: null, rawInput: null };
  }
  if ('data' in input && 'width' in input) {
    return { ...base, inputPath: null, inputBytes: null, rawInput: input };
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Rejected here, up front, exactly as sharp rejects it — and with
  // sharp's own message. Every FFI wrapper downstream passes the buffer to
  // `bun:ffi`'s `ptr()`, which cannot take a zero-length one and leaks
  // `TypeError: bun:ffi cannot convert argument to 'ptr'` from whichever
  // call happened to reach it first (#3507 final fix wave, item 9 —
  // measured on `metadata()`, `stats()`, `png().toBuffer()` and
  // `resize().jpeg().toBuffer()` alike). No empty buffer can succeed on
  // any path, so there is nothing to defer.
  if (bytes.byteLength === 0) {
    throw new Error('Input Buffer is empty');
  }
  return { ...base, inputPath: null, inputBytes: bytes, rawInput: null };
}

/**
 * Splice a pending `gamma()` pair into `ops` at its ASSEMBLY-time position:
 * immediately around the first `resize` op, or at the very end when there
 * is no resize. Building this fresh on every call (rather than mutating
 * `ops` when `.gamma()` is called) is what makes the pair land correctly
 * regardless of whether `.gamma()` was chained before or after `.resize()`.
 */
function insertGammaPair(ops: readonly RecipeOp[], pair: GammaPair | null): RecipeOp[] {
  if (!pair) {
    return [...ops];
  }
  const resizeAt = ops.findIndex((op) => op.op === 'resize');
  if (resizeAt < 0) {
    return [...ops, pair.before, pair.after];
  }
  return [
    ...ops.slice(0, resizeAt),
    pair.before,
    ops[resizeAt],
    pair.after,
    ...ops.slice(resizeAt + 1),
  ];
}

/** Assemble the wire recipe for one terminal call. */
export function stateToRecipe(state: BuilderState, output: Record<string, unknown>): Recipe {
  const input = state.rawInput
    ? ({
        kind: 'raw',
        width: state.rawInput.width,
        height: state.rawInput.height,
        channels: state.rawInput.channels,
      } as const)
    : ({ kind: 'encoded' } as const);
  const withAutoOrient = state.autoOrient ? [{ op: 'autoOrient' }, ...state.ops] : state.ops;
  const ops = insertGammaPair(withAutoOrient, state.gammaPair);
  return { v: 1, input, ops, output, metadata: state.metadata };
}

/**
 * Output object for the current output selection: the full per-format
 * object set by `.jpeg()`/`.png()`/`.webp()`/`.avif()`/`.tiff()` when one
 * was called, otherwise the Tier 1 `.toFormat()`/`.quality()`/`.format()`
 * fallback (format plus quality/effort where those apply).
 */
export function stateToOutput(
  state: BuilderState,
  fallback: ExportFormat,
): Record<string, unknown> {
  if (state.output) {
    return state.output;
  }
  const format = state.format ?? fallback;
  if (format === 'avif') {
    return { format, quality: state.quality, effort: state.effort ?? 4 };
  }
  if (format === 'jpeg') {
    return { format, quality: state.quality };
  }
  return { format };
}

/**
 * Output containers whose wire object carries a `quality` field, and so can
 * take a later `.quality()` / `.toFormat(f, { quality })`. PNG, WebP and TIFF
 * have no quality knob in Maple's encoders at all (`png({ quality })` and
 * `webp({ quality })` are named rejections, and TIFF's is the JPEG-in-TIFF
 * knob Maple has no encoder for), so there is nothing to write there.
 */
const QUALITY_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'avif']);
/** Output containers whose wire object carries an `effort` field. */
const EFFORT_FORMATS: ReadonlySet<string> = new Set(['avif']);

/**
 * Apply a `quality` to both the RAW-develop field and, when a per-format
 * method already set one, the wire output object.
 *
 * `stateToOutput` returns `state.output` verbatim whenever it is set, so
 * writing only `state.quality` would leave `.jpeg().quality(30)` silently
 * encoding at the `.jpeg()` default — measured before this fix at 1436 B,
 * byte-identical to a plain `.jpeg()`, against 716 B for
 * `.jpeg({ quality: 30 })`.
 *
 * Out of range throws in sharp's own wording (`checkIntegerRange`) rather
 * than silently clamping — `.quality(0)` used to encode at 1 and
 * `.quality(500)` at 100, both without a word to the caller.
 */
export function applyQuality(state: BuilderState, quality: number): void {
  checkIntegerRange('quality', quality, 1, 100);
  state.quality = quality;
  const output = state.output;
  if (output && QUALITY_FORMATS.has(String(output.format))) {
    output.quality = quality;
  }
}

/**
 * `applyQuality`'s counterpart for AVIF's `effort` (0 fastest … 9 slowest).
 * Out of range throws rather than clamping — see `applyQuality`.
 */
export function applyEffort(state: BuilderState, effort: number): void {
  checkIntegerRange('effort', effort, 0, 9);
  state.effort = effort;
  const output = state.output;
  if (output && EFFORT_FORMATS.has(String(output.format))) {
    output.effort = effort;
  }
}

/**
 * Select the output container for `.format()` / `.toFormat()`.
 *
 * Naming a *different* container than the one a per-format method already
 * configured discards that method's options: `stateToOutput` prefers
 * `state.output` over `state.format`, so keeping a stale `.jpeg()` output
 * around would make `.jpeg({ progressive: true }).toFormat('png')` hand back
 * a JPEG — the caller's last instruction silently ignored. Naming the same
 * container keeps the options, so `.jpeg({ progressive: true })
 * .toFormat('jpeg', { quality: 30 })` still writes progressive scans.
 */
export function applyFormat(state: BuilderState, format: ExportFormat): void {
  state.format = format;
  if (state.output && state.output.format !== format) {
    state.output = null;
    state.outputOptions = null;
  }
}

const FORMAT_BY_EXT: Record<string, ExportFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tif: 'tiff',
  tiff: 'tiff',
};

/** Infer the output container from a path extension, defaulting to JPEG. */
export function formatForPath(outputPath: string): ExportFormat {
  return FORMAT_BY_EXT[path.extname(outputPath).slice(1).toLowerCase()] ?? 'jpeg';
}

/**
 * Width of the most recently pushed `resize` op, or 0 if none. Tier 1 kept a
 * dedicated `_resizeWidth` field that doubled as a fallback for
 * `maxLongEdge` (RAW develop) and tensor `targetSize` (`toRawRgb`) when the
 * caller chained `.resize()` but didn't set those explicitly; resize state
 * now lives in `ops`, so this scan preserves that same fallback.
 */
export function lastResizeWidth(state: BuilderState): number {
  for (let i = state.ops.length - 1; i >= 0; i--) {
    const op = state.ops[i];
    if (op.op === 'resize' && typeof op.width === 'number') {
      return op.width;
    }
  }
  return 0;
}

/** `{ r, g, b, alpha }` or a `#rrggbb[aa]` string → the wire `[r,g,b,a]`. */
export function resolveColour(
  value: Colour | string | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    const a = value.alpha === undefined ? 255 : Math.round(value.alpha * 255);
    return [value.r, value.g, value.b, a];
  }
  const hex = value.replace(/^#/, '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  // Length alone is not enough: `'orange'` is 6 characters, `parseInt('or',
  // 16)` is NaN, and the NaN reached the wire as a null and surfaced as
  // `recipe parse failed: invalid type: null, expected f64` (#3503 review
  // I6). sharp parses CSS colour names and `rgb()` here; Maple does not, and
  // says so by name. The leading `#` is optional.
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
    throw new Error(`Unrecognised colour '${value}': expected #rgb, #rrggbb or #rrggbbaa`);
  }
  const byte = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return [byte(0), byte(1), byte(2), full.length === 8 ? byte(3) : 255];
}
