/**
 * XMP sidecar read/write and .maple/ thumbnail cache management.
 *
 * Atomic writes: write to .tmp file, then rename (POSIX rename is atomic).
 * .maple/ directories are created lazily under each library folder.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { safeWriteAllowed } from "./root.ts";
import type { OpResult } from "./root.ts";

/** Resolve the expected XMP sidecar path for a given raw/image file. */
export function xmpSidecarPath(rawAbsPath: string): string {
  const ext = path.extname(rawAbsPath);
  return rawAbsPath.slice(0, -ext.length) + ".xmp";
}

/** Read XMP sidecar. Returns ok:false if the sidecar does not exist. */
export async function readXmp(rawAbsPath: string): Promise<OpResult<string>> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  try {
    const content = await fs.readFile(sidecar, "utf-8");
    return { ok: true, data: content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No XMP sidecar at "${sidecar}": ${msg}` };
  }
}

/**
 * Atomically write (or overwrite) an XMP sidecar.
 *
 * Steps:
 *   1. Check path is under an allowed root.
 *   2. Write to <sidecar>.tmp.
 *   3. fsync the temp file.
 *   4. rename() into place.
 */
export async function writeXmpAtomic(
  rawAbsPath: string,
  xmlContent: string
): Promise<OpResult> {
  const sidecar = xmpSidecarPath(rawAbsPath);
  const tmp = sidecar + ".tmp." + process.pid;

  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  try {
    // Ensure directory exists (it should, but be defensive).
    await fs.mkdir(path.dirname(sidecar), { recursive: true });

    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(xmlContent, "utf-8");
      await fh.datasync();
    } finally {
      await fh.close();
    }

    await fs.rename(tmp, sidecar);
    return { ok: true };
  } catch (err) {
    // Clean up temp file on error.
    try { await fs.unlink(tmp); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `XMP write failed: ${msg}` };
  }
}

/**
 * Ensure a .maple/ directory exists under the folder containing rawAbsPath.
 * Returns the .maple/ path.
 */
export async function ensureMapleDir(folderAbsPath: string): Promise<string> {
  const dir = path.join(folderAbsPath, ".maple");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the thumbnail cache path for a given RAW file.
 *
 * Convention:
 *   <folder>/.maple/thumbs/<filename_no_ext>_<size>.jpg
 */
export function resolveThumbPath(rawAbsPath: string, size: string = "512x512"): string {
  const folder = path.dirname(rawAbsPath);
  const base = path.basename(rawAbsPath, path.extname(rawAbsPath));
  return path.join(folder, ".maple", "thumbs", `${base}_${size}.jpg`);
}

/**
 * Write a thumbnail buffer to the .maple/ cache (atomic).
 * Creates the directory if needed.
 */
export async function writeThumb(
  rawAbsPath: string,
  size: string,
  jpegBytes: Buffer | Uint8Array
): Promise<OpResult> {
  const thumbPath = resolveThumbPath(rawAbsPath, size);
  const thumbDir = path.dirname(thumbPath);

  const allowed = await safeWriteAllowed(thumbPath);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  try {
    await fs.mkdir(thumbDir, { recursive: true });
    const tmp = thumbPath + ".tmp." + process.pid;
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(jpegBytes);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, thumbPath);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Thumb write failed: ${msg}` };
  }
}
