/**
 * Free functions for the private RAW-develop-only terminal path behind
 * `MapleImageBuilder.toBuffer`/`toFile` — a recipe- or XMP-driven
 * development of an actual RAW file, as opposed to the bitmap recipe
 * pipeline in `builder-exec.ts`. Split out of `builder.ts` to make room for
 * Tier 2's geometry methods (#3501), colour ops (#3503) and the five filter
 * op methods `builder-filter.ts` adds (#3504 task E5) inside the file-size
 * budget — mirrors the existing `builder-state.ts`/`builder-exec.ts` split.
 */
import { type BuilderState } from './builder-state';
import type { ExportResult } from './types';
/**
 * True when `state` describes a RAW develop rather than a bitmap transform:
 * a recipe, an XMP sidecar, or a RAW file path as input.
 */
export declare function isRawDevelop(state: BuilderState): boolean;
/**
 * Saved-recipe or XMP-driven RAW development, rendered to a tmp file and
 * read back. `toFile` is the builder's own public terminal, passed in
 * rather than imported (which would make this file import back from
 * `builder.ts`, a cycle) — it re-runs `isRawDevelop` itself and branches
 * accordingly, same as any other caller of `toFile`.
 */
export declare function rawDevelopToBuffer(state: BuilderState, toFile: (outputPath: string) => Promise<ExportResult>): Promise<Buffer>;
/**
 * Saved-recipe or XMP-driven RAW development, written straight to
 * `outputPath`. Wrapped in its own try/catch — unlike `exportImage`'s
 * bitmap-path counterpart in `builder.ts`, this runs before that function's
 * try/catch even starts, so without one of its own a rejection (an FFI
 * throw, or `fs.mkdir` failing on a read-only or nonexistent parent) would
 * reject `toFile`'s promise instead of resolving it to `{ ok: false, error
 * }` like every other `toFile` failure.
 */
export declare function rawDevelopToFile(state: BuilderState, outputPath: string): Promise<ExportResult>;
