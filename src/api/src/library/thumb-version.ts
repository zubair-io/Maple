import * as path from 'node:path';
import { lstat, readdir, stat } from '../fs/mirrored.ts';
import { errnoCode } from '../fs/errno-code.ts';
import { resolveThumbPath, xmpSidecarPath } from '../fs/xmp.ts';
import { assertDerivativeCacheDirectory } from '../indexer/derivative-cache.ts';

/** A thumbnail is replaced by rename, so a re-render always changes this token; µs keeps two
 * renders inside one millisecond apart. Clients cache a URL carrying it as immutable. */
function thumbVersionToken(thumb: { mtimeMs: number; size: number }): string {
  return `${Math.round(thumb.mtimeMs * 1000).toString(36)}-${thumb.size.toString(36)}`;
}

/** The current thumb file's token, or null when it is missing or empty. */
async function currentThumbVersion(thumbPath: string): Promise<string | null> {
  const thumb = await lstat(thumbPath).catch(() => null);
  return thumb?.isFile() && thumb.size > 0 ? thumbVersionToken(thumb) : null;
}

interface ThumbStat {
  mtimeMs: number;
  size: number;
}

/** Which thumb files a directory may hold. A file system may fold case and Unicode form, so a
 * name is ruled out only when no variant of it was listed. */
export interface ThumbNames {
  mayHold(thumbFilename: string): boolean;
}

const ANY_THUMB: ThumbNames = { mayHold: () => true };
// Upper-casing after lower-casing also folds ß with SS, a ligature with its letters and final
// sigma with sigma, as case-insensitive file systems do.
const folded = (name: string): string =>
  name.normalize('NFD').toLowerCase().toUpperCase().normalize('NFC');

/** The thumbs a listing should check; null when the route would refuse the thumbs folder. A
 * listing of the whole folder reads that folder once: on a network share the read brings every
 * thumb's attributes with it for as long as the share caches them, so the checks that follow
 * cost no round trip each, and a missing thumb costs none at all. A page checks few thumbs of
 * what may be a far larger folder, so it rules nothing out and keeps one check per thumb. */
export async function listedThumbs(
  directory: string,
  wholeFolder: boolean,
): Promise<ThumbNames | null> {
  if (!(await thumbsDirectorySafe(directory))) return null;
  if (!wholeFolder) return ANY_THUMB;
  const thumbsDirectory = path.dirname(resolveThumbPath(path.join(directory, 'probe')));
  const names = await readdir(thumbsDirectory).catch((error: unknown) =>
    errnoCode(error) === 'ENOENT' ? [] : null,
  );
  if (names === null) return ANY_THUMB;
  const listed = new Set(names.map(folded));
  return { mayHold: (thumbFilename) => listed.has(folded(thumbFilename)) };
}

/** The thumb an unindexed or primary-here image is served from (`resolveThumbPath`). Stat it
 * alongside the sidecar read; `freshThumbVersion` decides once both are known. */
export async function listingThumbStat(
  imagePath: string,
  thumbs: ThumbNames = ANY_THUMB,
): Promise<ThumbStat | null> {
  const thumbPath = resolveThumbPath(imagePath);
  if (!thumbs.mayHold(path.basename(thumbPath))) return null;
  const thumb = await lstat(thumbPath).catch(() => null);
  return thumb?.isFile() && thumb.size > 0 ? thumb : null;
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
function thumbsDirectorySafe(directory: string): Promise<boolean> {
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

/** Search pages are already hydrated from SQLite; a stalled network mount must not hold them. */
const PRIMARY_THUMB_VERSION_DEADLINE_MS = 250;

/** For a caller holding only an asset's primary path (search, timeline): the same freshness
 * check the thumb route runs, without its legacy-name adoption, which writes. Best effort: no
 * version when the volume does not answer within the deadline. */
export async function primaryThumbVersion(
  absPath: string,
  directorySafe: (directory: string) => Promise<boolean>,
): Promise<string | null> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), PRIMARY_THUMB_VERSION_DEADLINE_MS);
  });
  try {
    return await Promise.race([checkPrimaryThumbVersion(absPath, directorySafe), expired]);
  } finally {
    clearTimeout(deadline);
  }
}

async function checkPrimaryThumbVersion(
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
