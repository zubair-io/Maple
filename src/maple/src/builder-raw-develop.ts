/**
 * RAW-develop terminal path for `MapleImageBuilder` — a recipe- or
 * XMP-driven development of an actual RAW file, as opposed to the bitmap
 * recipe pipeline in `builder-exec.ts`. Split out of `builder.ts` to make
 * room for Tier 2's geometry methods (#3501) and colour ops (#3503) inside
 * the file-size budget.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isRawPath, lastResizeWidth } from './builder-state';
import type { BuilderState } from './builder-state';
import { exportImage, exportRecipe } from './export';
import type { ExportResult } from './types';

/**
 * True when this builder describes a RAW develop rather than a bitmap
 * transform: a recipe, an XMP sidecar, or a RAW file path as input.
 */
export function isRawDevelop(state: BuilderState): boolean {
  return (
    state.inputPath !== null &&
    (state.exportRecipe !== null ||
      state.xmpPath !== null ||
      state.xmpXml !== null ||
      isRawPath(state.inputPath))
  );
}

/** Saved-recipe or XMP-driven RAW development, rendered to a tmp file and read back. */
export async function rawDevelopToBuffer(
  state: BuilderState,
  toFile: (outputPath: string) => Promise<ExportResult>,
): Promise<Buffer> {
  const ext = state.format ? `.${state.format === 'jpeg' ? 'jpg' : state.format}` : '.jpg';
  const tmpFile = path.join(
    os.tmpdir(),
    `maple_buf_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`,
  );
  try {
    const fileRes = await toFile(tmpFile);
    if (!fileRes.ok) {
      throw new Error(fileRes.error || 'Failed to develop RAW to buffer');
    }
    return await fs.readFile(tmpFile);
  } finally {
    try {
      await fs.unlink(tmpFile);
    } catch {}
  }
}

/** Saved-recipe or XMP-driven RAW development, written straight to `outputPath`. */
export async function rawDevelopToFile(
  state: BuilderState,
  outputPath: string,
): Promise<ExportResult> {
  const rawPath = state.inputPath as string;
  if (state.exportRecipe) {
    return exportRecipe({
      rawPath,
      xmpXml: state.xmpXml ?? undefined,
      recipe: state.exportRecipe,
      filmPath: state.filmPath,
      outPath: outputPath,
    });
  }
  return exportImage({
    rawPath,
    xmpPath: state.xmpPath,
    format: state.format ?? undefined,
    quality: state.quality,
    colorSpace: state.colorSpace,
    maxLongEdge: state.maxLongEdge || lastResizeWidth(state),
    outPath: outputPath,
  });
}
