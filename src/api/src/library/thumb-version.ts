import * as path from 'node:path';
import { lstat, stat } from '../fs/mirrored.ts';
import { resolveThumbPath, xmpSidecarPath } from '../fs/xmp.ts';
import { assertDerivativeCacheDirectory } from '../indexer/derivative-cache.ts';

/** A thumbnail is replaced by rename, so a re-render always changes this token; µs keeps two
 * renders inside one millisecond apart. Clients cache a URL carrying it as immutable. */
function thumbVersionToken(stat: { mtimeMs: number; size: number }): string {
  return `${Math.round(stat.mtimeMs * 1000).toString(36)}-${stat.size.toString(36)}`;
}

/** The current thumb file's token, or null when it is missing or empty. */
async function currentThumbVersion(thumbPath: string): Promise<string | null> {
  const stat = await lstat(thumbPath).catch(() => null);
  return stat?.isFile() && stat.size > 0 ? thumbVersionToken(stat) : null;
}

interface ThumbStat {
  mtimeMs: number;
  size: number;
}

/** The thumb an unindexed or primary-here image is served from (`resolveThumbPath`). Stat it
 * alongside the sidecar read; `freshThumbVersion` decides once both are known. */
export async function listingThumbStat(imagePath: string): Promise<ThumbStat | null> {
  const stat = await lstat(resolveThumbPath(imagePath)).catch(() => null);
  return stat?.isFile() && stat.size > 0 ? stat : null;
}

/** Mirrors `isDerivativeCacheFresh`: a version is only offered for a thumb at least as new as
 * both the original and its sidecar, so the route will serve these exact bytes, not re-render. */
export function freshThumbVersion(
  thumb: ThumbStat | null,
  sourceMtimeMs: number,
  sidecarMtimeMs: number,
): string | null {
  return thumb && thumb.mtimeMs >= Math.max(sourceMtimeMs, sidecarMtimeMs)
    ? thumbVersionToken(thumb)
    : null;
}

/** The route refuses a symlinked `.maple` or `thumbs` directory; offer no version there either. */
export function thumbsDirectorySafe(directory: string): Promise<boolean> {
  return assertDerivativeCacheDirectory(resolveThumbPath(path.join(directory, 'probe'))).then(
    () => true,
    () => false,
  );
}

/** Reads the thumb and names its version only when no re-render replaced the file mid-read,
 * which would otherwise pair the old bytes with the new version. */
export async function readVersionedThumb<T>(
  thumbPath: string,
  read: (thumbPath: string) => Promise<T>,
): Promise<{ data: T; version: string | null }> {
  const before = await currentThumbVersion(thumbPath);
  const data = await read(thumbPath);
  const after = await currentThumbVersion(thumbPath);
  return { data, version: before !== null && before === after ? before : null };
}

function statUnlessMissing(file: string) {
  return stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

/** For a caller holding only an asset's primary path (search, timeline): the same freshness
 * check the thumb route runs, without its legacy-name adoption, which writes. */
export async function primaryThumbVersion(
  absPath: string,
  directorySafe: (directory: string) => Promise<boolean>,
): Promise<string | null> {
  try {
    const [safe, thumb, source, sidecar] = await Promise.all([
      directorySafe(path.dirname(absPath)),
      listingThumbStat(absPath),
      statUnlessMissing(absPath),
      statUnlessMissing(xmpSidecarPath(absPath)),
    ]);
    return safe && source?.isFile()
      ? freshThumbVersion(thumb, source.mtimeMs, sidecar?.mtimeMs ?? 0)
      : null;
  } catch {
    return null;
  }
}

/** One `thumbsDirectorySafe` probe per directory for a page of results. */
export function memoizedDirectorySafety(): (directory: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>();
  return (directory) => {
    const cached = known.get(directory) ?? thumbsDirectorySafe(directory);
    known.set(directory, cached);
    return cached;
  };
}
