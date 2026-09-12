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
 * Each takes the builder's own terminals as callbacks rather than importing
 * `builder.ts`, which would be a cycle — the same pattern
 * `builder-raw-develop.ts`'s `rawDevelopToBuffer` already uses for `toFile`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inputBytes, runPipeline } from './builder-exec';
import { formatForPath, stateToOutput, type BuilderState } from './builder-state';
import type { ExportFormat, ExportResult, ImageMetadata } from './types';

/**
 * `true` when the input decodes to a real image: non-zero dimensions from
 * the header probe AND a full decode that does not throw. The decode is the
 * point — a truncated `mdat` or a broken bitstream leaves the header intact.
 */
export async function validateIntegrity(
  metadata: () => Promise<ImageMetadata>,
  decode: () => Promise<Buffer>,
): Promise<boolean> {
  try {
    const meta = await metadata();
    if (meta.width <= 0 || meta.height <= 0) {
      return false;
    }
    await decode();
    return true;
  } catch {
    return false;
  }
}

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
export async function normalizeOrientationInPlace(
  state: BuilderState,
  metadata: () => Promise<ImageMetadata>,
  develop: (format: ExportFormat, outputPath: string) => Promise<ExportResult>,
): Promise<boolean> {
  const inputPath = state.inputPath;
  if (!inputPath) {
    throw new Error('normalizeOrientationInPlace requires a file path input');
  }
  const meta = await metadata();
  if ((meta.orientation ?? 1) <= 1) {
    return true;
  }
  const ext = path.extname(inputPath) || '.jpg';
  const tempOut = `${inputPath}.orient_tmp.${Date.now()}.${crypto.randomUUID()}${ext}`;
  const res = await develop(state.format || (meta.format as ExportFormat) || 'jpeg', tempOut);
  if (!res.ok) {
    try {
      await fs.unlink(tempOut);
    } catch {}
    throw new Error(res.error || 'Failed to normalize orientation');
  }
  await fs.rename(tempOut, inputPath);
  return true;
}

/**
 * The bitmap (non-RAW-develop) half of `toFile`: run the recipe pipeline and
 * write the bytes, reporting every failure as `{ ok: false, error }` rather
 * than throwing — which is how `toFile` reports the RAW-develop branch's
 * failures too.
 */
export async function bitmapToFile(state: BuilderState, outputPath: string): Promise<ExportResult> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const bytes = await inputBytes(state);
    const out = runPipeline(state, bytes, stateToOutput(state, formatForPath(outputPath)));
    await fs.writeFile(outputPath, out.buffer);
    return { ok: true, outPath: outputPath };
  } catch (error) {
    return {
      ok: false,
      outPath: outputPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
