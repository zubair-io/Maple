/**
 * Mutable state behind `MapleImageBuilder`, split out of `builder.ts` so that
 * file stays inside the repo's file-size budget as Tier 2 adds op methods
 * (#3505). The builder owns one `BuilderState`; every fluent method mutates
 * it and returns `this`, and the terminals in `builder-exec.ts` read it.
 */

import * as path from 'node:path';
import { AuxBlob, type Recipe, type RecipeOp } from './recipe';
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

export interface BuilderState {
  inputPath: string | null;
  inputBytes: Uint8Array | null;
  rawInput: RawPixelInput | null;
  /** Ordered recipe ops, in call order. */
  ops: RecipeOp[];
  aux: AuxBlob;
  format: ExportFormat | null;
  quality: number;
  /** sharp-style AVIF effort 0-9, or null for "never set". */
  effort: number | null;
  autoOrient: boolean;
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
    aux: new AuxBlob(),
    format: null,
    quality: 92,
    effort: null,
    autoOrient: false,
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
  return { ...base, inputPath: null, inputBytes: bytes, rawInput: null };
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
  const ops = state.autoOrient ? [{ op: 'autoOrient' }, ...state.ops] : state.ops;
  return { v: 1, input, ops, output };
}

/** Output object for the current format/quality/effort selection. */
export function stateToOutput(
  state: BuilderState,
  fallback: ExportFormat,
): Record<string, unknown> {
  const format = state.format ?? fallback;
  if (format === 'avif') {
    return { format, quality: state.quality, effort: state.effort ?? 4 };
  }
  if (format === 'jpeg') {
    return { format, quality: state.quality };
  }
  return { format };
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
  if (full.length !== 6 && full.length !== 8) {
    throw new Error(`Unrecognised colour '${value}': expected #rgb, #rrggbb or #rrggbbaa`);
  }
  const byte = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return [byte(0), byte(1), byte(2), full.length === 8 ? byte(3) : 255];
}
