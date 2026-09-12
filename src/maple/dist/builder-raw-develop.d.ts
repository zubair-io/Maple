/**
 * Free functions for the private RAW-develop-only terminal path behind
 * `MapleImageBuilder.toBuffer`/`toFile` — split out of `builder.ts` to make
 * room for the five filter op methods `builder-filter.ts` adds (mirrors the
 * existing `builder-state.ts`/`builder-exec.ts` split; #3504 task E5).
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
/** Saved-recipe or XMP-driven RAW development, written straight to `outputPath`. */
export declare function rawDevelopToFile(state: BuilderState, outputPath: string): Promise<ExportResult>;
