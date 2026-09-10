/**
 * Image export functions powered by Maple core.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadNativeBinding } from './native';
import type {
  ExportFormat,
  ExportImageOptions,
  ExportRecipe,
  ExportRecipeOptions,
  ExportResult,
  ThumbnailOptions,
} from './types';

function inferFormatFromExt(filePath: string): ExportFormat {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  if (ext === '.png') return 'png';
  return 'jpeg';
}

/**
 * Render and export a single photo with optional XMP adjustments.
 */
export async function exportImage(options: ExportImageOptions): Promise<ExportResult> {
  const native = loadNativeBinding();

  const format = options.format ?? inferFormatFromExt(options.outPath);
  const quality = options.quality ?? 92;
  const colorSpace = options.colorSpace ?? 'srgb';
  const maxLongEdge = options.maxLongEdge ?? 0;

  // Ensure parent directory exists
  const parentDir = path.dirname(options.outPath);
  await fs.mkdir(parentDir, { recursive: true });

  const res = native.exportDevelopedToFile(
    path.resolve(options.rawPath),
    options.xmpPath ? path.resolve(options.xmpPath) : null,
    format,
    quality,
    colorSpace,
    maxLongEdge,
    path.resolve(options.outPath),
  );

  if (!res.ok) {
    return { ok: false, outPath: options.outPath, error: res.error };
  }

  return { ok: true, outPath: options.outPath };
}

/**
 * Render and export an image according to an ExportRecipe JSON contract.
 */
export async function exportRecipe(options: ExportRecipeOptions): Promise<ExportResult> {
  const native = loadNativeBinding();

  const recipeJson =
    typeof options.recipe === 'string' ? options.recipe : JSON.stringify(options.recipe);

  // Read or pass XMP
  let xmpXml = options.xmpXml ?? '';
  if (!xmpXml) {
    // If no xmpXml is passed, try checking if a sibling .xmp exists next to rawPath
    const candidateXmp = options.rawPath.replace(/\.[^.]+$/, '.xmp');
    try {
      xmpXml = await fs.readFile(candidateXmp, 'utf-8');
    } catch {
      xmpXml = '';
    }
  }

  // Ensure output parent directory exists
  const parentDir = path.dirname(options.outPath);
  await fs.mkdir(parentDir, { recursive: true });

  const res = native.exportRecipeToFile(
    path.resolve(options.rawPath),
    xmpXml,
    recipeJson,
    options.filmPath ? path.resolve(options.filmPath) : null,
    path.resolve(options.outPath),
  );

  if (!res.ok) {
    return { ok: false, outPath: options.outPath, error: res.error };
  }

  return { ok: true, outPath: options.outPath };
}

/**
 * Extract embedded RAW preview and encode to AVIF thumbnail.
 */
export async function renderThumbnail(options: ThumbnailOptions): Promise<boolean> {
  const native = loadNativeBinding();
  await fs.mkdir(path.dirname(options.outPath), { recursive: true });
  const res = native.renderThumbnailAvifToFile(
    path.resolve(options.rawPath),
    path.resolve(options.outPath),
    options.maxPx ?? 512,
    options.quality ?? 55,
  );
  if (!res.ok) {
    throw new Error(res.error);
  }
  return true;
}

/**
 * Extract embedded RAW preview and encode to JPEG preview.
 */
export async function renderPreview(options: ThumbnailOptions): Promise<boolean> {
  const native = loadNativeBinding();
  await fs.mkdir(path.dirname(options.outPath), { recursive: true });
  const res = native.renderThumbnailPreviewJpegToFile(
    path.resolve(options.rawPath),
    path.resolve(options.outPath),
    options.maxPx ?? 1280,
    options.quality ?? 85,
  );
  if (!res.ok) {
    throw new Error(res.error);
  }
  return true;
}
