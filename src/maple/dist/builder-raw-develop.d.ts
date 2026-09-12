/**
 * RAW-develop terminal path for `MapleImageBuilder` — a recipe- or
 * XMP-driven development of an actual RAW file, as opposed to the bitmap
 * recipe pipeline in `builder-exec.ts`. Split out of `builder.ts` to make
 * room for Tier 2's colour ops (#3503) inside the file-size budget.
 */
import type { BuilderState } from './builder-state';
import type { ExportResult } from './types';
/**
 * True when this builder describes a RAW develop rather than a bitmap
 * transform: a recipe, an XMP sidecar, or a RAW file path as input.
 */
export declare function isRawDevelop(state: BuilderState): boolean;
/** Saved-recipe or XMP-driven RAW development, rendered to a tmp file and read back. */
export declare function rawDevelopToBuffer(state: BuilderState, toFile: (outputPath: string) => Promise<ExportResult>): Promise<Buffer>;
/** Saved-recipe or XMP-driven RAW development, written straight to `outputPath`. */
export declare function rawDevelopToFile(state: BuilderState, outputPath: string): Promise<ExportResult>;
