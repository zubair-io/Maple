/**
 * EXIF extraction from image/RAW files.
 *
 * Uses raw-ffi when available for RAW files.
 * Falls back to reading basic metadata from the filesystem for other formats.
 *
 * Extracted metadata is stored in the asset MongoDB document.
 */

import * as path from "node:path";
import { assetsCollection } from "../db/client.ts";

/**
 * Extract EXIF-like metadata from a file and store it in the asset document.
 *
 * Phase 1 implementation: reads XMP sidecar for rating/flag/label.
 * Phase 2 TODO: integrate exifr or similar library for full EXIF.
 */
export async function extractAndStoreExif(
  _assetId: string,
  absPath: string
): Promise<void> {
  const { readXmp } = await import("../fs/xmp.ts");

  const result = await readXmp(absPath);
  if (!result.ok) {
    // No sidecar — nothing to extract, leave defaults.
    return;
  }

  const xml = result.data!;

  // Parse rating from XMP (xmp:Rating or xmp:StarRating).
  const ratingMatch = xml.match(/xmp:Rating\s*=\s*["'](\d+)["']/);
  const rating = ratingMatch ? Math.min(5, Math.max(0, Number(ratingMatch[1]))) : 0;

  // Parse Maple flag.
  const flagMatch = xml.match(/maple:Flag\s*=\s*["'](-?\d+)["']/);
  const rawFlag = flagMatch ? Number(flagMatch[1]) : 0;
  const flag = (rawFlag === 1 ? 1 : rawFlag === -1 ? -1 : 0) as -1 | 0 | 1;

  // Parse Maple color label.
  const labelMatch = xml.match(/maple:ColorLabel\s*=\s*["']([^"']*)["']/);
  const color_label = labelMatch ? labelMatch[1] : "";

  const coll = await assetsCollection();
  await coll.updateOne(
    { abs_path: absPath },
    { $set: { rating, flag, color_label } }
  );

  console.log(`[exif] extracted metadata for ${path.basename(absPath)}`);
}
