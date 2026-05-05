/**
 * XMP sidecar read/write and .maple/ thumbnail cache management.
 *
 * Atomic writes: write to .tmp file, then rename (POSIX rename is atomic).
 * .maple/ directories are created lazily under each library folder.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { safeWriteAllowed } from "./root.ts";
import type { OpResult } from "./root.ts";

/**
 * First 16 hex chars of sha256(text) — the cache-key stem used for
 * `.maple/thumbs/<key>.jpg`. Matches the web (Hosted) maple-cache
 * convention at `src/web/.../maple-cache/sha.ts` so thumbs written by
 * the API are readable by the browser-FS-Access cache (and vice versa
 * once Apple migrates to a filename-keyed hash too).
 */
export function sha256Prefix16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

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
 * Convention (aligned with the desktop apps + web Hosted variant):
 *   <folder>/.maple/thumbs/<sha256_prefix16(basename)>.jpg
 *
 * - Single thumb per RAW file (one file → one cache entry, no per-size
 *   variants). Re-rendering at a different render-target size overwrites
 *   the same on-disk file. Stale-check is mtime-based (raw mtime ≥ thumb
 *   mtime). Matches `MapleCacheService` on web and `ThumbnailDiskCache`
 *   on Apple.
 * - Hash input is the basename (filename with extension) so `.maple/`
 *   travels with the photos: copy the folder elsewhere and the same
 *   thumb hash still resolves. Hashing the absolute path would make
 *   the cache non-portable.
 */
export function resolveThumbPath(rawAbsPath: string): string {
  const folder = path.dirname(rawAbsPath);
  const basename = path.basename(rawAbsPath);
  const key = sha256Prefix16(basename);
  return path.join(folder, ".maple", "thumbs", `${key}.jpg`);
}

/** Cache kind: derived thumbnail, or full-size rendered preview. */
export type CacheKind = "thumbs" | "previews";

/**
 * Resolve the on-disk cache path for an asset's derived artefact.
 *
 * Thumbs use the unified per-file convention from `resolveThumbPath`.
 * Previews stay size-keyed because a single asset can have many rendered
 * outputs (different export sizes / edit versions); each needs its own file.
 *
 *   thumbs:   <folder>/.maple/thumbs/<sha256_prefix16(basename)>.jpg
 *   previews: <folder>/.maple/previews/<basename_no_ext>_<size>.jpg
 *
 * Used by the GC sweep to unlink orphaned files after a soft-deleted asset's
 * retention window elapses, and after a rename to clear stale artefacts at
 * the previous path.
 */
export function cachePathFor(
  assetAbsPath: string,
  kind: CacheKind,
  size?: string
): string {
  if (kind === "thumbs") {
    return resolveThumbPath(assetAbsPath);
  }
  const folder = path.dirname(assetAbsPath);
  const base = path.basename(assetAbsPath, path.extname(assetAbsPath));
  const s = size ?? "full";
  return path.join(folder, ".maple", "previews", `${base}_${s}.jpg`);
}

/**
 * Write a thumbnail buffer to the .maple/ cache (atomic).
 * Creates the directory if needed.
 */
export async function writeThumb(
  rawAbsPath: string,
  jpegBytes: Buffer | Uint8Array
): Promise<OpResult> {
  const thumbPath = resolveThumbPath(rawAbsPath);
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
