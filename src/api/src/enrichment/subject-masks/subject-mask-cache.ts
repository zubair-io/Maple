/**
 * On-disk cache for subject-mask rasters (#4284, #3300 slice 3).
 *
 * Serves grayscale PNGs at `<cacheDir>/<digest>.png`, matching Apple's
 * `MaskRasterStore` policy and web client expectations.
 * Writes to a temporary file before renaming into place so a kill mid-write
 * never leaves a truncated PNG.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function defaultSubjectMaskCacheDir(): string {
  return process.env.MAPLE_SUBJECT_MASK_CACHE_DIR ?? join(homedir(), '.maple', 'subject-masks');
}

let activeCacheDir: string | null = null;

export function getSubjectMaskCacheDir(): string {
  const dir = activeCacheDir ?? defaultSubjectMaskCacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Test-only setter for cache directory override. */
export function setSubjectMaskCacheDirForTests(dir: string | null): void {
  activeCacheDir = dir;
}

export function isValidDigest(digest: string): boolean {
  return /^[0-9a-f]{16}$/.test(digest);
}

export function cachedRasterPath(digest: string): string {
  return join(getSubjectMaskCacheDir(), `${digest}.png`);
}

export async function readRasterPng(digest: string): Promise<Uint8Array | null> {
  if (!isValidDigest(digest)) return null;
  const path = cachedRasterPath(digest);
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function writeRasterPng(digest: string, pngBytes: Uint8Array): Promise<void> {
  if (!isValidDigest(digest)) {
    throw new Error(`Invalid subject-mask digest: ${digest}`);
  }
  const dir = getSubjectMaskCacheDir();
  const targetPath = cachedRasterPath(digest);
  const tmpPath = join(dir, `.${digest}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, pngBytes);
  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}
