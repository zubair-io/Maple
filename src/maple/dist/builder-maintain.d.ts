/**
 * The two whole-file maintenance terminals behind
 * `MapleImageBuilder.validateIntegrity` / `.normalizeOrientationInPlace`,
 * plus the bitmap half of `.toFile`.
 *
 * None of them are image operations — they are "decode it and tell me
 * whether that worked" and "rewrite this file on disk in place". They live
 * here rather than in `builder.ts` for the file-size budget (#3507
 * reconciliation): the class keeps one-line wrappers, the same shape every
 * other op family already uses (`builder-geometry.ts`, `builder-colour.ts`,
 * `builder-metadata.ts`).
 *
 * The orientation helper takes the builder's own terminals as callbacks
 * rather than importing `builder.ts`, which would be a cycle. Integrity
 * reads the original input directly and uses the read-only native transport.
 */
import { type BuilderState } from './builder-state';
import type { ExportFormat, ExportResult, ImageMetadata, IntegrityResult } from './types';
/**
 * Fully decode the original input without applying edits or encoding an
 * output. A truncated payload may retain valid metadata, so the header
 * alone cannot prove integrity. Failures keep their read/decode reason.
 */
export declare function validateIntegrity(state: BuilderState): Promise<IntegrityResult>;
/**
 * Rewrite `state.inputPath` with its EXIF Orientation applied to the pixels
 * and the tag reset, via a temp file and an atomic rename.
 *
 * `develop` is the builder's own `rotate().format(f).toFile(out)` chain,
 * passed in for the cycle reason in the module doc. An orientation of
 * `undefined` or `1` is already normal and returns early — `undefined` is
 * every AVIF, whose container transform the decoder has already baked into
 * the pixels (#3507).
 */
export declare function normalizeOrientationInPlace(state: BuilderState, metadata: () => Promise<ImageMetadata>, develop: (format: ExportFormat, outputPath: string) => Promise<ExportResult>): Promise<boolean>;
/**
 * The bitmap (non-RAW-develop) half of `toFile`: run the recipe pipeline and
 * write the bytes, reporting every failure as `{ ok: false, error }` rather
 * than throwing — which is how `toFile` reports the RAW-develop branch's
 * failures too.
 */
export declare function bitmapToFile(state: BuilderState, outputPath: string): Promise<ExportResult>;
