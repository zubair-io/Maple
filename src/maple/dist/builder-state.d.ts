/**
 * Mutable state behind `MapleImageBuilder`, split out of `builder.ts` so that
 * file stays inside the repo's file-size budget as Tier 2 adds op methods
 * (#3505). The builder owns one `BuilderState`; every fluent method mutates
 * it and returns `this`, and the terminals in `builder-exec.ts` read it.
 */
import { AuxBlob, type Recipe, type RecipeOp } from './recipe';
import type { Colour, ExportColorSpace, ExportFormat, ExportRecipe, RawPixelInput } from './types';
export declare function isRawPath(filePath: string): boolean;
/** Translate a `position` or `gravity` value to its wire spelling. */
export declare function resolveGravity(value: string | undefined): string;
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
/**
 * Output object for the current output selection: the full per-format
 * object set by `.jpeg()`/`.png()`/`.webp()`/`.avif()`/`.tiff()` when one
 * was called, otherwise the Tier 1 `.toFormat()`/`.quality()`/`.format()`
 * fallback (format plus quality/effort where those apply).
 */
export declare function stateToOutput(state: BuilderState, fallback: ExportFormat): Record<string, unknown>;
/**
 * Apply a `quality` to both the RAW-develop field and, when a per-format
 * method already set one, the wire output object.
 *
 * `stateToOutput` returns `state.output` verbatim whenever it is set, so
 * writing only `state.quality` would leave `.jpeg().quality(30)` silently
 * encoding at the `.jpeg()` default — measured before this fix at 1436 B,
 * byte-identical to a plain `.jpeg()`, against 716 B for
 * `.jpeg({ quality: 30 })`.
 */
export declare function applyQuality(state: BuilderState, quality: number): void;
/** `applyQuality`'s counterpart for AVIF's `effort` (0 fastest … 9 slowest). */
export declare function applyEffort(state: BuilderState, effort: number): void;
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
export declare function applyFormat(state: BuilderState, format: ExportFormat): void;
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
