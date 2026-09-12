/**
 * Mutable state behind `MapleImageBuilder`, split out of `builder.ts` so that
 * file stays inside the repo's file-size budget as Tier 2 adds op methods
 * (#3505). The builder owns one `BuilderState`; every fluent method mutates
 * it and returns `this`, and the terminals in `builder-exec.ts` read it.
 */
import { AuxBlob, type Recipe, type RecipeOp } from './recipe';
import type { Colour, ExportColorSpace, ExportFormat, ExportRecipe, RawPixelInput } from './types';
export declare function isRawPath(filePath: string): boolean;
/** `ResizeOptions.filter` → the recipe's `resize` op `kernel` wire value. */
export declare function kernelFromFilter(filter?: 'lanczos3' | 'bilinear' | 'nearest'): string;
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
    autoOrient: boolean;
    xmpPath: string | null;
    xmpXml: string | null;
    colorSpace: ExportColorSpace;
    maxLongEdge: number;
    filmPath: string | null;
    exportRecipe: ExportRecipe | string | null;
}
export declare function createBuilderState(input: string | Uint8Array | Buffer | RawPixelInput): BuilderState;
/** Assemble the wire recipe for one terminal call. */
export declare function stateToRecipe(state: BuilderState, output: Record<string, unknown>): Recipe;
/** Output object for the current format/quality/effort selection. */
export declare function stateToOutput(state: BuilderState, fallback: ExportFormat): Record<string, unknown>;
/** Infer the output container from a path extension, defaulting to JPEG. */
export declare function formatForPath(outputPath: string): ExportFormat;
/**
 * Width of the most recently pushed `resize` op, or 0 if none. Tier 1 kept a
 * dedicated `_resizeWidth` field that doubled as a fallback for
 * `maxLongEdge` (RAW develop) and tensor `targetSize` (`toRawRgb`) when the
 * caller chained `.resize()` but didn't set those explicitly; resize state
 * now lives in `ops`, so this scan preserves that same fallback.
 */
export declare function lastResizeWidth(state: BuilderState): number;
/** `{ r, g, b, alpha }` or a `#rrggbb[aa]` string → the wire `[r,g,b,a]`. */
export declare function resolveColour(value: Colour | string | undefined, fallback: [number, number, number, number]): [number, number, number, number];
