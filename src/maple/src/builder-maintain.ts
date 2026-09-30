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

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { inputBytes, runPipeline } from './builder-exec';
import { formatForPath, isRawPath, stateToOutput, type BuilderState } from './builder-state';
import { callNative } from './worker-pool';
import type { ExportFormat, ExportResult, ImageMetadata, IntegrityResult } from './types';

/**
 * Fully decode the original input without applying edits or encoding an
 * output. A truncated payload may retain valid metadata, so the header
 * alone cannot prove integrity. Failures keep their read/decode reason.
 */
export async function validateIntegrity(state: BuilderState): Promise<IntegrityResult> {
  try {
    if (state.rawInput) {
      const { width, height, channels, data } = state.rawInput;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      ) {
        throw new Error('Invalid raw pixel dimensions: width and height must be positive integers');
      }
      if (![1, 3, 4].includes(channels)) {
        throw new Error(`Invalid raw pixel channels: expected 1, 3 or 4, got ${channels}`);
      }
      const expected = width * height * channels;
      if (!Number.isSafeInteger(expected) || data.byteLength !== expected) {
        throw new Error(
          `Invalid raw pixel length: expected ${expected} bytes, got ${data.byteLength}`,
        );
      }
      return { ok: true };
    }
    const bytes = await inputBytes(state);
    if (bytes.length === 0) {
      throw new Error('Input image is empty');
    }
    const rawExtension =
      state.inputPath && isRawPath(state.inputPath)
        ? path.extname(state.inputPath).slice(1).toLowerCase()
        : undefined;
    const result = await callNative('rasterAnalyzeBuf', [
      bytes,
      JSON.stringify({ v: 1, what: ['integrity'], rawExtension }),
    ]);
    if (!result.ok || !result.json) {
      throw new Error(result.error || 'Image integrity decode failed');
    }
    if (JSON.parse(result.json).integrity !== true) {
      throw new Error('Image integrity decode returned an invalid reply');
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
  try {
    await fs.rename(tempOut, inputPath);
  } catch (error) {
    await fs.unlink(tempOut).catch(() => {});
    throw error;
  }
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
    const out = await runPipeline(state, bytes, stateToOutput(state, formatForPath(outputPath)));
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
