/**
 * Filesystem helpers shared by the backup routes. Kept out of the route files
 * so they stay under the file-size budget (CONTRIBUTING.md § "File-size
 * budget") and so the move/compare/disambiguate logic is unit-testable on its
 * own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Move src to dst atomically. Falls back to copy+unlink on EXDEV (cross-device). */
export async function atomicMove(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (e: any) {
    if (e?.code === 'EXDEV') {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } else {
      throw e;
    }
  }
}

/** True when both files exist and hold byte-identical content. Compares size
 * first (cheap), then streams a chunked byte comparison so we never hold a
 * whole RAW in memory. Any IO error other than a plain size mismatch
 * propagates — we must not silently treat an unreadable file as "different"
 * and then clobber it. */
export async function filesIdentical(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  if (sa.size === 0) return true;
  const fha = await fs.open(a, 'r');
  try {
    const fhb = await fs.open(b, 'r');
    try {
      const CHUNK = 64 * 1024;
      const bufA = Buffer.allocUnsafe(CHUNK);
      const bufB = Buffer.allocUnsafe(CHUNK);
      let pos = 0;
      while (pos < sa.size) {
        const [ra, rb] = await Promise.all([
          fha.read(bufA, 0, CHUNK, pos),
          fhb.read(bufB, 0, CHUNK, pos),
        ]);
        if (ra.bytesRead !== rb.bytesRead) return false; // truncated under us
        if (ra.bytesRead === 0) break;
        if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) {
          return false;
        }
        pos += ra.bytesRead;
      }
      return true;
    } finally {
      await fhb.close();
    }
  } finally {
    await fha.close();
  }
}

/** Find the first free destination for `relPath` under `libRoot` by inserting
 * a `-1`, `-2`, … suffix before the extension. Used when a genuinely different
 * asset already occupies the computed path (two photos that share a capture
 * date + filename and resolve to the same — or, on a cold geocode cache, no —
 * location). Returns the POSIX-separated rel path plus its absolute path. Caps
 * attempts so a pathological directory can't spin forever. */
export async function firstFreeSiblingPath(
  libRoot: string,
  relPath: string,
): Promise<{ relPath: string; absPath: string }> {
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const stem = path.posix.basename(relPath, ext);
  for (let i = 1; i <= 9999; i++) {
    const candidateName = `${stem}-${i}${ext}`;
    const candidateRel = dir === '.' ? candidateName : `${dir}/${candidateName}`;
    const candidateAbs = path.join(libRoot, ...candidateRel.split('/'));
    try {
      await fs.stat(candidateAbs);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { relPath: candidateRel, absPath: candidateAbs };
      throw e;
    }
  }
  throw new Error(`could not find a free destination for ${relPath} after 9999 attempts`);
}
